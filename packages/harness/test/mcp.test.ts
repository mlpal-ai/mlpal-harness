import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { McpManager, wrapMcpTool } from "../src/mcp/manager";
import { runTool, ToolRegistry } from "../src/tools/registry";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.mjs");

describe("McpManager", () => {
  test("connects, discovers, registers and calls an MCP tool", async () => {
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      const { connected, tools } = await mcp.connectAll(
        { mock: { command: "node", args: [SERVER] } },
        reg,
      );
      expect(connected).toBe(1);
      expect(tools).toBe(1);

      const tool = reg.get("mcp__mock__greet");
      expect(tool).toBeTruthy();
      // schema sanitized for cross-provider portability
      expect(JSON.stringify(tool!.jsonSchema)).not.toContain("additionalProperties");
      // exposed to the model in the schema list
      expect(reg.schemas().some((s) => s.name === "mcp__mock__greet")).toBe(true);

      const res = await runTool(reg, "mcp__mock__greet", { name: "yodex" }, { cwd: process.cwd() });
      expect(res.content).toContain("Hello, yodex!");
      expect(res.isError).toBe(false);
    } finally {
      await mcp.close();
    }
  }, 15000);

  test("connects servers in parallel: a failing one does not delay or block the others", async () => {
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      const { connected, tools } = await mcp.connectAll(
        {
          a: { command: "node", args: [SERVER] },
          bad: { command: "this-command-does-not-exist-xyz-123" },
          b: { command: "node", args: [SERVER] },
        },
        reg,
      );
      expect(connected).toBe(2);
      expect(tools).toBe(2);
      expect(mcp.status().map((s) => [s.server, s.ok]).sort()).toEqual([["a", true], ["b", true], ["bad", false]]);
    } finally {
      await mcp.close();
    }
  }, 15000);

  test("an HTTP server nobody listens on is isolated, and its status names the URL", async () => {
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      const { connected } = await mcp.connectAll({ memory: { url: "http://127.0.0.1:1/mcp" } }, reg);
      expect(connected).toBe(0);
      const s = mcp.status().find((x) => x.server === "memory")!;
      expect(s.ok).toBe(false);
      expect(s.error).toContain("http://127.0.0.1:1/mcp");
    } finally {
      await mcp.close();
    }
  }, 15000);

  test("every tools/call carries the host's _meta (run id, HOP, origin) for the server to attribute", async () => {
    const seen: unknown[] = [];
    const fake = { callTool: async (params: unknown) => { seen.push(params); return { content: [{ type: "text", text: "ok" }] }; } };
    const tool = wrapMcpTool("memory", fake as unknown as Parameters<typeof wrapMcpTool>[1], { name: "memory_search", inputSchema: { type: "object" } } as Parameters<typeof wrapMcpTool>[2], "http://localhost:8011/mcp", (ctx) => ({ "mlpal/run_id": ctx.sessionId, "mlpal/hop": "infra@0.1.1", "mlpal/origin": "routine:watch" }));
    await tool.call({ q: "x" }, { cwd: process.cwd(), sessionId: "run-42" } as Parameters<typeof tool.call>[1]);
    expect(seen[0]).toMatchObject({ name: "memory_search", arguments: { q: "x" }, _meta: { "mlpal/run_id": "run-42", "mlpal/hop": "infra@0.1.1", "mlpal/origin": "routine:watch" } });
    const bare = wrapMcpTool("memory", fake as unknown as Parameters<typeof wrapMcpTool>[1], { name: "t", inputSchema: { type: "object" } } as Parameters<typeof wrapMcpTool>[2]);
    await bare.call({}, { cwd: process.cwd() } as Parameters<typeof bare.call>[1]);
    expect("_meta" in (seen[1] as object)).toBe(false); // no host meta => nothing added
  });

  test("tools of a named memory server carry the memory tag; other servers' tools do not (E5)", async () => {
    const fake = { callTool: async () => ({ content: [{ type: "text", text: "ok" }] }) };
    const client = fake as unknown as Parameters<typeof wrapMcpTool>[1];
    const def = { name: "memory_write", inputSchema: { type: "object" } } as Parameters<typeof wrapMcpTool>[2];
    const mem = wrapMcpTool("memory", client, def, undefined, undefined, { memory: true });
    expect(mem.memory).toBe(true);
    expect(mem.readOnly).toBe(false); // a write stays a write; the tag is what the modes honour
    const other = wrapMcpTool("gmail", client, { name: "send", inputSchema: { type: "object" } } as Parameters<typeof wrapMcpTool>[2]);
    expect(other.memory).toBeUndefined();
    const mcp = new McpManager();
    mcp.setMemoryServers(["memory"]);
    // an unreachable server proves nothing about the tag; the wrapper test above does. Just the API.
    await mcp.close();
  });

  test("a server that never finishes connecting fails with a named timeout and settles; a sibling's whenSettled is independent", async () => {
    const mcp = new McpManager();
    mcp.connectTimeoutMs = 300;
    const registry = new ToolRegistry();
    // a stdio server that never speaks: `sleep` accepts the spawn and then says nothing
    const t0 = Date.now();
    const n = await mcp.connect("dead", { command: "sleep", args: ["30"] }, registry);
    expect(n).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5000);
    const s = mcp.status().find((x) => x.server === "dead")!;
    expect(s.ok).toBe(false);
    expect(s.error).toContain("connect timed out");
    await mcp.whenSettled("dead"); // resolved, not pending
    await mcp.whenSettled("never-asked"); // resolves at once
    await mcp.close();
  });

  test("callTool on a server that is not connected is a tool error naming the server, never a throw", async () => {
    const mcp = new McpManager();
    mcp.setHiddenServers(["websearch"]);
    expect(mcp.hasTool("websearch", "web_search")).toBe(false);
    const r = await mcp.callTool("websearch", "web_search", { query: "x" }, { cwd: process.cwd() } as Parameters<typeof mcp.callTool>[3]);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('MCP server "websearch" is not connected');
    await mcp.close();
  });

  test("a tool call to a dead server is a TOOL error naming the server and endpoint, never a throw", async () => {
    const dead = { callTool: async () => { throw new Error("Was there a typo in the url or port?"); } };
    const tool = wrapMcpTool("memory", dead as unknown as Parameters<typeof wrapMcpTool>[1], { name: "memory_search", inputSchema: { type: "object" } } as Parameters<typeof wrapMcpTool>[2], "http://localhost:8011/mcp");
    const r = await tool.call({ q: "x" }, { cwd: process.cwd() } as Parameters<typeof tool.call>[1]);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain('MCP server "memory" at http://localhost:8011/mcp');
    expect(String(r.content)).toContain("typo in the url");
  });

  test("isolates a server that fails to start", async () => {
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      const { connected, tools } = await mcp.connectAll(
        { bad: { command: "this-command-does-not-exist-xyz-123" } },
        reg,
      );
      expect(connected).toBe(0);
      expect(tools).toBe(0);
      expect(reg.list()).toHaveLength(0);
    } finally {
      await mcp.close();
    }
  }, 15000);
});

describe("a stdio server's environment (E-W2 E3)", () => {
  const SECRETS = { YODEX_API_KEY: "sk-gateway", YODEX_SERVER_TOKEN: "serve-token", MLPAL_STORE_KEY: "store-key", MLPAL_MCP_KG_TOKEN: "mcp-token", YODEX_WEBSEARCH_KEY: "search-key" };

  /** The environment the child was spawned with: it writes `env` to a file, then never speaks. */
  async function childEnv(env: Record<string, string> | undefined): Promise<Map<string, string>> {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "mcp-env-"));
    const out = join(dir, "env");
    const saved = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, process.env[k]]));
    Object.assign(process.env, SECRETS, { E3_DECLARED_SOURCE: "from-serve" });
    const mcp = new McpManager();
    mcp.connectTimeoutMs = 1500;
    try {
      await mcp.connect("probe", { command: "/bin/sh", args: ["-c", 'env > "$0"; exec sleep 30', out], ...(env ? { env } : {}) }, new ToolRegistry());
      const text = await readFile(out, "utf8");
      return new Map(text.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    } finally {
      await mcp.close();
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      delete process.env.E3_DECLARED_SOURCE;
      await rm(dir, { recursive: true, force: true });
    }
  }

  for (const [label, env] of [["no env", undefined], ["env: {}", {}], ['env: {FOO: "bar"}', { FOO: "bar", FROM: "${E3_DECLARED_SOURCE}", DEF: "${E3_UNSET_VAR:-fallback}" }]] as const) {
    test(`${label}: none of serve's secrets reach the child; the SDK's safe set and the declared values do`, async () => {
      const seen = await childEnv(env as Record<string, string> | undefined);
      for (const k of Object.keys(SECRETS)) expect(seen.has(k)).toBe(false);
      expect(seen.has("E3_DECLARED_SOURCE")).toBe(false);
      expect(seen.get("PATH")).toBe(process.env.PATH);
      if (env && "FOO" in env) expect([seen.get("FOO"), seen.get("FROM"), seen.get("DEF")]).toEqual(["bar", "from-serve", "fallback"]);
    }, 10000);
  }
});
