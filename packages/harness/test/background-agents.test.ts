import { describe, expect, test } from "bun:test";
import { BackgroundAgents } from "../src/subagent/background";
import { agentOutputTool, createTaskTool, type SubagentRun } from "../src/subagent/task";
import { killTool } from "../src/tools/builtin/bash";
import type { ToolContext } from "../src/tools/types";

const ctx: ToolContext = { cwd: "/tmp" };

/** A promise you resolve/reject by hand, to drive running→done deterministically. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("BackgroundAgents registry", () => {
  test("start returns immediately as running; result lands on completion and drains once", async () => {
    const bg = new BackgroundAgents();
    const d = deferred<string>();
    const task = bg.start("research routing", () => d.promise);
    expect(task.status).toBe("running");
    expect(bg.drainNotifications()).toEqual([]); // nothing to report while running

    d.resolve("routing lives in router.ts");
    await Promise.resolve(); // let the .then settle
    expect(bg.get(task.id)!.status).toBe("done");

    const notes = bg.drainNotifications();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("finished");
    expect(notes[0]).toContain("routing lives in router.ts");
    expect(bg.drainNotifications()).toEqual([]); // one-shot
  });

  test("a thrown runner becomes a failed task with the error surfaced", async () => {
    const bg = new BackgroundAgents();
    const d = deferred<string>();
    const task = bg.start("bad task", () => d.promise);
    d.reject(new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();
    expect(bg.get(task.id)!.status).toBe("failed");
    expect(bg.drainNotifications()[0]).toContain("boom");
  });

  test("kill cancels a running task, aborts its signal, and reports cancelled", async () => {
    const bg = new BackgroundAgents();
    let aborted = false;
    const d = deferred<string>();
    const task = bg.start("long task", (signal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return d.promise;
    });
    expect(bg.kill(task.id)).toBe(true);
    expect(aborted).toBe(true);
    expect(bg.get(task.id)!.status).toBe("cancelled");
    // a late resolve from the runner must not overwrite the cancelled state
    d.resolve("too late");
    await Promise.resolve();
    expect(bg.get(task.id)!.status).toBe("cancelled");
    expect(bg.drainNotifications()[0]).toContain("cancelled");
    expect(bg.kill(task.id)).toBe(false); // already ended
  });
});

describe("Task(run_in_background) via the tool", () => {
  const okRun =
    (text: string): SubagentRun =>
    async (args) => {
      seen.push(args);
      return { text, sessionId: "child" };
    };
  let seen: { description: string; prompt: string; agent?: string; background?: boolean }[];

  test("returns a task id immediately and runs the child read-only (background flag set)", async () => {
    seen = [];
    const bg = new BackgroundAgents();
    const tool = createTaskTool(okRun("done researching"), [], bg);
    const res = await tool.call(
      { description: "research", prompt: "look into X", run_in_background: true },
      ctx,
    );
    expect(res.content).toContain("Started background agent agent1");
    // the runner was invoked with background:true so the host restricts it to read-only tools
    expect(seen[0]!.background).toBe(true);

    await Promise.resolve();
    expect(bg.get("agent1")!.status).toBe("done");
  });

  test("without run_in_background it blocks and returns the child's text (unchanged path)", async () => {
    seen = [];
    const bg = new BackgroundAgents();
    const tool = createTaskTool(okRun("the answer"), [], bg);
    const res = await tool.call({ description: "q", prompt: "answer this" }, ctx);
    expect(res.content).toBe("the answer");
    expect(seen[0]!.background).toBeUndefined();
    // Foreground children register too (agents panel visibility) — completed and already
    // reported, so nothing is ever delivered twice.
    expect(bg.list()).toHaveLength(1);
    expect(bg.list()[0]!.status).toBe("done");
    expect(bg.list()[0]!.reported).toBe(true);
  });
});

describe("AgentOutput and Kill on background agents", () => {
  test("AgentOutput reports running, then the finished result", async () => {
    const { backgroundAgents } = require("../src/subagent/background");
    const d = deferred<string>();
    const task = backgroundAgents.start("spot check", () => d.promise);

    const running = await agentOutputTool.call({ id: task.id }, ctx);
    expect(running.content).toContain("running");

    d.resolve("all green");
    await Promise.resolve();
    const done = await agentOutputTool.call({ id: task.id }, ctx);
    expect(done.content).toContain("finished");
    expect(done.content).toContain("all green");

    expect((await agentOutputTool.call({ id: "nope" }, ctx)).isError).toBe(true);
  });

  test("Kill cancels a background sub-agent by its id", async () => {
    const { backgroundAgents } = require("../src/subagent/background");
    const d = deferred<string>();
    const task = backgroundAgents.start("cancellable", () => d.promise);
    const res = await killTool.call({ id: task.id }, ctx);
    expect(res.content).toContain("cancelled");
    expect(backgroundAgents.get(task.id).status).toBe("cancelled");
  });
});

describe("steer", () => {
  test("queues guidance for a running child; the runner's drain gets it exactly once", async () => {
    const bg = new BackgroundAgents(0);
    let drained: string[] = [];
    let finish!: () => void;
    const task = bg.start("t", async () => {
      await new Promise<void>((r) => (finish = r));
      return "ok";
    });
    expect(bg.steer(task.id, "focus on the tests")).toBe(true);
    expect(bg.steer(task.id, "and check main.ts")).toBe(true);
    drained = task.steerQueue.splice(0); // what runSubagent's drainSteering does
    expect(drained).toEqual(["focus on the tests", "and check main.ts"]);
    expect(task.steerQueue).toEqual([]); // consumed once
    finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(bg.steer(task.id, "too late")).toBe(false); // finished → no-op
  });

  test("steering a killed or unknown task is a no-op", () => {
    const bg = new BackgroundAgents(0);
    const task = bg.start("t", () => new Promise(() => {}));
    bg.kill(task.id);
    expect(bg.steer(task.id, "x")).toBe(false);
    expect(bg.steer("nope", "x")).toBe(false);
  });

});

describe("foreground tracking", () => {
  test("track() registers a panel-visible record that never double-delivers", () => {
    const bg = new BackgroundAgents(0);
    const task = bg.track("parallel research");
    expect(task.reported).toBe(true); // inline delivery — inbox/drain must skip it
    expect(bg.list().some((t) => t.id === task.id && t.status === "running")).toBe(true);
    expect(bg.steer(task.id, "focus")).toBe(true);
    expect(task.steerQueue).toEqual(["focus"]);
    task.status = "done";
    task.result = "ok";
    expect(bg.drainNotifications?.() ?? []).toEqual([]); // nothing to report
  });

  test("kill wins the race against inline completion", () => {
    const bg = new BackgroundAgents(0);
    const task = bg.track("t");
    expect(bg.kill(task.id)).toBe(true);
    expect(task.status).toBe("cancelled");
    // the tool's guard (status === "running") must then skip the done/failed overwrite
    if (task.status === "running") task.status = "done";
    expect(task.status).toBe("cancelled");
  });
});

describe("parallel foreground fan-out (read_only)", () => {
  const slowRun =
    (ms: number, log: number[]): SubagentRun =>
    async () => {
      log.push(Date.now());
      await new Promise((r) => setTimeout(r, ms));
      return { text: "ok", sessionId: crypto.randomUUID() };
    };

  test("isCallReadOnly: read_only and background calls classify read-only; plain calls don't", () => {
    const tool = createTaskTool(slowRun(0, []), [], new BackgroundAgents());
    expect(tool.isCallReadOnly!({ read_only: true })).toBe(true);
    expect(tool.isCallReadOnly!({ run_in_background: true })).toBe(true);
    expect(tool.isCallReadOnly!({})).toBe(false);
  });

  test("read_only children reach the runner with readOnly set", async () => {
    let seen: { readOnly?: boolean } | undefined;
    const run: SubagentRun = async (args) => {
      seen = args;
      return { text: "ok", sessionId: "s" };
    };
    const tool = createTaskTool(run, [], new BackgroundAgents());
    await tool.call({ description: "d", prompt: "p", read_only: true }, { cwd: "/tmp" });
    expect(seen!.readOnly).toBe(true);
  });

  test("two read_only calls executed concurrently overlap in wall time", async () => {
    // Simulates what the loop's gate now allows: Promise.all over the batch.
    const starts: number[] = [];
    const tool = createTaskTool(slowRun(120, starts), [], new BackgroundAgents());
    const t0 = Date.now();
    await Promise.all([
      tool.call({ description: "a", prompt: "p", read_only: true }, { cwd: "/tmp" }),
      tool.call({ description: "b", prompt: "p", read_only: true }, { cwd: "/tmp" }),
    ]);
    const wall = Date.now() - t0;
    expect(wall).toBeLessThan(220); // serial would be ≥240
    expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThan(60); // both started together
  });
});
