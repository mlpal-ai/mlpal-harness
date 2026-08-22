import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { bashTool } from "../src/tools/builtin/bash";
import type { ToolContext } from "../src/tools/types";

let root: string;
let ctx: ToolContext;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "yodex-prelude-"));
  ctx = { cwd: root, roots: [root], sessionId: "prelude-test" };
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".venv", "lib"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "src", "app.py"), "NEEDLE in source\n");
  await writeFile(join(root, ".venv", "lib", "dep.py"), "NEEDLE in venv\n");
  await writeFile(join(root, "node_modules", "pkg", "x.js"), "NEEDLE in node_modules\n");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("bash shell prelude (grep default excludes)", () => {
  test("recursive grep skips heavy dirs — the 90s-incident class", async () => {
    const res = await bashTool.call({ command: "grep -rl NEEDLE ." }, ctx);
    expect(res.content).toContain("src/app.py");
    expect(res.content).not.toContain(".venv");
    expect(res.content).not.toContain("node_modules");
  });

  test("escape hatch: `command grep` reaches everything", async () => {
    const res = await bashTool.call({ command: "command grep -rl NEEDLE . | sort" }, ctx);
    expect(res.content).toContain("src/app.py");
    expect(res.content).toContain(".venv/lib/dep.py");
    expect(res.content).toContain("node_modules/pkg/x.js");
  });

  test("an explicit path into an excluded dir still works (excludes match traversal names)", async () => {
    // Searching FROM INSIDE .venv: the dir itself was named by the user, not traversed into.
    const res = await bashTool.call({ command: "cd .venv && grep -rl NEEDLE ." }, ctx);
    expect(res.content).toContain("lib/dep.py");
  });

  test("non-recursive grep, pipes, and exit codes are untouched", async () => {
    const direct = await bashTool.call({ command: "grep NEEDLE src/app.py" }, ctx);
    expect(direct.content).toContain("NEEDLE in source");
    const piped = await bashTool.call({ command: "echo NEEDLE-x | grep -c NEEDLE" }, ctx);
    expect((piped.content as string).trim()).toBe("1");
    // exit 1 on no match is preserved (surfaces as [exit 1], not a crash)
    const none = await bashTool.call({ command: "grep ABSENT-PATTERN src/app.py" }, ctx);
    expect(none.content).toContain("[exit 1]");
  });
});
