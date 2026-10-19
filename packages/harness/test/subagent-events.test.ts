import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineEvent, SubagentEvent, SubagentStreamEvent } from "@mlpal/harness-protocol";
import { SessionEventBus, SideQueue } from "../src/events/session-bus";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { loadMessages } from "../src/loop/messages";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { BackgroundAgents } from "../src/subagent/background";
import { createTaskTool, type SubagentRun } from "../src/subagent/task";
import { ToolRegistry } from "../src/tools/registry";

let root: string;
beforeEach(async () => {
  root = join(tmpdir(), `yodex-subev-${crypto.randomUUID().slice(0, 8)}`);
  await mkdir(root, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

class ScriptedModel implements ModelClient {
  private i = 0;
  constructor(private readonly scripts: ModelResult[]) {}
  async *stream(_req: ModelRequest): AsyncGenerator<never, ModelResult, void> {
    const r = this.scripts[this.i++];
    if (!r) throw new GatewayError("script exhausted", 500);
    return r;
  }
}
const agentCall = (input: Record<string, unknown>, id = "tu_agent_1"): ModelResult => ({
  model: "test",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input }] },
  usage: { input_tokens: 10, output_tokens: 5 },
  stopReason: "tool_use",
});
const textDone = (text: string): ModelResult => ({ model: "test", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 10, output_tokens: 5 }, stopReason: "end_turn" });

/** A runner like the host's: mints a child id, reports it, streams two child events, returns. */
function fakeRunner(opts: { childId: string; hold?: Promise<void>; events?: EngineEvent[] }): { run: SubagentRun; seen: Parameters<SubagentRun>[0][] } {
  const seen: Parameters<SubagentRun>[0][] = [];
  const run: SubagentRun = async (args, signal) => {
    seen.push(args);
    queueMicrotask(() => args.onSessionId?.(opts.childId));
    await Promise.resolve();
    for (const ev of opts.events ?? [{ type: "text_delta", text: "child says hi" }]) args.onEvent?.(ev);
    args.onProgress?.("turn 1 · Read");
    args.onUsage?.(3, "child-model");
    if (opts.hold) {
      await Promise.race([opts.hold, new Promise<void>((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))))]);
    }
    return { text: "child result", sessionId: opts.childId };
  };
  return { run, seen };
}

function session(store: LocalStore, model: ModelClient, tools: ToolRegistry, extra: Partial<ConstructorParameters<typeof AgentSession>[0]> = {}): AgentSession {
  return new AgentSession({
    agentId: "a",
    sessionId: "parent",
    workspace: "w",
    cwd: root,
    model: "test",
    systemPrompt: "t",
    tools,
    store,
    model_client: model,
    canUseTool: createPolicy({ mode: "autopilot" }),
    ...extra,
  });
}

async function collect(s: AgentSession, text = "go"): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of s.run({ text })) out.push(e);
  return out;
}

describe("sub-agent events on the parent stream", () => {
  test("foreground: start, forwarded child events, progress and end, in order, nested under the Agent tool_use", async () => {
    const store = new LocalStore(root);
    const bg = new BackgroundAgents(0);
    const { run, seen } = fakeRunner({ childId: "child-1" });
    const tools = new ToolRegistry();
    tools.register(createTaskTool(run, [], bg));
    const events = await collect(session(store, new ScriptedModel([agentCall({ description: "fg child", prompt: "do it" }), textDone("done")]), tools));

    const sub = events.filter((e): e is SubagentEvent => e.type === "subagent");
    const forwarded = events.filter((e): e is SubagentStreamEvent => e.type === "subagent_event");
    expect(sub.map((e) => e.kind)).toEqual(["start", "progress", "end"]);
    expect(sub[0]).toMatchObject({ toolUseId: "tu_agent_1", childSessionId: "child-1", description: "fg child", background: false });
    expect(sub[1]).toMatchObject({ status: "turn 1 · Read" });
    expect(sub[2]).toMatchObject({ outcome: "success", model: "child-model" });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ childSessionId: "child-1", event: { type: "text_delta", text: "child says hi" } });
    // The runner was told which step spawned it.
    expect(seen[0]?.callerToolUseId).toBe("tu_agent_1");
    // Order on the stream: the lifecycle precedes the Agent tool_result.
    const idx = (p: (e: EngineEvent) => boolean) => events.findIndex(p);
    expect(idx((e) => e.type === "subagent" && e.kind === "start")).toBeLessThan(idx((e) => e.type === "tool_result"));
    expect(idx((e) => e.type === "subagent" && e.kind === "end")).toBeLessThan(idx((e) => e.type === "tool_result"));
    // start and end carry uuids and are persisted; progress is not.
    expect(sub[0]!.uuid).toBeString();
    expect(sub[2]!.uuid).toBeString();
    expect(sub[1]!.uuid).toBeUndefined();
    const persisted = (await store.conversation.read("parent")).map((e) => e.payload).filter((p) => p.type === "subagent") as SubagentEvent[];
    expect(persisted.map((p) => p.kind)).toEqual(["start", "end"]);
    // Replay for the model skips them entirely.
    const msgs = await loadMessages(store, "parent");
    expect(JSON.stringify(msgs)).not.toContain("subagent");
    expect(msgs.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  test("background: start during the run; end after the run lands in the transcript through the bus and reaches an idle listener", async () => {
    const store = new LocalStore(root);
    const bus = new SessionEventBus(store);
    const bg = new BackgroundAgents(0);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const { run } = fakeRunner({ childId: "child-bg", hold });
    const tools = new ToolRegistry();
    tools.register(createTaskTool(run, [], bg));
    const idle: Array<{ sessionId: string; e: SubagentEvent | SubagentStreamEvent }> = [];
    bus.onIdle((sessionId, e) => idle.push({ sessionId, e }));

    const events = await collect(session(store, new ScriptedModel([agentCall({ description: "bg child", prompt: "later", run_in_background: true }), textDone("started")]), tools, { events: bus }));
    const during = events.filter((e): e is SubagentEvent => e.type === "subagent");
    expect(during.map((e) => e.kind)).toEqual(["start", "progress"]);
    expect(during[0]).toMatchObject({ background: true, childSessionId: "child-bg" });
    expect(idle).toHaveLength(0);

    release();
    await Bun.sleep(10);
    await bus.settled();
    const ends = idle.filter((i) => i.e.type === "subagent" && i.e.kind === "end");
    expect(ends).toHaveLength(1);
    expect(ends[0]!.sessionId).toBe("parent");
    expect(ends[0]!.e).toMatchObject({ outcome: "success", childSessionId: "child-bg" });
    expect((ends[0]!.e as SubagentEvent).uuid).toBeString();
    // Persisted at the conversation head, with the record's head moved along.
    const entries = await store.conversation.read("parent");
    const last = entries[entries.length - 1]!;
    expect(last.payload).toMatchObject({ type: "subagent", kind: "end" });
    expect((await store.registry.getSession("parent"))?.head).toBe(last.uuid);
  });

  test("a killed child ends with outcome cancelled, by session id", async () => {
    const store = new LocalStore(root);
    const bus = new SessionEventBus(store);
    const bg = new BackgroundAgents(0);
    const hold = new Promise<void>(() => {});
    const { run } = fakeRunner({ childId: "child-k", hold });
    const tools = new ToolRegistry();
    tools.register(createTaskTool(run, [], bg));
    const idle: SubagentEvent[] = [];
    bus.onIdle((_sid, e) => {
      if (e.type === "subagent") idle.push(e);
    });
    await collect(session(store, new ScriptedModel([agentCall({ description: "bg child", prompt: "forever", run_in_background: true }), textDone("started")]), tools, { events: bus }));
    expect(bg.bySession("child-k")?.status).toBe("running");
    expect(bg.killBySession("child-k")).toBe(true);
    await Bun.sleep(10);
    await bus.settled();
    expect(idle.map((e) => e.kind)).toEqual(["end"]);
    expect(idle[0]).toMatchObject({ outcome: "cancelled", childSessionId: "child-k" });
    expect(bg.killBySession("child-k")).toBe(false);
    expect(bg.killBySession("nope")).toBe(false);
  });

  test("the child's session record names its parent and the spawning step", async () => {
    const store = new LocalStore(root);
    const child = new AgentSession({
      agentId: "a",
      sessionId: "child-r",
      workspace: "w",
      cwd: root,
      model: "test",
      systemPrompt: "t",
      tools: new ToolRegistry(),
      store,
      model_client: new ScriptedModel([textDone("hi")]),
      canUseTool: createPolicy({ mode: "autopilot" }),
      parent: { sessionId: "parent", toolUseId: "tu_agent_1" },
    });
    await collect(child);
    expect((await store.registry.getSession("child-r"))?.parent).toEqual({ sessionId: "parent", toolUseId: "tu_agent_1" });
  });

  test("without a bus, in-run side events still stream; nothing is emitted without an emit seam", async () => {
    const store = new LocalStore(root);
    const bg = new BackgroundAgents(0);
    const { run } = fakeRunner({ childId: "child-nb" });
    const tools = new ToolRegistry();
    tools.register(createTaskTool(run, [], bg));
    const events = await collect(session(store, new ScriptedModel([agentCall({ description: "fg", prompt: "p" }), textDone("done")]), tools));
    expect(events.filter((e) => e.type === "subagent").map((e) => (e as SubagentEvent).kind)).toEqual(["start", "progress", "end"]);
    // The tool called directly (no stream): no emit, no throw.
    const tool = createTaskTool(run, [], bg);
    const r = await tool.call({ description: "d", prompt: "p" }, { cwd: root });
    expect(String(r.content)).toContain("child result");
  });
});

describe("SideQueue.until", () => {
  test("yields events pushed while the work is pending, then the stragglers, then stops", async () => {
    const q = new SideQueue();
    let finish!: () => void;
    const work = new Promise<void>((r) => (finish = r));
    const seen: string[] = [];
    const ev = (status: string): SubagentEvent => ({ type: "subagent", kind: "progress", toolUseId: "t", childSessionId: "c", description: "d", background: false, status, ts: "" });
    const consumer = (async () => {
      for await (const e of q.until(work)) seen.push((e as SubagentEvent).status!);
    })();
    await Bun.sleep(1);
    q.push(ev("one"));
    await Bun.sleep(1);
    q.push(ev("two"));
    finish();
    q.push(ev("three"));
    await consumer;
    expect(seen).toEqual(["one", "two", "three"]);
  });

  test("a rejected work promise ends the iteration without throwing", async () => {
    const q = new SideQueue();
    const work = Promise.reject(new Error("tool failed"));
    work.catch(() => undefined);
    const seen: unknown[] = [];
    for await (const e of q.until(work)) seen.push(e);
    expect(seen).toEqual([]);
  });
});
