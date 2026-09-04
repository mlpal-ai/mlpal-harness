import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { type Logger, silentLogger } from "../obs/logger";
import type { ToolRegistry } from "../tools/registry";
import { sanitizeJsonSchema, type Tool, type ToolResult } from "../tools/types";
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

  /** authDir persists OAuth tokens per server (e.g. ~/.yodex/mcp-auth). */
  constructor(
    private readonly logger: Logger = silentLogger,
    private readonly authDir?: string,
  ) {}

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
    const prev = this.clientByName.get(name);
    if (prev) {
      this.clientByName.delete(name);
      await prev.close().catch(() => undefined);
    }
    try {
      const wrapped = await this.connectOne(name, config);
      for (const t of wrapped) registry.register(t);
      this.statuses.set(name, { server: name, ok: true, tools: wrapped.length });
      this.logger.info("mcp server connected", { server: name, tools: wrapped.length });
      return wrapped.length;
    } catch (e) {
      this.statuses.set(name, { server: name, ok: false, tools: 0, error: String(e) });
      this.logger.error("mcp server failed", { server: name, error: String(e) });
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
    await client.connect(transport);
    this.clientByName.set(name, client);

    const result = (await client.listTools()) as { tools: RawMcpTool[] };
    return result.tools.map((t) => wrapMcpTool(name, client, t));
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

function wrapMcpTool(server: string, client: Client, def: RawMcpTool): Tool<unknown> {
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
    schema: z.record(z.unknown()) as unknown as Tool<unknown>["schema"],
    jsonSchema: js,
    async call(input): Promise<ToolResult> {
      // Long-running tools (deep research runs 30-60s+) outlive the SDK's 60s default —
      // allow 10 minutes, and reset the clock whenever the server reports progress.
      const res = (await client.callTool(
        { name: def.name, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: 600_000, resetTimeoutOnProgress: true },
      )) as { content?: unknown; isError?: boolean };
      return { content: renderContent(res.content), isError: Boolean(res.isError) };
    },
  };
}
