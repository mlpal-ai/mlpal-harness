import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_UNREADABLE, resolveSandboxSpec } from "../src/sandbox";
import { editTool, readTool, writeTool } from "../src/tools/builtin/files";
import { globTool, grepTool, listTool } from "../src/tools/builtin/search";
import { runTool, ToolRegistry } from "../src/tools/registry";

/**
 * R51: what cannot see the person's stored header secrets (`~/.yodex/person-secrets.json`) and MCP sign-ins
 * (`~/.yodex/mcp-auth/`). In a workspace the engine's roots are the workspace directory, beside the home, never the
 * home itself: every model file tool resolves a path through symlinks and refuses one outside the roots. A sandboxed
 * command meets the same files on the engine's unreadable list. Each test would fail if the file could be read.
 */

const MARK = "R51-MARKED-SECRET-7f3a9c";
let base: string;
let home: string;
let work: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "r51-"));
  home = join(base, "home");
  work = join(home, "workspace");
  mkdirSync(join(home, ".yodex", "mcp-auth"), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(home, ".yodex", "person-secrets.json"), JSON.stringify({ version: 1, secrets: { K: { value: MARK } } }), { mode: 0o600 });
  writeFileSync(join(home, ".yodex", "mcp-auth", "linear.json"), JSON.stringify({ tokens: { access_token: MARK } }), { mode: 0o600 });
  writeFileSync(join(work, "notes.md"), "ordinary file\n");
  symlinkSync(join(home, ".yodex", "person-secrets.json"), join(work, "secrets-link.json"));
  symlinkSync(join(home, ".yodex"), join(work, "yodex-link"));
  symlinkSync(join(home, ".yodex", "mcp-auth"), join(work, "auth-link"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of [readTool, writeTool, editTool, globTool, grepTool, listTool]) reg.register(t as never);
  return reg;
}
const ctx = () => ({ cwd: work, roots: [work] });
const text = (r: { content: unknown }) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));

describe("R51: the model's file tools cannot reach the stored secrets", () => {
  const targets = () => [
    join(home, ".yodex", "person-secrets.json"),
    "~/.yodex/person-secrets.json",
    "../.yodex/person-secrets.json",
    "secrets-link.json",
    "yodex-link/person-secrets.json",
    join(home, ".yodex", "mcp-auth", "linear.json"),
    "../.yodex/mcp-auth/linear.json",
    "auth-link/linear.json",
  ];

  test("Read refuses every way of naming them: absolute, ~, relative and through a symlink in the workspace", async () => {
    const reg = registry();
    for (const path of targets()) {
      const r = await runTool(reg, "Read", { path }, ctx());
      expect(text(r)).not.toContain(MARK);
      expect(r.isError).toBe(true);
    }
  });

  test("Edit and Write cannot overwrite or read them back", async () => {
    const reg = registry();
    for (const path of targets()) {
      const e = await runTool(reg, "Edit", { path, old_string: MARK, new_string: "x" }, ctx());
      expect(e.isError).toBe(true);
      expect(text(e)).not.toContain(MARK);
      const w = await runTool(reg, "Write", { path, content: "overwritten" }, ctx());
      expect(w.isError).toBe(true);
    }
    expect(readFileSync(join(home, ".yodex", "person-secrets.json"), "utf8")).toContain(MARK);
    expect(readFileSync(join(home, ".yodex", "mcp-auth", "linear.json"), "utf8")).toContain(MARK);
  });

  test("Grep over the workspace (links included), Glob and List never return a stored value", async () => {
    const reg = registry();
    for (const input of [{ pattern: MARK }, { pattern: MARK, path: "yodex-link" }, { pattern: MARK, path: "auth-link" }, { pattern: MARK, path: "secrets-link.json" }, { pattern: MARK, path: join(home, ".yodex") }]) {
      expect(text(await runTool(reg, "Grep", input, ctx()))).not.toContain(MARK);
    }
    for (const input of [{ pattern: "**/*.json" }, { pattern: "**/*", path: "yodex-link" }, { pattern: "*", path: join(home, ".yodex") }]) {
      const out = text(await runTool(reg, "Glob", input, ctx()));
      expect(out).not.toContain(MARK);
      expect(out).not.toContain("linear.json");
    }
    const listed = await runTool(reg, "List", { path: "yodex-link" }, ctx());
    expect(listed.isError).toBe(true);
    expect(text(listed)).not.toContain("person-secrets.json");
    expect(text(await runTool(reg, "List", {}, ctx()))).toContain("notes.md");
    // The ordinary file is still found: the filter takes out only what resolves outside.
    expect(text(await runTool(reg, "Grep", { pattern: "ordinary" }, ctx()))).toContain("notes.md:1:ordinary file");
  });
});

describe("R51: a sandboxed command cannot read them", () => {
  test("both are on the engine's unreadable list, resolved under the home", () => {
    expect(DEFAULT_UNREADABLE).toContain("~/.yodex/person-secrets.json");
    expect(DEFAULT_UNREADABLE).toContain("~/.yodex/mcp-auth");
    const spec = resolveSandboxSpec(undefined, { roots: [work], home, realHome: home, tmpDir: join(base, "tmp") } as never);
    expect(spec.filesystem.unreadable).toContain(join(home, ".yodex", "person-secrets.json"));
    expect(spec.filesystem.unreadable).toContain(join(home, ".yodex", "mcp-auth"));
  });
});
