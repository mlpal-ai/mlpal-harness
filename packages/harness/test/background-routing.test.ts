import { describe, expect, test } from "bun:test";
import { EventInbox } from "../src/events/inbox";
import { BackgroundAgents } from "../src/subagent/background";
import { createTaskTool, type SubagentRun } from "../src/subagent/task";
import { BackgroundTasks } from "../src/tools/builtin/background";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

describe("background agents route to their owning session's inbox", () => {
  test("two served sessions each receive only their own child's completion; a session without an inbox keeps the pull path", async () => {
    const bg = new BackgroundAgents(0);
    const a = new EventInbox();
    const b = new EventInbox();
    bg.attachInbox(a, "sess-a");
    bg.attachInbox(b, "sess-b");
    const da = deferred<string>();
    const db = deferred<string>();
    const dc = deferred<string>();
    bg.start("a's child", () => da.promise, { ownerSessionId: "sess-a" });
    bg.start("b's child", () => db.promise, { ownerSessionId: "sess-b" });
    const orphan = bg.start("c's child", () => dc.promise, { ownerSessionId: "sess-c" });
    da.resolve("a done");
    db.resolve("b done");
    dc.resolve("c done");
    await Promise.resolve();
    await Promise.resolve();
    expect(a.drain().map((e) => [e.label, e.kind])).toEqual([["a's child", "complete"]]);
    expect(b.drain().map((e) => [e.label, e.kind])).toEqual([["b's child", "complete"]]);
    // No inbox for sess-c and no default: its completion waits for the pull path, scoped.
    expect(bg.drainNotifications("sess-a")).toEqual([]);
    const c = bg.drainNotifications("sess-c");
    expect(c).toHaveLength(1);
    expect(c[0]).toContain("c done");
    expect(bg.get(orphan.id)!.reported).toBe(true);
  });

  test("a default inbox (the CLI's main loop) takes tasks with no owner; detaching one session leaves the others", async () => {
    const bg = new BackgroundAgents(0);
    const main = new EventInbox();
    const served = new EventInbox();
    bg.attachInbox(main);
    bg.attachInbox(served, "sess-s");
    const d1 = deferred<string>();
    const d2 = deferred<string>();
    bg.start("ownerless", () => d1.promise);
    bg.start("served", () => d2.promise, { ownerSessionId: "sess-s" });
    bg.detachInbox("sess-s");
    d1.resolve("x");
    d2.resolve("y");
    await Promise.resolve();
    await Promise.resolve();
    expect(main.drain().map((e) => e.label)).toEqual(["ownerless", "served"]); // the detached owner falls back to the default
    expect(served.size()).toBe(0);
  });

  test("the Agent tool stamps the calling session as the owner on both paths", async () => {
    const bg = new BackgroundAgents(0);
    const run: SubagentRun = async () => ({ text: "r", sessionId: "child" });
    const tool = createTaskTool(run, [], bg);
    await tool.call({ description: "fg", prompt: "p" }, { cwd: "/tmp", sessionId: "owner-1" });
    await tool.call({ description: "bg", prompt: "p", run_in_background: true }, { cwd: "/tmp", sessionId: "owner-2" });
    expect(bg.list().map((t) => [t.description, t.ownerSessionId])).toEqual([
      ["fg", "owner-1"],
      ["bg", "owner-2"],
    ]);
  });
});

describe("background shells route to their owning session's inbox", () => {
  test("exit events reach the inbox of the task's session, with several sessions attached", async () => {
    const tasks = new BackgroundTasks();
    const a = new EventInbox();
    const b = new EventInbox();
    tasks.attachInbox(a, "sess-a");
    tasks.attachInbox(b, "sess-b");
    try {
      tasks.start("echo from-a", "/tmp", "sess-a");
      tasks.start("echo from-b", "/tmp", "sess-b");
      const deadline = Date.now() + 5_000;
      while ((a.size() < 1 || b.size() < 1) && Date.now() < deadline) await Bun.sleep(20);
      expect(a.drain().map((e) => [e.kind, e.label])).toEqual([["complete", "echo from-a"]]);
      expect(b.drain().map((e) => [e.kind, e.label])).toEqual([["complete", "echo from-b"]]);
      // Pull path stays for a session nobody attached.
      tasks.start("echo from-c", "/tmp", "sess-c");
      await Bun.sleep(200);
      expect(tasks.drainNotifications().some((n) => n.includes("echo from-c"))).toBe(true);
      tasks.detachInbox("sess-a");
      tasks.detachInbox();
    } finally {
      tasks.killAll?.();
    }
  });
});
