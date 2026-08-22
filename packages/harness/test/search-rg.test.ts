import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { globTool, grepTool } from "../src/tools/builtin/search";
import type { ToolContext } from "../src/tools/types";

// Exercises the ripgrep code path (arg construction, exit-code mapping, parsing) WITHOUT a real
// rg: a fake `rg` on PATH emulates ripgrep's contract deterministically. Real rg's .gitignore
// semantics are validated separately (manually verified); here we lock in our integration.
let bin: string;
let root: string;
let argsFile: string;
let savedPath: string | undefined;
let ctx: ToolContext;

beforeAll(async () => {
  bin = await mkdtemp(join(tmpdir(), "yodex-fakerg-"));
  root = await mkdtemp(join(tmpdir(), "yodex-rgroot-"));
  argsFile = join(bin, "args.log");
  ctx = { cwd: root, roots: [root] };
  // Fake rg: log argv, then emulate output/exit by the requested pattern.
  //   --files            -> two paths, exit 0
  //   pattern __none__   -> exit 1 (no matches)
  //   pattern __bad__    -> stderr + exit 2 (e.g. invalid regex)
  //   pattern __many__   -> 250 lines (to exercise truncation)
  //   otherwise          -> one hit, exit 0
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> "${argsFile}"
case "$*" in
  *--files*) printf 'src/b.ts\\nsrc/a.ts\\n'; exit 0;;
  *__none__*) exit 1;;
  *__bad__*) echo "regex parse error: unbalanced" 1>&2; exit 2;;
  *__many__*) i=1; while [ $i -le 250 ]; do echo "f.ts:$i:hit"; i=$((i+1)); done; exit 0;;
  *) printf 'src/a.ts:3:the hit line\\n'; exit 0;;
esac
`;
  const rgPath = join(bin, "rg");
  await writeFile(rgPath, script);
  await chmod(rgPath, 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
});

afterAll(() => {
  process.env.PATH = savedPath;
});

describe("Grep via ripgrep", () => {
  test("parses rg output and passes hardening flags", async () => {
    const res = await grepTool.call({ pattern: "hit" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("src/a.ts:3:the hit line");
    const logged = await readFile(argsFile, "utf8");
    // The flags that make the tool safe on big/non-git trees must actually be sent.
    expect(logged).toContain("--no-require-git");
    expect(logged).toContain("--hidden");
    expect(logged).toContain("--max-columns 500");
    expect(logged).toContain("--regexp hit");
  });

  test("exit 1 → 'No matches', not an error", async () => {
    const res = await grepTool.call({ pattern: "__none__" }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("No matches");
  });

  test("exit 2 → surfaced as an error", async () => {
    const res = await grepTool.call({ pattern: "__bad__" }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("regex parse error");
  });

  test("truncates at the match cap", async () => {
    const res = await grepTool.call({ pattern: "__many__" }, ctx);
    const body = res.content as string;
    expect(body).toContain("[truncated at 200 matches]");
    expect(body.split("\n").length).toBe(201); // 200 + the note
  });

  test("glob is forwarded to rg as -g", async () => {
    await grepTool.call({ pattern: "hit", glob: "**/*.ts" }, ctx);
    const logged = await readFile(argsFile, "utf8");
    expect(logged).toContain("-g **/*.ts");
  });
});

describe("Glob via ripgrep", () => {
  test("lists and sorts rg --files output", async () => {
    const res = await globTool.call({ pattern: "**/*.ts" }, ctx);
    expect(res.content).toBe("src/a.ts\nsrc/b.ts"); // sorted
    const logged = await readFile(argsFile, "utf8");
    expect(logged).toContain("--files");
  });
});
