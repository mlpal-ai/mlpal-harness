import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { McpManager } from "../src/mcp/manager";
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
