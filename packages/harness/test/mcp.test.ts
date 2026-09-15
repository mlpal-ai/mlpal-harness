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
