import { describe, expect, test } from "bun:test";
import { BackgroundTasks } from "../src/tools/builtin/background";
import { bashTool } from "../src/tools/builtin/bash";
import type { ExecPolicy, ToolContext } from "../src/tools/types";

/** An ExecPolicy that grants each command its own variable and records when the hold is released. */
function leasing(): { exec: ExecPolicy; leased: string[]; released: string[] } {
  const leased: string[] = [];
  const released: string[] = [];
  const base = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const exec: ExecPolicy = {
    wrap: (argv) => argv,
    env: () => base,
    lease: (command) => {
      leased.push(command);
      return { env: { ...base, GRANT: `for:${command.length}` }, release: () => released.push(command) };
    },
  };
  return { exec, leased, released };
}

const until = async (pred: () => boolean, ms = 3_000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await Bun.sleep(20);
  return pred();
};

describe("ExecPolicy.lease: a command's own environment, held for its process's life (D-55)", () => {
  test("Bash runs the command with its lease and releases it when the process exits", async () => {
    const { exec, leased, released } = leasing();
    const ctx: ToolContext = { cwd: "/tmp", sessionId: "lease", exec };
    const res = await bashTool.call({ command: 'echo "grant=$GRANT"' }, ctx);
    expect(res.content).toContain("grant=for:19");
    expect(leased).toEqual(['echo "grant=$GRANT"']);
    expect(await until(() => released.length === 1)).toBe(true);
  });

  test("a failing command releases too", async () => {
    const { exec, released } = leasing();
    await bashTool.call({ command: "exit 3" }, { cwd: "/tmp", sessionId: "lease", exec });
    expect(await until(() => released.length === 1)).toBe(true);
  });

  test("a foreground command adopted past its timeout keeps the lease until it exits", async () => {
    const { exec, released } = leasing();
    const res = await bashTool.call({ command: "sleep 1.5", timeout: 200 }, { cwd: "/tmp", sessionId: "lease", exec });
    expect(String(res.content)).toContain("adopted as background task");
    expect(released).toEqual([]);
    expect(await until(() => released.length === 1, 5_000)).toBe(true);
  });

  test("a background task holds its lease until it exits; without lease the policy's env is used", async () => {
    const { exec, leased, released } = leasing();
    const reg = new BackgroundTasks();
    const t = reg.start('sleep 0.3; echo "g=$GRANT"', "/tmp", "lease", { exec });
    expect(leased).toHaveLength(1);
    expect(released).toEqual([]);
    expect(await until(() => t.exitCode !== null)).toBe(true);
    expect(await until(() => released.length === 1)).toBe(true);
    expect(t.output).toContain("g=for:");

    const plain: ExecPolicy = { wrap: (a) => a, env: () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", GRANT: "none" }) };
    const res = await bashTool.call({ command: 'echo "grant=$GRANT"' }, { cwd: "/tmp", sessionId: "lease", exec: plain });
    expect(res.content).toContain("grant=none");
  });
});
