/**
 * A small Language Server Protocol client over stdio: enough of the protocol for the questions
 * a coding agent asks (where is this defined, who uses it, what is it, what is in this file,
 * what is wrong with it) and nothing a text editor needs. One client per server process; the
 * manager decides when to start one.
 *
 * Framing is the LSP base protocol (`Content-Length` headers, JSON body). Every request has a
 * deadline; a server that dies answers every open request with its exit, so a caller never
 * hangs on a crashed process.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type Logger, silentLogger } from "../obs/logger";

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}
export interface LspSymbol {
  name: string;
  kind: number;
  range?: LspRange;
  location?: LspLocation;
  selectionRange?: LspRange;
  children?: LspSymbol[];
  containerName?: string;
}

export interface LspServerSpec {
  command: string;
  args: string[];
  /** LSP languageId values this server serves (e.g. typescript, javascript). */
  languages: string[];
  /** Server-specific initialization options, when the server needs any. */
  initializationOptions?: unknown;
}

export interface LspClientOptions {
  spec: LspServerSpec;
  rootDir: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  logger?: Logger;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const SYMBOL_KINDS: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number", 17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null", 22: "enum member", 23: "struct", 24: "event", 25: "operator", 26: "type parameter",
};

export const uriOf = (path: string): string => pathToFileURL(path).href;
export const pathOf = (uri: string): string => (uri.startsWith("file://") ? decodeURIComponent(new URL(uri).pathname) : uri);

export class LspClient {
  private child: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly openDocs = new Map<string, { version: number; text: string }>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly diagnosticWaiters = new Map<string, ((d: LspDiagnostic[]) => void)[]>();
  private exited: Error | null = null;
  private readonly logger: Logger;
  private ready: Promise<void> | null = null;
  capabilities: Record<string, unknown> = {};

  constructor(private readonly opts: LspClientOptions) {
    this.logger = (opts.logger ?? silentLogger).child({ lsp: opts.spec.command });
  }

  get alive(): boolean {
    return this.child !== null && this.exited === null;
  }

  /** Spawn and initialize. Idempotent; a second call joins the first. */
  start(): Promise<void> {
    if (!this.ready) this.ready = this.boot();
    return this.ready;
  }

  private async boot(): Promise<void> {
    const { spec, rootDir } = this.opts;
    const child = spawn(spec.command, spec.args, { cwd: rootDir, env: this.opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr!.on("data", (chunk: Buffer) => this.logger.debug("lsp stderr", { text: chunk.toString().slice(0, 500) }));
    const onExit = (code: number | null, signal: string | null) => {
      if (this.exited) return;
      this.exited = new Error(`language server ${spec.command} exited (${signal ?? code})`);
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(this.exited);
        this.pending.delete(id);
      }
      this.logger.warn("language server exited", { code, signal });
    };
    child.on("exit", onExit);
    child.on("error", (e) => {
      this.exited = new Error(`language server ${spec.command} could not start: ${e.message}`);
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(this.exited);
        this.pending.delete(id);
      }
    });
    const result = (await this.request("initialize", {
      processId: process.pid,
      rootUri: uriOf(rootDir),
      workspaceFolders: [{ uri: uriOf(rootDir), name: "workspace" }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: false },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: {},
        },
        workspace: { workspaceFolders: true },
      },
      initializationOptions: spec.initializationOptions,
    })) as { capabilities?: Record<string, unknown> };
    this.capabilities = result?.capabilities ?? {};
    this.notify("initialized", {});
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString();
      this.buffer = this.buffer.subarray(start + length);
      try {
        this.onMessage(JSON.parse(body));
      } catch (e) {
        this.logger.warn("lsp message unreadable", { error: String((e as Error)?.message ?? e) });
      }
    }
  }

  private onMessage(msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string; code: number } }): void {
    if (msg.method === undefined && msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.message} (lsp ${msg.error.code})`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const { uri, diagnostics } = msg.params as { uri: string; diagnostics: LspDiagnostic[] };
      this.diagnostics.set(uri, diagnostics);
      for (const w of this.diagnosticWaiters.get(uri) ?? []) w(diagnostics);
      this.diagnosticWaiters.delete(uri);
      return;
    }
    // Server-to-client requests the agent has no answer for are answered empty so the server
    // does not wait on them (configuration, registration, progress tokens).
    if (msg.method !== undefined && msg.id !== undefined) {
      const empty = msg.method === "workspace/configuration" ? ((msg.params as { items?: unknown[] })?.items ?? []).map(() => null) : null;
      this.send({ jsonrpc: "2.0", id: msg.id, result: empty });
    }
  }

  private send(obj: unknown): void {
    if (!this.child?.stdin || this.exited) throw this.exited ?? new Error("language server not started");
    const body = JSON.stringify(obj);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.opts.requestTimeoutMs ?? 15_000} ms`));
      }, this.opts.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Make sure the server has the file's current text. Re-reads from disk on every call so an
   *  edit made since the last question is seen; unchanged text sends nothing. */
  open(path: string, languageId: string): string {
    const uri = uriOf(path);
    const text = readFileSync(path, "utf8");
    const cur = this.openDocs.get(uri);
    if (!cur) {
      this.openDocs.set(uri, { version: 1, text });
      this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: 1, text } });
    } else if (cur.text !== text) {
      cur.version += 1;
      cur.text = text;
      this.notify("textDocument/didChange", { textDocument: { uri, version: cur.version }, contentChanges: [{ text }] });
    }
    return uri;
  }

  async definition(uri: string, position: LspPosition): Promise<LspLocation[]> {
    const r = await this.request("textDocument/definition", { textDocument: { uri }, position });
    return normalizeLocations(r);
  }

  async references(uri: string, position: LspPosition, includeDeclaration = true): Promise<LspLocation[]> {
    const r = await this.request("textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration } });
    return normalizeLocations(r);
  }

  async hover(uri: string, position: LspPosition): Promise<string | null> {
    const r = (await this.request("textDocument/hover", { textDocument: { uri }, position })) as { contents?: unknown } | null;
    if (!r?.contents) return null;
    return hoverText(r.contents);
  }

  async documentSymbols(uri: string): Promise<LspSymbol[]> {
    const r = (await this.request("textDocument/documentSymbol", { textDocument: { uri } })) as LspSymbol[] | null;
    return r ?? [];
  }

  /** Diagnostics the server has published for the file; waits up to `waitMs` for a fresh batch
   *  after an open or change, because servers publish asynchronously. */
  async diagnosticsFor(uri: string, waitMs = 1500): Promise<LspDiagnostic[]> {
    const fresh = await new Promise<LspDiagnostic[] | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), waitMs);
      this.diagnosticWaiters.set(uri, [...(this.diagnosticWaiters.get(uri) ?? []), (d) => (clearTimeout(timer), resolve(d))]);
    });
    return fresh ?? this.diagnostics.get(uri) ?? [];
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    try {
      await Promise.race([this.request("shutdown", null), new Promise((r) => setTimeout(r, 2000))]);
      this.notify("exit", null);
    } catch {
      // the process is going away either way
    }
    setTimeout(() => {
      if (!this.exited) child.kill("SIGKILL");
    }, 1000).unref();
  }
}

function normalizeLocations(r: unknown): LspLocation[] {
  if (!r) return [];
  const arr = Array.isArray(r) ? r : [r];
  return arr.flatMap((x) => {
    const o = x as { uri?: string; range?: LspRange; targetUri?: string; targetSelectionRange?: LspRange; targetRange?: LspRange };
    if (o.uri && o.range) return [{ uri: o.uri, range: o.range }];
    if (o.targetUri) return [{ uri: o.targetUri, range: o.targetSelectionRange ?? o.targetRange ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }];
    return [];
  });
}

function hoverText(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join("\n");
  const o = contents as { value?: string; language?: string };
  if (typeof o.value === "string") return o.language ? `\`\`\`${o.language}\n${o.value}\n\`\`\`` : o.value;
  return "";
}
