import { describe, expect, test } from "bun:test";
import { EventInbox } from "../src/events/inbox";
import { monitorTool, setMonitorLimit } from "../src/tools/builtin/bash";
import { BackgroundTasks, backgroundTasks } from "../src/tools/builtin/background";
import type { ToolContext } from "../src/tools/types";

const SID = "mon-test-session";
const ctx: ToolContext = { cwd: "/tmp", sessionId: SID };

/** Wait until pred() or timeout; polls fast to keep tests quick. */
function until(pred: () => boolean, ms = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (pred()) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - t0 > ms) {
        clearInterval(t);
        resolve(false);
      }
    }, 20);
  });
}

describe("monitor mode (BackgroundTasks)", () => {
  test("streams output as debounced progress events, then a completion with the tail", async () => {
    const inbox = new EventInbox();
    const reg = new BackgroundTasks();
    reg.attachInbox(inbox, SID);
    const t = reg.start('echo one; sleep 0.5; echo two', "/tmp", SID, { monitor: true });

    // First burst -> a progress event with the early output.
    expect(await until(() => inbox.peek().some((e) => e.kind === "progress"))).toBe(true);
    const progress = inbox.peek().find((e) => e.kind === "progress")!;
    expect(progress.sourceType).toBe("monitor");
    expect(progress.source).toBe(t.id);
    expect(t.id.startsWith("mon")).toBe(true);
    expect(progress.body).toContain("one");

    // Exit -> terminal complete event carrying the final tail.
    expect(await until(() => inbox.peek().some((e) => e.kind === "complete"))).toBe(true);
    const done = inbox.peek().find((e) => e.kind === "complete")!;
    expect(done.body).toContain("two");
    expect(done.sourceType).toBe("monitor");
    reg.detachInbox();
  });

  test("progress events coalesce — a chatty monitor leaves one pending snapshot + the completion", async () => {
    const inbox = new EventInbox();
    const reg = new BackgroundTasks();
    reg.attachInbox(inbox, SID);
    reg.start("for i in 1 2 3 4 5; do echo tick-$i; sleep 0.35; done", "/tmp", SID, { monitor: true });
    expect(await until(() => inbox.peek().some((e) => e.kind === "complete"), 5_000)).toBe(true);
    const events = inbox.drain();
    const progress = events.filter((e) => e.kind === "progress");
    expect(progress.length).toBeLessThanOrEqual(1); // coalesced
    expect(events.filter((e) => e.kind === "complete").length).toBe(1);
    reg.detachInbox();
  });

  test("timeout: sweep kills the monitor and emits ONE error event (close doesn't double-report)", async () => {
    const inbox = new EventInbox();
    const reg = new BackgroundTasks();
    reg.attachInbox(inbox, SID);
    const t = reg.start("sleep 30", "/tmp", SID, { monitor: true, timeoutMs: 50 });
    await new Promise((r) => setTimeout(r, 80));
    (reg as unknown as { sweep: (now?: number) => void }).sweep();
    expect(await until(() => t.exitCode !== null)).toBe(true);
    await new Promise((r) => setTimeout(r, 50)); // let the close handler run
    const events = inbox.drain();
    const errors = events.filter((e) => e.kind === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.body).toContain("timeout");
    reg.detachInbox();
  });
});

describe("Monitor tool", () => {
  test("returns immediately with the monitor id (non-blocking)", async () => {
    const inbox = new EventInbox();
    backgroundTasks.attachInbox(inbox, SID);
    const t0 = Date.now();
    const res = await monitorTool.call({ command: "sleep 2; echo late" }, ctx);
    expect(Date.now() - t0).toBeLessThan(500); // did not wait for the script
    expect(res.isError).toBeFalsy();
    const id = /Started monitor (mon\d+)/.exec(res.content as string)?.[1];
    expect(id).toBeDefined();
    backgroundTasks.kill(id!);
    backgroundTasks.detachInbox();
  });

  test("concurrency cap (configurable): rejects beyond the limit with a Kill hint", async () => {
    // Fresh session id: the cap is per-session, and a killed monitor from another test may
    // not have reaped yet (SIGTERM → close is async).
    const capCtx: ToolContext = { cwd: "/tmp", sessionId: "mon-cap-session" };
    const inbox = new EventInbox();
    backgroundTasks.attachInbox(inbox, capCtx.sessionId!);
    setMonitorLimit(2);
    try {
      const started: string[] = [];
      for (let i = 0; i < 2; i++) {
        const res = await monitorTool.call({ command: "sleep 20" }, capCtx);
        expect(res.isError).toBeFalsy();
        started.push(/Started monitor (mon\d+)/.exec(res.content as string)![1]!);
      }
      const rejected = await monitorTool.call({ command: "sleep 20" }, capCtx);
      expect(rejected.isError).toBe(true);
      expect(rejected.content).toContain("Monitor limit reached (2/2");
      expect(rejected.content).toContain("Kill");
      for (const id of started) backgroundTasks.kill(id);
    } finally {
      setMonitorLimit(8); // restore the default for other tests
      backgroundTasks.detachInbox();
    }
  });
});
