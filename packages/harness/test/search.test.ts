import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { globTool, grepTool, listTool } from "../src/tools/builtin/search";
import type { ToolContext } from "../src/tools/types";

let root: string;
let ctx: ToolContext;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "yodex-search-"));
  ctx = { cwd: root, roots: [root] };
  // A tiny repo with a .gitignore that hides a heavy dir, mirroring the real failure mode.
  await writeFile(join(root, ".gitignore"), ".venv/\n__pycache__/\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "app.py"), "def handler():\n    return TARGET_TOKEN\n");
  await writeFile(join(root, "src", "util.ts"), "export const x = 1; // TARGET_TOKEN\n");
  // Files that MUST be excluded: same token, but inside a gitignored dir.
  await mkdir(join(root, ".venv", "lib"), { recursive: true });
  await writeFile(join(root, ".venv", "lib", "leak.py"), "TARGET_TOKEN\n");
  await mkdir(join(root, "__pycache__"), { recursive: true });
  await writeFile(join(root, "__pycache__", "leak.pyc"), "TARGET_TOKEN\n");
});

afterAll(async () => {
  // best-effort; tmpdir is reclaimed by the OS regardless
  try {
    execFileSync("rm", ["-rf", root]);
  } catch {
    /* ignore */
  }
});

describe("Grep", () => {
  test("finds matches in tracked files as file:line:match", async () => {
    const res = await grepTool.call({ pattern: "TARGET_TOKEN" }, ctx);
    expect(res.isError).toBeFalsy();
    const body = res.content as string;
    expect(body).toContain("src/app.py:2:");
    expect(body).toContain("src/util.ts:1:");
  });

  test("excludes heavy dirs — .gitignore (rg) or the IGNORE list (fallback)", async () => {
    // .venv is gitignored (rg skips it) AND in the JS engine's IGNORE list, so both
    // engines must exclude it. This is the exact pathology that motivated the change.
    const res = await grepTool.call({ pattern: "TARGET_TOKEN" }, ctx);
    const body = res.content as string;
    expect(body).not.toContain(".venv");
    expect(body).not.toContain("__pycache__");
  });

  test("glob scopes the search", async () => {
    // '**/*.ts' = any depth (what the model passes); tinyglobby and rg agree on this.
    const res = await grepTool.call({ pattern: "TARGET_TOKEN", glob: "**/*.ts" }, ctx);
    const body = res.content as string;
    expect(body).toContain("util.ts");
    expect(body).not.toContain("app.py");
  });

  test("no matches → clean message, not an error", async () => {
    const res = await grepTool.call({ pattern: "NOTHING_MATCHES_THIS_XYZZY" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("No matches");
  });

  test("path outside roots is rejected", async () => {
    const res = await grepTool.call({ pattern: "x", path: "/etc" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("outside the allowed directories");
  });
});

describe("Glob", () => {
  test("lists files matching a pattern", async () => {
    const res = await globTool.call({ pattern: "**/*.ts" }, ctx);
    expect(res.isError).toBeFalsy();
    const body = res.content as string;
    expect(body).toContain("src/util.ts");
  });

  test("excludes heavy dirs (.gitignore via rg, IGNORE via fallback)", async () => {
    const res = await globTool.call({ pattern: "**/*.py" }, ctx);
    const body = res.content as string;
    expect(body).toContain("src/app.py");
    expect(body).not.toContain(".venv");
  });

  test("no files → clean message", async () => {
    const res = await globTool.call({ pattern: "**/*.nonexistentext" }, ctx);
    expect(res.content).toBe("No files matched");
  });
});

describe("List", () => {
  test("suffixes directories and hides node_modules/.git", async () => {
    const res = await listTool.call({}, ctx);
    const body = res.content as string;
    expect(body).toContain("src/");
    expect(body).not.toContain(".git\n");
  });
});
