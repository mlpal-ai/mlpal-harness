import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolResultBlocks } from "@mlpal/harness-protocol";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { type Logger, silentLogger } from "../obs/logger";
import type { ToolRegistry } from "../tools/registry";
import { sanitizeJsonSchema, type Tool, type ToolContext, type ToolResult } from "../tools/types";
import { isLostResponse, lostResponseFetch } from "./lost-response";
import type { DeferredTools } from "../tools/deferred";
import { StoredOAuthProvider } from "./oauth";
import { host } from "../host";

/**
 * MCP integration. Connects external tool servers — local processes (stdio) or hosted
 * services (streamable HTTP) — and merges their tools into the registry as first-class
 * tools (namespaced `mcp__<server>__<tool>`). Per-server failures are isolated. In
 * hosted/multi-tenant mode stdio servers must be sandboxed or disabled (arbitrary process
 * execution) and scoped per tenant. See docs/05 §9.
 */

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Never defer this server's tools (they are always in the model's tool list). */
  alwaysLoad?: boolean;
}

export interface HttpServerConfig {
  url: string;
  /** Wire transport: streamable-HTTP (default) or "sse" for older SSE-only servers. */
  type?: "http" | "sse";
  /** Header values may reference env vars as ${VAR} so secrets stay out of config files. */
  headers?: Record<string, string>;
  /** OAuth 2.0: tokens persisted under the manager's authDir; refreshed silently by the SDK. */
  oauth?: { scope?: string; clientId?: string };
  /** Never defer this server's tools (they are always in the model's tool list). */
  alwaysLoad?: boolean;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

function isHttp(c: McpServerConfig): c is HttpServerConfig {
  return "url" in c;
}

/** Substitute ${VAR} / ${VAR:-default} in a string from the environment (the default form
 *  is what plugin-shipped MCP configs use, e.g. `${PERPLEXITY_TIMEOUT_MS:-600000}`). */
export function expandEnv(value: string): string {
  return value.replace(
    /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi,
    (_m, name: string, fallback: string | undefined) => process.env[name] ?? fallback ?? "",
  );
}

interface RawMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

function renderContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? "");
  return content
    .map((c) => {
      const b = c as { type?: string; text?: string };
      return b.type === "text" ? (b.text ?? "") : `[${b.type ?? "content"}]`;
    })
    .join("\n");
}

/** An MCP result as the model should see it (gap refresh row 15): text-only results stay a
 *  string; a result with an image, a document, or a blob resource becomes rich blocks, so a
 *  screenshot or a PDF a server returns reaches the model instead of a "[image]" placeholder.
 *  Unknown block types stay a placeholder. The store keeps large blocks as blob files. */
export function toToolResultContent(content: unknown): string | ToolResultBlocks {
  if (!Array.isArray(content)) return renderContent(content);
  const blocks: ToolResultBlocks = [];
  let rich = false;
  for (const c of content) {
    const b = c as { type?: string; text?: string; data?: string; mimeType?: string; resource?: { blob?: string; text?: string; mimeType?: string; uri?: string } };
    if (b.type === "text") blocks.push({ type: "text", text: b.text ?? "" });
    else if (b.type === "image" && typeof b.data === "string") {
      rich = true;
      blocks.push({ type: "image", source: { type: "base64", media_type: b.mimeType ?? "image/png", data: b.data } });
    } else if (b.type === "resource" && b.resource) {
      const r = b.resource;
      if (typeof r.blob === "string" && r.mimeType === "application/pdf") {
        rich = true;
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: r.blob } });
      } else if (typeof r.blob === "string" && r.mimeType?.startsWith("image/")) {
        rich = true;
        blocks.push({ type: "image", source: { type: "base64", media_type: r.mimeType, data: r.blob } });
      } else blocks.push({ type: "text", text: typeof r.text === "string" ? r.text : `[resource ${r.uri ?? ""}${r.mimeType ? ` ${r.mimeType}` : ""}]` });
    } else blocks.push({ type: "text", text: `[${b.type ?? "content"}]` });
  }
  return rich ? blocks : blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

/** A server's answer that the token lacks a scope: the tool error names the scope and the fix
 *  instead of a bare 403, and the server's status says it needs reauthorization. */
export function scopeUpgradeOf(error: unknown): string | null {
  const msg = String((error as Error)?.message ?? error ?? "");
  if (!/insufficient_scope|403/i.test(msg)) return null;
  const m = msg.match(/scope="?([^",\s]+(?:\s+[^",\s]+)*)"?/i);
  return m?.[1] ?? "(unspecified)";
}

/** Tool descriptions longer than this are cut: a server that pastes its manual into every
 *  description costs the model thousands of tokens per call (gap refresh row 15). */
export const DEFAULT_MAX_MCP_DESCRIPTION_LENGTH = 2048;

export interface McpServerStatus {
  server: string;
  ok: boolean;
  tools: number;
  error?: string;
  /** The server refused a call for a scope the token lacks: log in again with it. */
  needsReauth?: { scope: string };
}

/** What a server asks the person mid-call (MCP elicitation): the host answers or declines. */
export type ElicitationHandler = (server: string, params: { message: string; mode: "form" | "url"; requestedSchema?: unknown; url?: string }) => Promise<ElicitResult>;

/** Tool-name prefix for a server. Server KEYS may contain characters tool names can't
 *  (pack servers are keyed `plugin:<pack>:<server>`), so the key is sanitized here — the
 *  single place both registration and panel filtering derive the prefix from. */
export function mcpToolPrefix(server: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__`;
}

export class McpManager {
  private readonly clientByName = new Map<string, Client>();
  private readonly statuses = new Map<string, McpServerStatus>();

  /** Host-supplied request metadata attached to EVERY tools/call as JSON-RPC `_meta` (the
   *  calling run's id, the HOP, how the run began). One transport serves the whole process,
   *  main loop and sub-agents alike, so a connect-time header cannot carry the exact run; the
   *  per-request `_meta` can, and MCP reserves it for exactly this. A memory server logs which
   *  ids it served to which run and joins them with run verdicts later (memory v6, E1b). */
  private callMeta: ((ctx: ToolContext) => Record<string, unknown>) | null = null;
  private onElicit: ElicitationHandler | null = null;
  private maxDescriptionLength = DEFAULT_MAX_MCP_DESCRIPTION_LENGTH;
  /** The last config each server connected with, for reconnectAll. */
  private readonly configByName = new Map<string, McpServerConfig>();

  /** Servers whose tools are working-MEMORY tools (memory v6 E5): every tool they expose is
   *  tagged `memory`, so a claim write passes recon and the safety envelope like a read while
   *  the estate stays untouched. The host names them (the `memory` entry of mcpServers). */
  private readonly memoryServers = new Set<string>();

  /** Servers whose tools are NOT registered for the model: a built-in tool fronts them (the
   *  platform web-search server behind WebSearch/Research) and calls them through callTool, so
   *  the model sees one stable tool instead of the server's raw surface. */
  private readonly hiddenServers = new Set<string>();
  private readonly toolsByServer = new Map<string, Map<string, Tool<unknown>>>();
  /** Per-server "connect attempt finished" (ok or not): a caller waits for ITS server, never for
   *  every server — a stdio server that never comes up (npx under a stripped env) used to block
   *  every other server's tool calls behind connectAll. */
  private readonly settled = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Bound on one server's connect (transport + initialize + listTools). A hung server fails
   *  with a named reason instead of holding the session. */
  connectTimeoutMs = 45_000;

  /** authDir persists OAuth tokens per server (e.g. ~/.yodex/mcp-auth). */
  constructor(
    private readonly logger: Logger = silentLogger,
    private readonly authDir?: string,
  ) {}

  /** Name the servers whose tools carry the `memory` tag. Call before connectAll. */
  setMemoryServers(names: Iterable<string>): void {
    this.memoryServers.clear();
    for (const n of names) this.memoryServers.add(n);
  }

  /** Name the servers a built-in fronts: connected, callable via callTool, never registered. */
  setHiddenServers(names: Iterable<string>): void {
    this.hiddenServers.clear();
    for (const n of names) this.hiddenServers.add(n);
  }

  /** Resolves when `server`'s connect attempt has finished, whichever way (a server never asked
   *  to connect resolves at once). */
  whenSettled(server: string): Promise<void> {
    return this.settled.get(server)?.promise ?? Promise.resolve();
  }

  private markPending(server: string): void {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    this.settled.set(server, { promise, resolve });
  }

  /** True once `server` connected and exposes `tool`. */
  hasTool(server: string, tool: string): boolean {
    return this.toolsByServer.get(server)?.has(tool) ?? false;
  }

  /** Call one tool of a connected server directly (same wrapper as a registered tool: `_meta`,
   *  timeouts, dead-server errors). A server that is not connected is a tool error, not a throw. */
  async callTool(server: string, tool: string, input: unknown, ctx: ToolContext, opts: { timeoutMs?: number } = {}): Promise<ToolResult> {
    const t = this.toolsByServer.get(server)?.get(tool);
    if (!t) {
      const s = this.statuses.get(server);
      return { content: `MCP server "${server}" ${s?.ok ? `has no tool "${tool}"` : `is not connected${s?.error ? `: ${s.error}` : ""}`}`, isError: true };
    }
    if (!opts.timeoutMs) return t.call(input, ctx);
    // A caller that knows how long its call should take bounds it below the wrapper's 10-minute
    // ceiling (a quick web search that never returns is a failure, not a long job).
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        t.call(input, ctx),
        new Promise<ToolResult>((resolve) => {
          timer = setTimeout(() => resolve({ content: `MCP server "${server}" tool "${tool}" did not answer within ${Math.round(opts.timeoutMs! / 1000)}s`, isError: true }), opts.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The host's answer to a server's elicitation request; without one every request is declined. */
  setElicitationHandler(fn: ElicitationHandler | null): void {
    this.onElicit = fn;
  }

  setMaxDescriptionLength(n: number): void {
    this.maxDescriptionLength = Math.max(64, n);
  }

  /** Reconnect every server this manager has connected, with the config it last used. */
  async reconnectAll(registries: ToolRegistry[]): Promise<McpServerStatus[]> {
    const names = [...this.configByName.keys()];
    for (const name of names) {
      const config = this.configByName.get(name)!;
      await this.disconnect(name, registries);
      this.markPending(name);
      await this.connect(name, config, registries[0]!).catch(() => undefined);
    }
    return names.map((n) => this.statuses.get(n) ?? { server: n, ok: false, tools: 0, error: "not connected" });
  }

  setCallMeta(fn: ((ctx: ToolContext) => Record<string, unknown>) | null): void {
    this.callMeta = fn;
  }

  /** Per-server connection outcomes (for /mcp, /doctor and diagnostics). One entry per
   *  server — a reconnect replaces the previous outcome. */
  status(): McpServerStatus[] {
    return [...this.statuses.values()];
  }

  /** Connect every configured server and register its tools. Returns counts; per-server
   *  errors are logged and skipped so one bad server can't break startup. Servers connect in
   *  PARALLEL: a host's bounded wait before the first turn is then bounded by the slowest server,
   *  not the sum — a cold `npx` server queued behind others used to miss a one-shot run's only turn. */
  async connectAll(
    servers: Record<string, McpServerConfig>,
    registry: ToolRegistry,
  ): Promise<{ connected: number; tools: number }> {
    for (const name of Object.keys(servers)) this.markPending(name);
    const counts = await Promise.all(
      Object.entries(servers).map(([name, config]) => this.connect(name, config, registry)),
    );
    const tools = counts.reduce((a, b) => a + b, 0);
    return { connected: this.status().filter((s) => s.ok).length, tools };
  }

  /** (Re)connect one server: closes any previous client for the name, so a failed server
   *  can be retried from /mcp without restarting. Returns the tool count (0 on failure —
   *  the outcome lands in status()). */
  async connect(name: string, config: McpServerConfig, registry: ToolRegistry): Promise<number> {
    if (!this.settled.has(name)) this.markPending(name);
    try {
      return await this.connectInner(name, config, registry);
    } finally {
      this.settled.get(name)?.resolve();
    }
  }

  private async connectInner(name: string, config: McpServerConfig, registry: ToolRegistry): Promise<number> {
    this.configByName.set(name, config);
    const prev = this.clientByName.get(name);
    if (prev) {
      this.clientByName.delete(name);
      await prev.close().catch(() => undefined);
    }
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wrapped = await Promise.race([
        this.connectOne(name, config),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`connect timed out after ${this.connectTimeoutMs / 1000}s (the server never finished starting)`)), this.connectTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      this.toolsByServer.set(name, new Map(wrapped.map((t) => [t.name.slice(mcpToolPrefix(name).length), t])));
      if (!this.hiddenServers.has(name)) {
        // Deferral is decided per server as it connects, from its own tools; the registry
        // keeps the tools callable while the model sees them only once loaded.
        const defer = Boolean(this.deferral && !config.alwaysLoad && this.deferral.policy(name, wrapped));
        for (const t of wrapped) {
          registry.register(t);
          if (defer) this.deferral!.tools.defer(t.name, name);
        }
        if (defer) this.logger.info("mcp server tools deferred", { server: name, tools: wrapped.length });
      }
      this.statuses.set(name, { server: name, ok: true, tools: wrapped.length });
      this.logger.info("mcp server connected", { server: name, tools: wrapped.length });
      return wrapped.length;
    } catch (e) {
      const error = `${mcpEndpoint(config)}: ${String((e as Error)?.message ?? e)}`;
      this.statuses.set(name, { server: name, ok: false, tools: 0, error });
      this.logger.error("mcp server failed", { server: name, endpoint: mcpEndpoint(config), error: String(e) });
      return 0;
    }
  }

  private async connectOne(name: string, config: McpServerConfig): Promise<Tool<unknown>[]> {
    let transport;
    if (isHttp(config)) {
      const requestInit = config.headers
        ? {
            headers: Object.fromEntries(
              Object.entries(config.headers).map(([k, v]) => [k, expandEnv(v)]),
            ),
          }
        : undefined;
      // OAuth: a persisted token provider (non-interactive here; `yodex mcp login` seeds it).
      const authProvider =
        config.oauth && this.authDir
          ? new StoredOAuthProvider({
              dir: this.authDir,
              server: name,
              scope: config.oauth.scope,
              clientId: config.oauth.clientId,
            })
          : undefined;
      const url = new URL(config.url);
      if (config.type === "sse") {
        transport = new SSEClientTransport(url, { requestInit, authProvider });
      } else {
        // A response the server never wrote (stream closed by a pod recycle or a wake) is
        // delivered as a JSON-RPC error so the request rejects now; see lost-response.ts.
        const http: StreamableHTTPClientTransport = new StreamableHTTPClientTransport(url, {
          requestInit,
          authProvider,
          fetch: lostResponseFetch((message) => http.onmessage?.(message)),
        });
        transport = http;
      }
    } else {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: config.env
          ? {
              ...(process.env as Record<string, string>),
              ...Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, expandEnv(v)])),
            }
          : undefined,
      });
    }
    const client = new Client({ name: host().name, version: "0.0.1" }, { capabilities: { elicitation: {} } });
    // Elicitation (gap refresh row 15): a server may ask the person for a value mid-call. The host
    // answers through its own question path; with no handler, or headless, the request is declined
    // and the server carries on, never a hang.
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      if (!this.onElicit) return { action: "decline" };
      try {
        const p = req.params as { message: string; requestedSchema?: unknown; url?: string; mode?: string };
        return await this.onElicit(name, { message: p.message, mode: p.mode === "url" ? "url" : "form", ...(p.requestedSchema !== undefined ? { requestedSchema: p.requestedSchema } : {}), ...(typeof p.url === "string" ? { url: p.url } : {}) });
      } catch (e) {
        this.logger.warn("elicitation handler failed; declined", { server: name, error: String((e as Error)?.message ?? e) });
        return { action: "decline" };
      }
    });
    // Transport/protocol errors after connect (a server that dies mid-run, a failed SSE
    // reconnect) are reported here instead of being dropped or escaping as an unhandled
    // rejection: the status flips to not-ok with the endpoint named, and the run goes on.
    client.onerror = (error) => {
      this.statuses.set(name, { server: name, ok: false, tools: 0, error: `${mcpEndpoint(config)}: ${String(error?.message ?? error)}` });
      this.logger.warn("mcp server error (kept running)", { server: name, endpoint: mcpEndpoint(config), error: String(error?.message ?? error) });
    };
    await client.connect(transport);
    this.clientByName.set(name, client);

    const result = (await client.listTools()) as { tools: RawMcpTool[] };
    return result.tools.map((t) =>
      wrapMcpTool(name, client, t, mcpEndpoint(config), (ctx) => this.callMeta?.(ctx) ?? null, {
        memory: this.memoryServers.has(name),
        maxDescriptionLength: this.maxDescriptionLength,
        onScopeUpgrade: (scope) => {
          const cur = this.statuses.get(name);
          this.statuses.set(name, { server: name, ok: cur?.ok ?? true, tools: cur?.tools ?? 0, error: `needs reauthorization: scope ${scope}`, needsReauth: { scope } });
        },
      }),
    );
  }

  /** Disconnect one server and remove its tools from the given registries (pack removal). */
  async disconnect(name: string, registries: ToolRegistry[]): Promise<void> {
    const client = this.clientByName.get(name);
    this.clientByName.delete(name);
    this.statuses.delete(name);
    await client?.close().catch(() => undefined);
    const prefix = mcpToolPrefix(name);
    for (const registry of registries) {
      for (const t of registry.list()) {
        if (!t.name.startsWith(prefix)) continue;
        registry.unregister(t.name);
        this.deferral?.tools.forget(t.name);
      }
    }
  }

  private deferral?: { tools: DeferredTools; policy: (server: string, tools: Tool<unknown>[]) => boolean };

  /** Tool deferral: `policy` decides per connecting server (given its wrapped tools) whether
   *  the model sees them only after ToolSearch; `tools` is the process's deferral ledger.
   *  A server config with `alwaysLoad` is never deferred. */
  setDeferral(tools: DeferredTools, policy: (server: string, tools: Tool<unknown>[]) => boolean): void {
    this.deferral = { tools, policy };
  }

  async close(): Promise<void> {
    await Promise.all([...this.clientByName.values()].map((c) => c.close().catch(() => undefined)));
    this.clientByName.clear();
  }
}

/** Where a server lives, for error messages: its URL, or the command that starts it. */
export function mcpEndpoint(config: McpServerConfig): string {
  return isHttp(config) ? config.url : [config.command, ...(config.args ?? [])].join(" ");
}

export function wrapMcpTool(
  server: string,
  client: Client,
  def: RawMcpTool,
  endpoint?: string,
  meta?: (ctx: ToolContext) => Record<string, unknown> | null,
  opts: { memory?: boolean; maxDescriptionLength?: number; onScopeUpgrade?: (scope: string) => void } = {},
): Tool<unknown> {
  const cap = opts.maxDescriptionLength ?? DEFAULT_MAX_MCP_DESCRIPTION_LENGTH;
  const rawDescription = def.description ?? `${def.name} (via ${server} MCP server)`;
  const description = rawDescription.length > cap ? `${rawDescription.slice(0, cap)}… [description cut at ${cap} characters]` : rawDescription;
  const js = (
    def.inputSchema ? structuredClone(def.inputSchema) : { type: "object", properties: {} }
  ) as Record<string, unknown>;
  sanitizeJsonSchema(js);

  return {
    name: `${mcpToolPrefix(server)}${def.name}`,
    description,
    // Honor the server's readOnlyHint (e.g. web search); otherwise assume mutating so the
    // permission layer gates it.
    readOnly: def.annotations?.readOnlyHint === true,
    ...(opts.memory ? { memory: true } : {}),
    schema: z.record(z.unknown()) as unknown as Tool<unknown>["schema"],
    jsonSchema: js,
    async call(input, ctx): Promise<ToolResult> {
      // Long-running tools (deep research runs 30-60s+) outlive the SDK's 60s default —
      // allow 10 minutes, and reset the clock whenever the server reports progress.
      const _meta = meta?.(ctx) ?? null;
      const call = async () =>
        (await client.callTool(
          { name: def.name, arguments: (input ?? {}) as Record<string, unknown>, ...(_meta ? { _meta } : {}) },
          undefined,
          { timeout: 600_000, resetTimeoutOnProgress: true },
        )) as { content?: unknown; isError?: boolean };
      try {
        let res: { content?: unknown; isError?: boolean };
        try {
          res = await call();
        } catch (e) {
          // A hosted server that woke or was recycled mid-call closed the stream before answering.
          // It is up now; one retry is cheap and, for a read-only tool, harmless. Anything that
          // fails the second time surfaces as the tool error below.
          if (!isLostResponse(e)) throw e;
          res = await call();
        }
        return { content: toToolResultContent(res.content), isError: Boolean(res.isError) };
      } catch (e) {
        const scope = scopeUpgradeOf(e);
        if (scope) {
          opts.onScopeUpgrade?.(scope);
          return { content: `MCP server "${server}" refused "${def.name}": the token lacks the scope ${scope}. Log in to the server again to grant it (the host's mcp login), then retry.`, isError: true };
        }
        // A dead or unreachable server is a TOOL error the model can route around, never a run
        // terminator: 13 routine firings died with Bun's bare "Was there a typo in the url or
        // port?" while the memory stack was down. Name the server and where it lives.
        return {
          content: `MCP server "${server}"${endpoint ? ` at ${endpoint}` : ""} is unreachable or failed: ${String((e as Error)?.message ?? e)}`,
          isError: true,
        };
      }
    },
  };
}
