import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CommandHook } from "../src/hooks/engine";
import type { HookContext } from "../src/hooks/types";
import { backgroundTasks } from "../src/tools/builtin/background";
import { bashTool } from "../src/tools/builtin/bash";
import { shellCwd } from "../src/tools/shell-cwd";
import type { ToolContext } from "../src/tools/types";
import { commandVerifier } from "../src/verifiers";

const settle = async (predicate: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!predicate() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 15));
};

let workspace: string;
let project: string;

beforeEach(async () => {
  // realpath: macOS tmpdir is a symlink, and `pwd` prints the real path.
  workspace = await realpath(await mkdtemp(join(tmpdir(), "shell-cwd-")));
  project = join(workspace, "r2check");
  await mkdir(join(project, "src"), { recursive: true });
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("shellCwd", () => {
  test("an existing folder is used as it is, with no note", () => {
    expect(shellCwd(project, [workspace])).toEqual({ cwd: project });
  });

  test("a removed folder falls back to its nearest existing parent inside the roots, with a note", async () => {
    const gone = join(project, "src");
    await rm(project, { recursive: true });
    const where = shellCwd(gone, [project, workspace]);
    expect(where.cwd).toBe(workspace);
    expect(where.note).toBe(`[note: the working folder ${gone} no longer exists; this command ran in ${workspace}]`);
  });

  test("when no parent inside the roots exists, the first existing root is used", async () => {
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "shell-cwd-root-")));
    try {
      await rm(project, { recursive: true });
      expect(shellCwd(project, [project, elsewhere]).cwd).toBe(elsewhere);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  test("without roots, the nearest existing parent anywhere", async () => {
    await rm(project, { recursive: true });
    expect(shellCwd(join(project, "a", "b")).cwd).toBe(workspace);
  });
});

describe("shell tools when the session's folder has been removed", () => {
  const ctxIn = (cwd: string): ToolContext => ({ cwd, roots: [cwd, workspace], sessionId: "shell-cwd-test" });

  test("Bash runs in the nearest existing folder and says so", async () => {
    await rm(project, { recursive: true });
    const res = await bashTool.call({ command: "pwd" }, ctxIn(project));
    expect(res.isError).toBe(false);
    expect(res.content).toContain(`[note: the working folder ${project} no longer exists; this command ran in ${workspace}]`);
    expect(res.content).toContain(`\n${workspace}`);
    // A project folder deleted from the shell itself (the reported case) does not wedge the next command.
    const again = await bashTool.call({ command: "echo still-works" }, ctxIn(project));
    expect(again.content).toContain("still-works");
  });

  test("Bash in an existing folder is unchanged", async () => {
    const res = await bashTool.call({ command: "pwd" }, ctxIn(project));
    expect(res.content).toBe(project);
  });

  test("a background shell starts in the fallback folder, with the note", async () => {
    await rm(project, { recursive: true });
    const res = await bashTool.call({ command: "pwd", run_in_background: true }, ctxIn(project));
    expect(res.content).toContain("no longer exists");
    const id = /background task (bg\d+)/.exec(res.content as string)![1]!;
    const task = backgroundTasks.get(id)!;
    await settle(() => task.exitCode !== null);
    expect(task.exitCode).toBe(0);
    expect(task.output.trim()).toBe(workspace);
  });

  test("a command hook and a command verifier still run", async () => {
    await rm(project, { recursive: true });
    const ctx: HookContext = { sessionId: "s1", agentId: "a1", cwd: project };
    // A hook that fails to spawn is a silent no-op, so the hook reports where it ran.
    const hook = new CommandHook("cwd", ["PreToolUse"], `printf '{"updatedInput":{"cwd":"%s"}}' "$(pwd)"`);
    expect((await hook.run({ event: "PreToolUse", toolName: "Bash", input: {} }, ctx)).updatedInput).toEqual({ cwd: workspace });
    expect(await commandVerifier({ command: "true" }).run({ event: "Stop", numTurns: 1 }, ctx)).toEqual({});
  });
});
