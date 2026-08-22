import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineEvent } from "@mlpal/harness-protocol";
import { microcompact } from "../src/context/compaction";
import { type AgentEvent, EVENTS_HEADER, EventInbox } from "../src/events/inbox";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import { AgentSession, type AgentConfig } from "../src/loop/agent";
import { createPolicy, type PermissionMode } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { defaultRegistry } from "../src/tools";
import { BackgroundTasks } from "../src/tools/builtin/background";
import { BackgroundAgents } from "../src/subagent/background";

class ScriptedModel implements ModelClient {
  private i = 0;
  readonly seen: ModelRequest[] = [];
  /** Optional per-call hook, fired before returning the scripted result. */
  onCall?: (callIndex: number) => void;
  constructor(private readonly scripts: ModelResult[]) {}
  async *stream(req: ModelRequest): AsyncGenerator<never, ModelResult, void> {
    this.seen.push(req);
    const i = this.i++;
    this.onCall?.(i);
    const r = this.scripts[i];
    if (!r) throw new GatewayError("script exhausted", 500);
    return r;
  }
}

function toolUse(name: string, input: Record<string, unknown>): ModelResult {
  return {
    model: "test",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `tu_${crypto.randomUUID().slice(0, 6)}`, name, input }],
    },
    usage: { input_tokens: 10, output_tokens: 5 },
    stopReason: "tool_use",
  };
}

function textDone(text: string): ModelResult {
  return {
    model: "test",
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: { input_tokens: 8, output_tokens: 4 },
    stopReason: "end_turn",
  };
}

function ev(over: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    source: "mon1",
    sourceType: "monitor",
    kind: "complete",
    label: "watch build",
    body: "build green",
    ts: 1,
    ...over,
  };
}

let root: string;
let cwd: string;

beforeEach(async () => {
  root = join(tmpdir(), `yodex-inboxloop-${crypto.randomUUID()}`);
  cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function session(model: ModelClient, mode: PermissionMode, extra: Partial<AgentConfig> = {}): AgentSession {
  return new AgentSession({
    agentId: "ag1",
    sessionId: "s1",
    workspace: "w",
    cwd,
    model: "test",
    systemPrompt: "You are a test.",
    tools: defaultRegistry(),
    store: new LocalStore(root),
    model_client: model,
    canUseTool: createPolicy({ mode }),
    ...extra,
  });
}

async function collect(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("inbox × agent loop", () => {
  test("mid-run: events arriving during a tool step fold into the tool-result turn", async () => {
    const inbox = new EventInbox();
    const model = new ScriptedModel([
      toolUse("Bash", { command: "echo working" }),
      textDone("done"),
    ]);
    // Event lands while the first turn is in flight (before its tool result is folded).
    model.onCall = (i) => {
      if (i === 0) inbox.emit(ev({ id: "e1", body: "monitor saw something" }));
    };
    const sess = session(model, "autopilot", { inbox });
    await collect(sess.run({ text: "go" }));

    expect(model.seen.length).toBe(2);
    const secondCall = model.seen[1]!;
    const lastMsg = secondCall.messages.at(-1)!;
    // The events text rides WITH the tool results in the same user turn — no extra message,
    // and the assistant message is never split.
    expect(lastMsg.role).toBe("user");
    const text = JSON.stringify(lastMsg.content);
    expect(text).toContain(EVENTS_HEADER);
    expect(text).toContain("monitor saw something");
    expect(text).toContain("tool_result");
  });

  test("finish-boundary: pending events continue the run as their own turn", async () => {
    const inbox = new EventInbox();
    inbox.emit(ev({ id: "e1", body: "task result: 42" }));
    const model = new ScriptedModel([
      textDone("I think I'm done."),
      textDone("Reacted to the event; now done."),
    ]);
    const sess = session(model, "autopilot", { inbox });
    const events = await collect(sess.run({ text: "go" }));

    expect(model.seen.length).toBe(2); // finish was continued once
    const secondCall = model.seen[1]!;
    const lastMsg = secondCall.messages.at(-1)!;
    expect(lastMsg.role).toBe("user");
    expect(JSON.stringify(lastMsg.content)).toContain("task result: 42");
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
  });

  test("park: loop waits for live background work, wakes on the event, then finishes clean", async () => {
    const inbox = new EventInbox();
    let live = true;
    const model = new ScriptedModel([
      textDone("wrapping up"),
      textDone("saw the completion; done for real"),
    ]);
    const sess = session(model, "autopilot", {
      inbox,
      backgroundWait: { hasLiveWork: () => live, maxWaitMs: 5_000 },
    });
    // Emit the completion shortly after the run parks.
    setTimeout(() => {
      live = false;
      inbox.emit(ev({ id: "late", body: "late completion" }));
    }, 100);

    const t0 = Date.now();
    const events = await collect(sess.run({ text: "go" }));
    expect(Date.now() - t0).toBeLessThan(4_000); // woke on the event, not the timeout
    expect(model.seen.length).toBe(2);
    expect(JSON.stringify(model.seen[1]!.messages.at(-1)!.content)).toContain("late completion");
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
  });

  test("park timeout: no event arrives → run ends after maxWaitMs instead of hanging", async () => {
    const inbox = new EventInbox();
    const model = new ScriptedModel([textDone("done")]);
    const sess = session(model, "autopilot", {
      inbox,
      backgroundWait: { hasLiveWork: () => true, maxWaitMs: 150 },
    });
    const t0 = Date.now();
    const events = await collect(sess.run({ text: "go" }));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(model.seen.length).toBe(1); // never continued — nothing arrived
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
  });

  test("e2e: Monitor tool → model keeps working → completion wakes the parked run", async () => {
    const { monitorTool } = await import("../src/tools/builtin/bash");
    const { backgroundTasks } = await import("../src/tools/builtin/background");
    const inbox = new EventInbox();
    backgroundTasks.attachInbox(inbox, "s1");
    const tools = defaultRegistry();
    tools.register(monitorTool);
    const model = new ScriptedModel([
      toolUse("Monitor", { command: "sleep 0.3; echo WATCH-DONE" }),
      textDone("monitor started; my work here is done"),
      textDone("saw WATCH-DONE; finishing"),
    ]);
    const sess = session(model, "autopilot", {
      tools,
      inbox,
      backgroundWait: { hasLiveWork: () => backgroundTasks.liveMonitorCount("s1") > 0, maxWaitMs: 5_000 },
    });
    const events = await collect(sess.run({ text: "watch the thing" }));

    // Turn 2 got the Monitor tool_result immediately (non-blocking start)…
    const monResult = events.find((e) => e.type === "tool_result");
    expect(monResult && "content" in monResult ? monResult.content : "").toContain("Started monitor");
    // …and the run parked at finish until the completion event arrived, then continued.
    expect(model.seen.length).toBe(3);
    const finalCall = JSON.stringify(model.seen[2]!.messages.at(-1)!.content);
    expect(finalCall).toContain(EVENTS_HEADER);
    expect(finalCall).toContain("WATCH-DONE");
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
    backgroundTasks.detachInbox();
  });

  test("e2e: background sub-agent completion is delivered to the parked parent loop", async () => {
    const inbox = new EventInbox();
    const agents = new BackgroundAgents();
    agents.attachInbox(inbox);
    const model = new ScriptedModel([
      textDone("delegated; wrapping up"),
      textDone("got the sub-agent result; done"),
    ]);
    const sess = session(model, "autopilot", {
      inbox,
      backgroundWait: { hasLiveWork: () => agents.liveCount() > 0, maxWaitMs: 5_000 },
    });
    // Child finishes 100ms in — while the parent is parked at its finish boundary.
    agents.start("research question", () => new Promise((r) => setTimeout(() => r("ANSWER-42"), 100)));
    const events = await collect(sess.run({ text: "go" }));

    expect(model.seen.length).toBe(2);
    const secondCall = JSON.stringify(model.seen[1]!.messages.at(-1)!.content);
    expect(secondCall).toContain(EVENTS_HEADER);
    expect(secondCall).toContain("ANSWER-42");
    expect(secondCall).toContain("research question"); // labeled as the agent's description
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
    agents.detachInbox();
  });

  test("no inbox configured → loop behavior is unchanged", async () => {
    const model = new ScriptedModel([textDone("done")]);
    const events = await collect(session(model, "autopilot").run({ text: "go" }));
    expect(model.seen.length).toBe(1);
    expect(events.find((e) => e.type === "result")).toBeDefined();
  });
});

describe("provider neutrality", () => {
  test("event injections are plain text on any model — no provider-specific blocks", async () => {
    // Same flow on a claude tag and a non-claude tag: the injection path must not branch on
    // model. Every injected event message must be a plain string or text blocks only — the
    // universal subset every gateway backend (Anthropic/OpenAI/Google) accepts unchanged.
    for (const modelTag of ["claude-opus-5", "gpt-5.2", "gemini-3-pro"]) {
      const inbox = new EventInbox();
      const model = new ScriptedModel([
        toolUse("Bash", { command: "echo hi" }),
        textDone("wrapping"),
        textDone("done"),
      ]);
      model.onCall = (i) => {
        if (i === 0) inbox.emit(ev({ id: `mid-${modelTag}`, body: "mid-run event" }));
        if (i === 1) inbox.emit(ev({ id: `fin-${modelTag}`, body: "finish event" }));
      };
      const sess = session(model, "autopilot", { inbox, model: modelTag });
      await collect(sess.run({ text: "go" }));

      for (const req of model.seen) {
        for (const msg of req.messages) {
          const blocks = typeof msg.content === "string" ? [] : msg.content;
          for (const b of blocks as Array<{ type: string; text?: string }>) {
            if (JSON.stringify(b).includes(EVENTS_HEADER)) {
              expect(b.type).toBe("text"); // never a tool_result/document/custom block
            }
          }
        }
      }
      // Both events were actually delivered on this model tag.
      const all = JSON.stringify(model.seen.at(-1)!.messages);
      expect(all).toContain("mid-run event");
      expect(all).toContain("finish event");
    }
  });
});

describe("producers → inbox", () => {
  test("BackgroundTasks routes exits to the owning session's inbox only", async () => {
    const inbox = new EventInbox();
    const reg = new BackgroundTasks();
    reg.attachInbox(inbox, "main-session");
    const mine = reg.start("echo mine", cwd, "main-session");
    const foreign = reg.start("echo foreign", cwd, "subagent-session");
    // Wait for both to exit.
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (mine.exitCode !== null && foreign.exitCode !== null) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    const pushed = inbox.drain();
    expect(pushed.length).toBe(1);
    expect(pushed[0]!.source).toBe(mine.id);
    expect(pushed[0]!.kind).toBe("complete");
    expect(pushed[0]!.body).toContain("mine");
    // The foreign task still reports through the pull path (its owner drains it).
    const notes = reg.drainNotifications();
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain(foreign.id);
    // And nothing double-reports.
    expect(reg.drainNotifications()).toEqual([]);
    expect(inbox.drain()).toEqual([]);
    reg.detachInbox();
  });

  test("BackgroundAgents progress: throttled per task, coalesced, then completion", async () => {
    const inbox = new EventInbox();
    const reg = new BackgroundAgents(50); // tight throttle for the test
    reg.attachInbox(inbox);
    let report: (s: string) => void = () => {};
    const gate = { done: false };
    const t = reg.start("research", (signal) => {
      void signal;
      return new Promise<string>((resolve) => {
        report = (s) => reg.reportProgress(t.id, s);
        const timer = setInterval(() => {
          if (gate.done) {
            clearInterval(timer);
            resolve("final answer");
          }
        }, 10);
      });
    });
    report("turn 1 · Read a.ts");
    report("turn 1b · immediately after"); // inside the throttle window — dropped
    await new Promise((r) => setTimeout(r, 60));
    report("turn 2 · Grep pattern");
    gate.done = true;
    await new Promise((r) => setTimeout(r, 50));

    const events = inbox.drain();
    const progress = events.filter((e) => e.kind === "progress");
    expect(progress.length).toBe(1); // two survived the throttle, coalescing kept the newest
    expect(progress[0]!.body).toBe("turn 2 · Grep pattern");
    const done = events.find((e) => e.kind === "complete")!;
    expect(done.body).toContain("final answer");
    // progress after completion is ignored
    reg.reportProgress(t.id, "late");
    expect(inbox.size()).toBe(0);
    reg.detachInbox();
  });

  test("BackgroundAgents usage telemetry accumulates tokens and records the routed model", () => {
    const reg = new BackgroundAgents();
    const t = reg.start("routed child", () => new Promise<string>(() => {}));
    reg.reportUsage(t.id, 120, "gpt-5.6-luna");
    reg.reportUsage(t.id, 80);
    expect(t.outputTokens).toBe(200);
    expect(t.model).toBe("gpt-5.6-luna");
    reg.kill(t.id);
  });

  test("BackgroundAgents pushes completion digest and failure; cancelled stays silent", async () => {
    const inbox = new EventInbox();
    const reg = new BackgroundAgents();
    reg.attachInbox(inbox);
    reg.start("research X", async () => "the answer is 42");
    reg.start("doomed", async () => {
      throw new Error("child exploded");
    });
    const cancelled = reg.start("slow", () => new Promise<string>(() => {}));
    reg.kill(cancelled.id);
    await new Promise((r) => setTimeout(r, 30));

    const pushed = inbox.drain();
    expect(pushed.length).toBe(2);
    const done = pushed.find((e) => e.kind === "complete")!;
    expect(done.sourceType).toBe("agent");
    expect(done.body).toContain("the answer is 42");
    const failed = pushed.find((e) => e.kind === "error")!;
    expect(failed.body).toContain("child exploded");
    // Cancelled task must not be pushed (the model initiated the kill) — and with an inbox
    // attached, done/failed are claimed, so the pull path only reports the cancellation.
    const notes = reg.drainNotifications();
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("cancelled");
    reg.detachInbox();
  });
});

describe("compaction × events", () => {
  test("microcompact stubs old event batches (string and folded forms) but keeps recent ones", () => {
    const eventText = `${EVENTS_HEADER}\n• mon1 (monitor "watch") finished:\nnoisy payload`;
    const messages = [
      { role: "user" as const, content: "task" },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
      { role: "user" as const, content: eventText }, // old finish-boundary injection
      { role: "assistant" as const, content: [{ type: "text" as const, text: "ack" }] },
      {
        role: "user" as const,
        content: [
          { type: "tool_result" as const, tool_use_id: "t1", content: "small" },
          { type: "text" as const, text: eventText }, // old mid-loop fold
        ],
      },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "working" }] },
      { role: "user" as const, content: eventText }, // recent — must survive
    ];
    const out = microcompact(messages, 2);
    expect(out[2]!.content).toBe("[old background events cleared]");
    const folded = out[4]!.content as Array<{ type: string; text?: string }>;
    expect(folded[1]!.text).toBe("[old background events cleared]");
    // inside the recent window: untouched
    expect(out[6]!.content).toBe(eventText);
  });
});
