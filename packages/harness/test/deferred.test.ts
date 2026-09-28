import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { McpManager } from "../src/mcp/manager";
import { createToolSearchTool } from "../src/tools/builtin/toolsearch";
import { DeferredTools, schemaTokens } from "../src/tools/deferred";
import { runTool, ToolRegistry } from "../src/tools/registry";
import { defineTool } from "../src/tools/types";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.mjs");

const mk = (name: string, description: string) =>
  defineTool({ name, description, readOnly: true, schema: z.object({ q: z.string().optional() }), call: async () => ({ content: `${name} ran` }) });

describe("tool deferral", () => {
  test("a deferred tool is hidden from schemas, refused until loaded, and shown after ToolSearch", async () => {
    const reg = new ToolRegistry();
    const deferred = new DeferredTools();
    reg.setSchemaFilter(deferred.visible);
    reg.register(mk("Read", "read a file"));
    reg.register(mk("mcp__gmail__send_email", "send an email through Gmail"));
    reg.register(mk("mcp__gmail__search_threads", "search Gmail threads"));
    reg.register(createToolSearchTool(deferred, reg));
    deferred.defer("mcp__gmail__send_email", "gmail");
    deferred.defer("mcp__gmail__search_threads", "gmail");

    expect(reg.schemas().map((s) => s.name).sort()).toEqual(["Read", "ToolSearch"]);
    const refused = await runTool(reg, "mcp__gmail__send_email", {}, { cwd: "/" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('ToolSearch (query "select:mcp__gmail__send_email")');
    // the description names the deferred server and its tools
    expect(reg.schemas().find((s) => s.name === "ToolSearch")!.description).toContain("gmail: 2 tools (search_threads, send_email)");

    // "gmail send" must not load search_threads on the strength of the server name alone
    const found = await runTool(reg, "ToolSearch", { query: "gmail send" }, { cwd: "/" });
    expect(found.isError).toBeFalsy();
    expect(found.content).toContain("Loaded 1 tool");
    expect(found.content).toContain('"name":"mcp__gmail__send_email"');
    expect(reg.schemas().map((s) => s.name).sort()).toEqual(["Read", "ToolSearch", "mcp__gmail__send_email"]);
    expect((await runTool(reg, "mcp__gmail__send_email", {}, { cwd: "/" })).content).toBe("mcp__gmail__send_email ran");
    // the remaining deferred tool is still listed; a filtered view keeps the same visibility
    expect(reg.schemas().find((s) => s.name === "ToolSearch")!.description).toContain("gmail: 1 tools (search_threads)");
    const sub = reg.filter((t) => t.readOnly);
    expect(sub.schemas().map((s) => s.name).sort()).toEqual(["Read", "ToolSearch", "mcp__gmail__send_email"]);

    const exact = await runTool(reg, "ToolSearch", { query: "select:mcp__gmail__search_threads,mcp__nope__x" }, { cwd: "/" });
    expect(exact.content).toContain("Loaded 1 tool");
    expect(deferred.pending()).toEqual([]);
    expect(reg.schemas().find((s) => s.name === "ToolSearch")!.description).toContain("No deferred tools remain");
    const none = await runTool(reg, "ToolSearch", { query: "zzz" }, { cwd: "/" });
    expect(none.isError).toBe(true);
  });

  test("ranking: a server name restricts the search, weak matches are cut at half the best score", async () => {
    const reg = new ToolRegistry();
    const deferred = new DeferredTools();
    reg.setSchemaFilter(deferred.visible);
    for (const [n, d] of [
      ["mcp__gmail__search_emails", "Searches for emails using Gmail search syntax"],
      ["mcp__gmail__send_email", "Sends a new email"],
      ["mcp__memory__memory_search", "Search memory for passages"],
    ] as const) {
      reg.register(mk(n, d));
      deferred.defer(n, n.split("__")[1]!);
    }
    reg.register(createToolSearchTool(deferred, reg));
    const r = await runTool(reg, "ToolSearch", { query: "gmail search threads", max_results: 3 }, { cwd: "/" });
    expect(r.content).toContain("Loaded 1 tool");
    expect(r.content).toContain("mcp__gmail__search_emails");
    expect(deferred.isLoaded("mcp__memory__memory_search")).toBe(false);
    expect(deferred.isLoaded("mcp__gmail__send_email")).toBe(false);
    const all = await runTool(reg, "ToolSearch", { query: "memory" }, { cwd: "/" });
    expect(all.content).toContain("Loaded 1 tool");
    expect(deferred.isLoaded("mcp__memory__memory_search")).toBe(true);
  });

  test("schemaTokens estimates the per-call cost of a tool set", () => {
    const small = schemaTokens([mk("A", "a")]);
    const big = schemaTokens(Array.from({ length: 30 }, (_, i) => mk(`mcp__big__tool_${i}`, "x".repeat(200))));
    expect(small).toBeGreaterThan(0);
    expect(big).toBeGreaterThan(small * 20);
  });

  test("the manager defers a connecting server by policy, never one marked alwaysLoad, and forgets on disconnect", async () => {
    const reg = new ToolRegistry();
    const deferred = new DeferredTools();
    reg.setSchemaFilter(deferred.visible);
    const mcp = new McpManager();
    mcp.setDeferral(deferred, (server) => server !== "keep");
    try {
      await mcp.connectAll({ mock: { command: "node", args: [SERVER] }, keep: { command: "node", args: [SERVER] }, pinned: { command: "node", args: [SERVER], alwaysLoad: true } }, reg);
      expect(reg.list().map((t) => t.name).sort()).toEqual(["mcp__keep__greet", "mcp__mock__greet", "mcp__pinned__greet"]);
      expect(reg.schemas().map((s) => s.name).sort()).toEqual(["mcp__keep__greet", "mcp__pinned__greet"]);
      expect(deferred.pending()).toEqual([{ server: "mock", names: ["mcp__mock__greet"] }]);
      await mcp.disconnect("mock", [reg]);
      expect(deferred.pending()).toEqual([]);
      expect(deferred.size).toBe(0);
    } finally {
      await mcp.close();
    }
  }, 20_000);
});
