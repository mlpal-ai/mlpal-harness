import { describe, expect, test } from "bun:test";
import { BackgroundTasks, looksLikePrompt } from "../src/tools/builtin/background";

const settle = async (predicate: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!predicate() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 15));
};

describe("background-task watchers", () => {
  test("looksLikePrompt recognizes interactive prompts, ignores normal output", () => {
    for (const s of ["Continue? [y/N] ", "Overwrite existing file? ", "Password: ", "Are you sure? (yes/no) ", "Press ENTER to continue"]) {
      expect(looksLikePrompt(s)).toBe(true);
    }
    for (const s of ["Compiling module foo", "3 passed, 0 failed", "Listening on http://localhost:3000", "done."]) {
      expect(looksLikePrompt(s)).toBe(false);
    }
  });

  test("drainNotifications reports a finished task once", async () => {
    const bg = new BackgroundTasks();
    const t = bg.start("echo hello-bg", process.cwd());
    await settle(() => t.exitCode !== null);
    const first = bg.drainNotifications();
    expect(first.length).toBe(1);
    expect(first[0]).toContain(t.id);
    expect(first[0]).toContain("finished");
    expect(bg.drainNotifications()).toEqual([]); // one-shot
  });

  test("drainNotifications reports a non-zero exit as failed", async () => {
    const bg = new BackgroundTasks();
    const t = bg.start("exit 3", process.cwd());
    await settle(() => t.exitCode !== null);
    const notes = bg.drainNotifications();
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("failed (exit 3)");
  });

  test("drainNotifications flags a prompt-stalled task (once) via injected clock", async () => {
    const bg = new BackgroundTasks();
    // prints a prompt, then blocks — never exits during the test
    const t = bg.start("printf 'Continue? [y/N] '; sleep 30", process.cwd());
    await settle(() => t.output.includes("Continue?"));
    // no stall yet (fresh output)
    expect(bg.drainNotifications(t.lastOutputAt + 1_000)).toEqual([]);
    // 46s later with no new output + prompt tail => stall
    const stalled = bg.drainNotifications(t.lastOutputAt + 46_000);
    expect(stalled.length).toBe(1);
    expect(stalled[0]).toContain("blocked waiting for input");
    // one-shot
    expect(bg.drainNotifications(t.lastOutputAt + 90_000)).toEqual([]);
    bg.kill(t.id);
  });

  test("a silent (non-prompt) long task is not flagged as stalled", async () => {
    const bg = new BackgroundTasks();
    const t = bg.start("sleep 30", process.cwd());
    await settle(() => true, 50);
    expect(bg.drainNotifications(t.lastOutputAt + 60_000)).toEqual([]); // no prompt tail => no nag
    bg.kill(t.id);
  });
});
