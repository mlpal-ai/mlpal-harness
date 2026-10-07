import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspClient, uriOf } from "../src/lsp/client";
import { languageOf, LspManager, projectRootOf } from "../src/lsp/manager";
import { createLspTool, positionOfSymbol, renderSymbols } from "../src/tools/builtin/lsp";

const SERVER = join(import.meta.dir, "fixtures", "fake-lsp-server.mjs");
let root: string;
let file: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "yodex-lsp-"));
  mkdirSync(join(root, "pkg", "src"), { recursive: true });
  writeFileSync(join(root, "pkg", "package.json"), "{}");
  file = join(root, "pkg", "src", "thing.ts");
  writeFileSync(file, "class Thing {\n  run() {\n  }\n}\nconst t = new Thing();\nt.run();\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fakeManager = () => new LspManager({ servers: { typescript: { command: "node", args: [SERVER] } }, which: () => true });

describe("lsp: client", () => {
  test("initializes, opens a file once and re-sends it only when it changed, answers the five questions, survives a server request, and closes", async () => {
    const c = new LspClient({ spec: { command: "node", args: [SERVER], languages: ["typescript"] }, rootDir: root });
    await c.start();
    expect(c.capabilities).toMatchObject({ hoverProvider: true });
    const uri = c.open(file, "typescript");
    expect(uri).toBe(uriOf(file));
    expect(await c.diagnosticsFor(uri)).toEqual([expect.objectContaining({ severity: 2, code: "FAKE1", message: expect.stringContaining("opened with") })]);
    expect(c.open(file, "typescript")).toBe(uri); // unchanged: no didChange, diagnostics unchanged
    expect((await c.diagnosticsFor(uri, 100))[0]!.code).toBe("FAKE1");
    writeFileSync(file, "class Thing {\n  run() {\n  }\n}\nconst t = new Thing();\nt.run();\n// changed\n");
    c.open(file, "typescript");
    expect((await c.diagnosticsFor(uri))[0]!.message).toBe("changed to version 2");
    expect(await c.definition(uri, { line: 4, character: 14 })).toEqual([{ uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } }]);
    expect((await c.references(uri, { line: 5, character: 2 })).length).toBe(2);
    expect(await c.hover(uri, { line: 5, character: 2 })).toBe("symbol at 5:2");
    expect(renderSymbols(await c.documentSymbols(uri))).toEqual(["class Thing:1", "  method run:2"]);
    await expect(c.request("textDocument/nonsense", {})).rejects.toThrow("unknown method");
    await c.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(c.alive).toBe(false);
    await expect(c.definition(uri, { line: 0, character: 0 })).rejects.toThrow("exited");
  });

  test("a request times out instead of hanging; a server that cannot spawn is an error, not a hang", async () => {
    const slow = new LspClient({ spec: { command: "node", args: ["-e", "setInterval(()=>{},1000)"], languages: ["x"] }, rootDir: root, requestTimeoutMs: 150 });
    await expect(slow.start()).rejects.toThrow("timed out");
    await slow.close();
    const missing = new LspClient({ spec: { command: "/nonexistent/lsp-binary", args: [], languages: ["x"] }, rootDir: root, requestTimeoutMs: 2000 });
    await expect(missing.start()).rejects.toThrow(/could not start|exited/);
  });
});

describe("lsp: manager and tool", () => {
  test("languages by extension, the project root by marker, one client per server and root, and a missing binary names its install", async () => {
    expect(languageOf("a.tsx")).toBe("typescriptreact");
    expect(languageOf("a.py")).toBe("python");
    expect(languageOf("a.txt")).toBeNull();
    expect(projectRootOf(file, root)).toBe(join(root, "pkg"));
    expect(projectRootOf(join(root, "loose.ts"), root)).toBe(root);
    const m = fakeManager();
    const a = await m.clientFor(file, root);
    const b = await m.clientFor(join(root, "pkg", "src", "other.ts"), root);
    expect(a.ok && b.ok && a.client === b.client).toBe(true);
    expect(m.status()).toEqual([{ command: "node", rootDir: join(root, "pkg"), alive: true }]);
    const none = await m.clientFor(join(root, "x.rb"), root);
    expect(none).toEqual({ ok: false, reason: "no language server is configured for .rb" });
    const notInstalled = new LspManager({ which: () => false });
    expect(await notInstalled.clientFor(file, root)).toEqual({ ok: false, reason: "typescript-language-server is not installed (install: npm i -g typescript-language-server typescript)" });
    await m.closeAll();
    expect(m.status()).toEqual([]);
  });

  test("the tool: a symbol names the position, rows read like grep output, each action renders, and the boundary and missing-symbol cases are errors", async () => {
    const m = fakeManager();
    const tool = createLspTool(m);
    const ctx = { cwd: root };
    expect(tool.readOnly).toBe(true);
    expect(tool.description).toContain("typescript");
    expect(positionOfSymbol("const t = new Thing();\nt.run();", "t")).toEqual({ line: 0, character: 6 });
    expect(positionOfSymbol("const t = new Thing();\nt.run();", "t", 1)).toEqual({ line: 1, character: 0 });
    expect(positionOfSymbol("const tt = 1", "t")).toBeNull();
    const def = await tool.call({ action: "definition", path: "pkg/src/thing.ts", symbol: "Thing", line: 5 }, ctx);
    expect(def.content).toBe("pkg/src/thing.ts:1:1  class Thing {");
    const refs = await tool.call({ action: "references", path: "pkg/src/thing.ts", line: 6, column: 1 }, ctx);
    expect(String(refs.content)).toStartWith("2 references\npkg/src/thing.ts:1:1  class Thing {\npkg/src/thing.ts:6:1  t.run();");
    expect((await tool.call({ action: "hover", path: "pkg/src/thing.ts", symbol: "run", line: 6 }, ctx)).content).toBe("symbol at 5:2");
    expect((await tool.call({ action: "symbols", path: "pkg/src/thing.ts" }, ctx)).content).toBe("class Thing:1\n  method run:2");
    expect(String((await tool.call({ action: "diagnostics", path: "pkg/src/thing.ts" }, ctx)).content)).toMatch(/^pkg\/src\/thing\.ts:\d+:\d+  (warning FAKE1|error): /);
    expect(await tool.call({ action: "hover", path: "pkg/src/thing.ts", symbol: "nope" }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining('"nope" does not occur') });
    expect(await tool.call({ action: "hover", path: "pkg/src/thing.ts" }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("need `symbol`") });
    expect(await tool.call({ action: "symbols", path: "/etc/hosts" }, ctx)).toMatchObject({ isError: true, meta: { refused: "outside_roots" } });
    expect(await tool.call({ action: "symbols", path: "notes.md" }, ctx)).toMatchObject({ isError: true, content: "Lsp: no language server is configured for .md" });
    await m.closeAll();
  });
});
