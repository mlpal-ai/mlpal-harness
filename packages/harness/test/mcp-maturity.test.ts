import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { McpManager, scopeUpgradeOf, toToolResultContent } from "../src/mcp/manager";
import { runTool, ToolRegistry } from "../src/tools/registry";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.mjs");
const ctx = { cwd: process.cwd() };

describe("MCP maturity (gap refresh row 15)", () => {
  test("an image in a result reaches the model as a block; text-only results stay strings; unknown blocks stay placeholders", async () => {
    expect(toToolResultContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(toToolResultContent("plain")).toBe("plain");
    const rich = toToolResultContent([{ type: "text", text: "cap" }, { type: "image", data: "AAAA", mimeType: "image/jpeg" }, { type: "audio", data: "x" }]);
    expect(rich).toEqual([{ type: "text", text: "cap" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }, { type: "text", text: "[audio]" }]);
    const pdf = toToolResultContent([{ type: "resource", resource: { uri: "file:///r.pdf", mimeType: "application/pdf", blob: "JVBERi0=" } }]);
    expect(pdf).toEqual([{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }]);
    expect(toToolResultContent([{ type: "resource", resource: { uri: "mem://x", text: "hello" } }])).toBe("hello");
  });

  test("against the mock server: a picture tool returns blocks, a long description is cut, a scope refusal names the scope and flags the server", async () => {
    const mcp = new McpManager();
    const registry = new ToolRegistry();
    await mcp.connect("mock", { command: "node", args: [SERVER], env: { MOCK_MCP_EXTRAS: "1" } }, registry);
    const pic = await runTool(registry, "mcp__mock__picture", {}, ctx);
    expect(Array.isArray(pic.content)).toBe(true);
    const blocks = pic.content as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "image"]);
    const long = registry.get("mcp__mock__long")!;
    expect(long.description.length).toBeLessThan(2200);
    expect(long.description).toContain("[description cut at 2048 characters]");
    const scoped = await runTool(registry, "mcp__mock__scoped", {}, ctx);
    expect(scoped.isError).toBe(true);
    expect(String(scoped.content)).toContain("lacks the scope files:write");
    expect(mcp.status().find((st) => st.server === "mock")).toMatchObject({ ok: true, needsReauth: { scope: "files:write" } });
    expect(scopeUpgradeOf(new Error("ECONNREFUSED"))).toBeNull();
    expect(scopeUpgradeOf(new Error('HTTP 403 insufficient_scope scope="a b"'))).toBe("a b");
    await mcp.close();
  });

  test("elicitation: with no handler the request is declined and the call completes; a handler's answer reaches the server; reconnectAll re-registers the tools", async () => {
    const mcp = new McpManager();
    const registry = new ToolRegistry();
    await mcp.connect("mock", { command: "node", args: [SERVER], env: { MOCK_MCP_EXTRAS: "1" } }, registry);
    const declined = await runTool(registry, "mcp__mock__ask", {}, ctx);
    expect(String(declined.content)).toBe("elicited: decline");
    const asked: { server: string; message: string }[] = [];
    mcp.setElicitationHandler(async (server, p) => {
      asked.push({ server, message: p.message });
      return { action: "accept", content: { region: "us-east-2" } };
    });
    const answered = await runTool(registry, "mcp__mock__ask", {}, ctx);
    expect(String(answered.content)).toBe('elicited: accept {"region":"us-east-2"}');
    expect(asked).toEqual([{ server: "mock", message: "Which region?" }]);
    const before = registry.list().filter((t) => t.name.startsWith("mcp__mock__")).length;
    const statuses = await mcp.reconnectAll([registry]);
    expect(statuses).toEqual([expect.objectContaining({ server: "mock", ok: true })]);
    expect(registry.list().filter((t) => t.name.startsWith("mcp__mock__")).length).toBe(before);
    expect(String((await runTool(registry, "mcp__mock__greet", { name: "again" }, ctx)).content)).toBe("Hello, again!");
    await mcp.close();
  });
});
