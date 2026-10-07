/**
 * Which language server answers for a file, and the one live client per server and project
 * root. Servers start on the first question and stay up for the session; a server that is not
 * installed is reported with the command to install it, never silently skipped.
 */
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { type Logger, silentLogger } from "../obs/logger";
import { LspClient, type LspServerSpec } from "./client";

export interface LspServerConfig {
  command: string;
  args?: string[];
  languages?: string[];
  initializationOptions?: unknown;
}

/** Default servers, by the binary's conventional name; `lsp.servers` in settings overrides or
 *  adds by key. `install` is what the tool says when the binary is missing. */
export const DEFAULT_LSP_SERVERS: Record<string, LspServerSpec & { install: string }> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"], languages: ["typescript", "typescriptreact", "javascript", "javascriptreact"], install: "npm i -g typescript-language-server typescript" },
  python: { command: "pyright-langserver", args: ["--stdio"], languages: ["python"], install: "npm i -g pyright" },
  go: { command: "gopls", args: [], languages: ["go"], install: "go install golang.org/x/tools/gopls@latest" },
  rust: { command: "rust-analyzer", args: [], languages: ["rust"], install: "rustup component add rust-analyzer" },
  c: { command: "clangd", args: [], languages: ["c", "cpp", "objective-c"], install: "install clangd from your package manager" },
};

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascriptreact",
  ".py": "python", ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp", ".m": "objective-c",
};

const ROOT_MARKERS = ["tsconfig.json", "package.json", "pyproject.toml", "setup.py", "go.mod", "Cargo.toml", "compile_commands.json", ".git"];

export const languageOf = (path: string): string | null => LANGUAGE_BY_EXT[extname(path).toLowerCase()] ?? null;

/** The nearest ancestor with a project marker, else the cwd: the server's workspace. */
export function projectRootOf(path: string, cwd: string): string {
  let cur = dirname(path);
  for (let guard = 0; guard < 64; guard++) {
    if (ROOT_MARKERS.some((m) => existsSync(join(cur, m)))) return cur;
    const parent = dirname(cur);
    if (parent === cur || cur === cwd) break;
    cur = parent;
  }
  return cwd;
}

export type LspResolution =
  | { ok: true; client: LspClient; languageId: string; rootDir: string }
  | { ok: false; reason: string };

export interface LspManagerOptions {
  servers?: Record<string, LspServerConfig>;
  which?: (command: string) => boolean;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  logger?: Logger;
}

export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  private readonly specs: Record<string, LspServerSpec & { install?: string }>;
  private readonly logger: Logger;
  private readonly which: (command: string) => boolean;

  constructor(private readonly opts: LspManagerOptions = {}) {
    this.logger = opts.logger ?? silentLogger;
    this.which = opts.which ?? ((c) => Bun.which(c) !== null);
    this.specs = { ...DEFAULT_LSP_SERVERS };
    for (const [key, cfg] of Object.entries(opts.servers ?? {})) {
      const base = this.specs[key];
      this.specs[key] = { command: cfg.command, args: cfg.args ?? base?.args ?? [], languages: cfg.languages ?? base?.languages ?? [key], initializationOptions: cfg.initializationOptions ?? base?.initializationOptions, install: base?.install };
    }
  }

  /** Languages with a configured server, for the tool's description. */
  languages(): string[] {
    return [...new Set(Object.values(this.specs).flatMap((s) => s.languages))].sort();
  }

  specFor(languageId: string): (LspServerSpec & { install?: string }) | null {
    return Object.values(this.specs).find((s) => s.languages.includes(languageId)) ?? null;
  }

  async clientFor(path: string, cwd: string): Promise<LspResolution> {
    const languageId = languageOf(path);
    if (!languageId) return { ok: false, reason: `no language server is configured for ${extname(path) || "files without an extension"}` };
    const spec = this.specFor(languageId);
    if (!spec) return { ok: false, reason: `no language server is configured for ${languageId}` };
    const runnable = spec.command.includes("/") ? existsSync(spec.command) : this.which(spec.command);
    if (!runnable) return { ok: false, reason: `${spec.command} is not installed${spec.install ? ` (install: ${spec.install})` : ""}` };
    const rootDir = projectRootOf(path, cwd);
    const key = `${spec.command}\0${rootDir}`;
    let client = this.clients.get(key);
    if (client && !client.alive) {
      this.clients.delete(key);
      client = undefined;
    }
    if (!client) {
      client = new LspClient({ spec, rootDir, env: this.opts.env, requestTimeoutMs: this.opts.requestTimeoutMs, logger: this.logger });
      this.clients.set(key, client);
      this.logger.info("language server starting", { command: spec.command, rootDir });
    }
    try {
      await client.start();
    } catch (e) {
      this.clients.delete(key);
      return { ok: false, reason: `${spec.command} failed to start: ${String((e as Error)?.message ?? e)}` };
    }
    return { ok: true, client, languageId, rootDir };
  }

  status(): { command: string; rootDir: string; alive: boolean }[] {
    return [...this.clients.entries()].map(([key, c]) => {
      const [command, rootDir] = key.split("\0");
      return { command: command!, rootDir: rootDir!, alive: c.alive };
    });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    this.clients.clear();
  }
}
