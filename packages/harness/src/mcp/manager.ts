import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { type Logger, silentLogger } from "../obs/logger";
import type { ToolRegistry } from "../tools/registry";
import { sanitizeJsonSchema, type Tool, type ToolContext, type ToolResult } from "../tools/types";
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
}

export interface HttpServerConfig {
  url: string;
  /** Wire transport: streamable-HTTP (default) or "sse" for older SSE-only servers. */
  type?: "http" | "sse";
  /** Header values may reference env vars as ${VAR} so secrets stay out of config files. */
  headers?: Record<string, string>;
  /** OAuth 2.0: tokens persisted under the manager's authDir; refreshed silently by the SDK. */
  oauth?: { scope?: string; clientId?: string };
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

export interface McpServerStatus {
  server: string;
  ok: boolean;
  tools: number;
  error?: string;
}

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
  async callTool(server: string, tool: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const t = this.toolsByServer.get(server)?.get(tool);
    if (!t) {
      const s = this.statuses.get(server);
      return { content: `MCP server "${server}" ${s?.ok ? `has no tool "${tool}"` : `is not connected${s?.error ? `: ${s.error}` : ""}`}`, isError: true };
    }
    return t.call(input, ctx);
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
      if (!this.hiddenServers.has(name)) for (const t of wrapped) registry.register(t);
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
      transport =
        config.type === "sse"
          ? new SSEClientTransport(url, { requestInit, authProvider })
          : new StreamableHTTPClientTransport(url, { requestInit, authProvider });
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
    const client = new Client({ name: host().name, version: "0.0.1" }, { capabilities: {} });
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
      wrapMcpTool(name, client, t, mcpEndpoint(config), (ctx) => this.callMeta?.(ctx) ?? null, { memory: this.memoryServers.has(name) }),
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
      for (const t of registry.list()) if (t.name.startsWith(prefix)) registry.unregister(t.name);
    }
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
  opts: { memory?: boolean } = {},
): Tool<unknown> {
  const js = (
    def.inputSchema ? structuredClone(def.inputSchema) : { type: "object", properties: {} }
  ) as Record<string, unknown>;
  sanitizeJsonSchema(js);

  return {
    name: `${mcpToolPrefix(server)}${def.name}`,
    description: def.description ?? `${def.name} (via ${server} MCP server)`,
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
      try {
        const res = (await client.callTool(
          { name: def.name, arguments: (input ?? {}) as Record<string, unknown>, ...(_meta ? { _meta } : {}) },
          undefined,
          { timeout: 600_000, resetTimeoutOnProgress: true },
        )) as { content?: unknown; isError?: boolean };
        return { content: renderContent(res.content), isError: Boolean(res.isError) };
      } catch (e) {
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
