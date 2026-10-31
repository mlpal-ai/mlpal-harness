/**
 * D-48: an approval binds to the exact call its park holds, and the engine settles that call itself. `allow` runs the
 * held call (same name, input and id) and records its real result before the model is called again; `deny` records a
 * denial and the call never runs. The held call is read from the log, so this holds in a new engine process, and a
 * call whose approved run began before an engine died is never run again. Also D-49's seam: a host's step gate halts
 * a turn at a step boundary with the step in flight finished and nothing more written.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EngineEvent, HUMAN, type SDKMessage } from "@mlpal/harness-protocol";
import { z } from "zod";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import { AgentSession, type AgentConfig, INTERRUPTED_TOOL_RESULT, NoHeldCallError, heldCall, inFlightTurn } from "../src/loop/agent";
import { effectiveEntries, loadMessages } from "../src/loop/messages";
import { LocalStore } from "../src/store/local";
import { SessionStoreClient } from "../src/store/remote/client";
import { LeaseKeeper } from "../src/store/remote/lease";
import { RemoteStore } from "../src/store/remote/remote-store";
import type { MemoryStore, Store } from "../src/store/types";
import { ToolRegistry } from "../src/tools/registry";
import { defineTool } from "../src/tools/types";
import { type FakeSessionStore, startFakeSessionStore } from "./fake-session-store";

class ScriptedModel implements ModelClient {
  private i = 0;
  readonly seen: ModelRequest[] = [];
  constructor(private readonly scripts: ModelResult[]) {}
  async *stream(req: ModelRequest): AsyncGenerator<never, ModelResult, void> {
    this.seen.push(req);
    const r = this.scripts[this.i++];
    if (!r) throw new GatewayError("script exhausted", 500);
    return r;
  }
}

const call = (...uses: Array<[id: string, name: string, input: Record<string, unknown>]>): ModelResult => ({
  model: "test",
  message: { role: "assistant", content: uses.map(([id, name, input]) => ({ type: "tool_use" as const, id, name, input })) },
  usage: { input_tokens: 10, output_tokens: 5 },
  stopReason: "tool_use",
});
const textDone = (text: string): ModelResult => ({
  model: "test",
  message: { role: "assistant", content: [{ type: "text", text }] },
  usage: { input_tokens: 8, output_tokens: 4 },
  stopReason: "end_turn",
});

const PROBE = { command: "echo destroy-probe" };
const memory: MemoryStore = { readIndex: async () => "", writeTopic: async () => {}, readTopic: async () => null, listTopics: async () => [] };

let root: string;
let cwd: string;
let fake: FakeSessionStore | undefined;
const open: RemoteStore[] = [];

beforeEach(() => {
  root = join(tmpdir(), `yodex-approval-${crypto.randomUUID()}`);
  cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {});
  await fake?.stop();
  fake = undefined;
  rmSync(root, { recursive: true, force: true });
});

interface Backend {
  store: Store;
  /** The same session through a new store object, as a new engine process opens it. */
  reopen(): Promise<Store>;
}

function local(): Backend {
  const dir = join(root, "store");
  return { store: new LocalStore(dir), reopen: async () => new LocalStore(dir) };
}

async function remoteOn(f: FakeSessionStore): Promise<RemoteStore> {
  const g = f.grant("s1", { ttlS: 60 });
  const client = new SessionStoreClient({ baseUrl: f.url, tokenProvider: () => g.token });
  const lease = new LeaseKeeper({ client, sid: "s1", ttlS: 60 });
  lease.adopt({ leaseId: g.leaseId });
  const store = new RemoteStore({ client, sid: "s1", lease, memory, artifactsDir: join(root, "artifacts") });
  await store.open();
  open.push(store);
  return store;
}

async function remote(): Promise<Backend> {
  const f = startFakeSessionStore();
  fake = f;
  f.createSession("s1");
  return {
    store: await remoteOn(f),
    reopen: async () => {
      for (const s of open.splice(0)) await s.close();
      return remoteOn(f);
    },
  };
}

/** A tool with an effect that records each run's input; `Probe` asks for approval, `Count` does not. */
function tools() {
  const runs: Array<{ tool: string; input: unknown }> = [];
  const effect = (name: string) =>
    defineTool({
      name,
      description: name,
      readOnly: false,
      executes: true,
      schema: z.object({ command: z.string().optional() }),
      call: async (input) => {
        runs.push({ tool: name, input });
        return { content: `ran ${name}: ${input.command ?? ""}` };
      },
    });
  const registry = new ToolRegistry();
  registry.register(effect("Probe") as never);
  registry.register(effect("Count") as never);
  return { registry, runs };
}

/** Probe asks; every other tool is allowed. With no answerer, the ask parks the run (`every_ask`). */
function session(store: Store, model: ModelClient, registry: ToolRegistry, extra: Partial<AgentConfig> = {}): AgentSession {
  return new AgentSession({
    agentId: "ag1",
    sessionId: "s1",
    workspace: "w",
    cwd,
    model: "test",
    systemPrompt: "test",
    tools: registry,
    store,
    model_client: model,
    canUseTool: (req) => (req.toolName === "Probe" ? { behavior: "ask", reason: "needs a person" } : { behavior: "allow" }),
    parkHeadless: "every_ask",
    ...extra,
  });
}

async function drain<R>(gen: AsyncGenerator<EngineEvent, R, void>): Promise<{ events: EngineEvent[]; value: R }> {
  const events: EngineEvent[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { events, value: n.value };
    events.push(n.value);
  }
}

const kinds = async (store: Store) => effectiveEntries(await store.conversation.read("s1")).map((e) => e.payload.type);
const started = async (store: Store) => ((await store.readEvents?.("s1", "tool_started")) ?? []).map((m) => m.toolUseId);
/** What the model was sent for the held call in its last request: the tool_result block for `id`. */
const sentResult = (model: ScriptedModel, id: string) =>
  (model.seen.at(-1)!.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>).find(
    (b) => b.type === "tool_result" && b.tool_use_id === id,
  );

/** Run 1: the model calls Probe (tu1); nobody answers, so the run parks needs_approval holding tu1. */
async function parked(store: Store, registry: ToolRegistry) {
  const { events } = await drain(session(store, new ScriptedModel([call(["tu1", "Probe", PROBE])]), registry).run({ text: "run the probe" }));
  await store.flush?.();
  return events.at(-1);
}

for (const [name, make] of [
  ["LocalStore", async () => local()],
  ["RemoteStore", () => remote()],
] as const) {
  describe(`D-48: an approval settles the held call (${name})`, () => {
    test("the park names its held call by id", async () => {
      const b = await make();
      const { registry, runs } = tools();
      expect(await parked(b.store, registry)).toMatchObject({ type: "result", subtype: "needs_approval", pendingApproval: { command: "echo destroy-probe", reason: "approval_required", toolUseId: "tu1" } });
      expect(runs).toEqual([]);
      expect(heldCall(effectiveEntries(await b.store.conversation.read("s1")))?.toolUse).toEqual({ type: "tool_use", id: "tu1", name: "Probe", input: PROBE });
    });

    test("allow in the same process: the held call runs once with its own id and input, its real result is on record before the model is called, and the turn ends", async () => {
      const b = await make();
      const { registry, runs } = tools();
      await parked(b.store, registry);
      const model = new ScriptedModel([textDone("the probe ran")]);
      const { events } = await drain(session(b.store, model, registry).approve({ decision: "allow" }));
      expect(runs).toEqual([{ tool: "Probe", input: PROBE }]);
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ toolUseId: "tu1", toolName: "Probe", isError: false, content: "ran Probe: echo destroy-probe" });
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
      expect(await started(b.store)).toEqual(["tu1"]);
      expect(model.seen).toHaveLength(1);
      expect(sentResult(model, "tu1")).toMatchObject({ content: "ran Probe: echo destroy-probe", is_error: false });
      expect(JSON.stringify(model.seen[0]!.messages)).not.toContain("no result recorded");
      expect(await kinds(b.store)).toEqual(["system", "user", "assistant", "result", "tool_result", "assistant", "result"]);
      // Settled: nothing is held any more, and a second answer finds nothing.
      expect(heldCall(effectiveEntries(await b.store.conversation.read("s1")))).toBeUndefined();
      await expect(drain(session(b.store, new ScriptedModel([]), registry).approve({ decision: "allow" }))).rejects.toBeInstanceOf(NoHeldCallError);
      expect(runs).toHaveLength(1);
    });

    test("allow in a new engine process (after a park and resume): the held call is rebuilt from the log and run", async () => {
      const b = await make();
      const first = tools();
      await parked(b.store, first.registry);
      const store = await b.reopen();
      const { registry, runs } = tools();
      const model = new ScriptedModel([textDone("the probe ran")]);
      const { events } = await drain(session(store, model, registry).approve({ decision: "allow", toolUseId: "tu1" }));
      expect(first.runs).toEqual([]);
      expect(runs).toEqual([{ tool: "Probe", input: PROBE }]);
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ toolUseId: "tu1", content: "ran Probe: echo destroy-probe" });
      expect(sentResult(model, "tu1")).toMatchObject({ content: "ran Probe: echo destroy-probe" });
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    });

    test("deny: a denial is the held call's result, the call never runs, and the model hears it", async () => {
      const b = await make();
      const { registry, runs } = tools();
      await parked(b.store, registry);
      const model = new ScriptedModel([textDone("understood")]);
      const { events } = await drain(session(await b.reopen(), model, registry).approve({ decision: "deny", reason: "not today" }));
      expect(runs).toEqual([]);
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ toolUseId: "tu1", isError: true, content: "Permission denied: not today" });
      expect(sentResult(model, "tu1")).toMatchObject({ content: "Permission denied: not today", is_error: true });
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    });

    test("a policy that denies the call by the time of the answer still wins over an allow: the call never runs", async () => {
      const b = await make();
      const { registry, runs } = tools();
      await parked(b.store, registry);
      const model = new ScriptedModel([textDone("blocked")]);
      const tightened = session(await b.reopen(), model, registry, { canUseTool: (req) => (req.toolName === "Probe" ? { behavior: "deny", reason: "rule tightened" } : { behavior: "allow" }) });
      const { events } = await drain(tightened.approve({ decision: "allow" }));
      expect(runs).toEqual([]);
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ toolUseId: "tu1", isError: true, content: "Permission denied: rule tightened" });
    });

    test("an approval naming another call than the held one is refused, and nothing is written", async () => {
      const b = await make();
      const { registry, runs } = tools();
      await parked(b.store, registry);
      const before = await kinds(b.store);
      await expect(drain(session(b.store, new ScriptedModel([textDone("x")]), registry).approve({ decision: "allow", toolUseId: "tu-other" }))).rejects.toThrow("is not waiting for approval of tu-other");
      expect(runs).toEqual([]);
      expect(await kinds(b.store)).toEqual(before);
    });

    for (const settle of ["resume", "approve"] as const) {
      test(`crash between the approved run and its result, then a ${settle}: the call is not run again, and its result says it may have happened`, async () => {
        const b = await make();
        const { registry, runs } = tools();
        await parked(b.store, registry);
        // The approving engine wrote the side-effect marker, ran the call, and died before its result.
        await b.store.appendEvent!("s1", "tool_started", { toolUseId: "tu1", name: "Probe", ts: "t9" });
        await b.store.flush?.();
        const store = await b.reopen();
        const model = new ScriptedModel([textDone("checked")]);
        const s = session(store, model, registry);
        const { events } = settle === "resume" ? await drain(s.resume()) : await drain(s.approve({ decision: "allow" }));
        expect(runs).toEqual([]);
        expect(events.filter((e) => e.type === "tool_result")).toEqual([expect.objectContaining({ toolUseId: "tu1", isError: true, content: INTERRUPTED_TOOL_RESULT })]);
        expect(sentResult(model, "tu1")).toMatchObject({ content: INTERRUPTED_TOOL_RESULT });
        expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
      });
    }

    test("crash after the held call's result, before the model answered: a resume continues the turn without running anything again", async () => {
      const b = await make();
      const { registry, runs } = tools();
      await parked(b.store, registry);
      const head = await b.store.conversation.head("s1");
      await b.store.appendEvent!("s1", "tool_started", { toolUseId: "tu1", name: "Probe", ts: "t9" });
      await b.store.conversation.append("s1", { type: "tool_result", toolUseId: "tu1", toolName: "Probe", content: "ran Probe: echo destroy-probe", isError: false, ts: "t10" } as SDKMessage, head);
      await b.store.flush?.();
      const store = await b.reopen();
      expect(inFlightTurn(effectiveEntries(await store.conversation.read("s1"))).map((e) => e.payload.type)).toEqual(["user", "assistant", "tool_result"]);
      const model = new ScriptedModel([textDone("the probe ran")]);
      const { events, value } = await drain(session(store, model, registry).resume());
      expect(value).toEqual({ resumed: true });
      expect(runs).toEqual([]);
      expect(sentResult(model, "tu1")).toMatchObject({ content: "ran Probe: echo destroy-probe" });
      // Only the model call after the park counts: the park's result counted the one before it.
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success", usage: { input_tokens: 8, output_tokens: 4 } });
    });

    test("a serial batch that parks at its second call keeps the first call's result; the approval runs only the held call", async () => {
      const b = await make();
      const { registry, runs } = tools();
      const first = await drain(session(b.store, new ScriptedModel([call(["tu1", "Count", { command: "one" }], ["tu2", "Probe", PROBE])]), registry).run({ text: "two steps" }));
      expect(first.events.at(-1)).toMatchObject({ subtype: "needs_approval", pendingApproval: { toolUseId: "tu2" } });
      expect(first.events.filter((e) => e.type === "tool_result").map((e) => (e as { toolUseId: string }).toolUseId)).toEqual(["tu1"]);
      await b.store.flush?.();
      const model = new ScriptedModel([textDone("both ran")]);
      await drain(session(await b.reopen(), model, registry).approve({ decision: "allow" }));
      expect(runs).toEqual([
        { tool: "Count", input: { command: "one" } },
        { tool: "Probe", input: PROBE },
      ]);
      expect(sentResult(model, "tu1")).toMatchObject({ content: "ran Count: one" });
      expect(sentResult(model, "tu2")).toMatchObject({ content: "ran Probe: echo destroy-probe" });
    });

    test("a park recorded before D-48 (command only) is matched to its call by the command", async () => {
      const b = await make();
      const { registry, runs } = tools();
      const sys = await b.store.conversation.append("s1", { type: "system", subtype: "init", sessionId: "s1", agentId: "ag1", model: "test", cwd, ts: "t0" } as SDKMessage, null);
      const user = await b.store.conversation.append("s1", { type: "user", message: { role: "user", content: "probe" }, author: HUMAN, ts: "t1" } as SDKMessage, sys.uuid);
      const asst = await b.store.conversation.append("s1", { type: "assistant", message: call(["tu1", "Probe", PROBE]).message, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use", model: "test", ts: "t2" } as SDKMessage, user.uuid);
      await b.store.conversation.append("s1", { type: "result", subtype: "needs_approval", numTurns: 1, usage: { input_tokens: 1, output_tokens: 1 }, ts: "t3", pendingApproval: { command: "echo destroy-probe", reason: "approval_required" } } as SDKMessage, asst.uuid);
      await b.store.flush?.();
      await drain(session(await b.reopen(), new ScriptedModel([textDone("ok")]), registry).approve({ decision: "allow" }));
      expect(runs).toEqual([{ tool: "Probe", input: PROBE }]);
    });
  });
}

describe("D-49: the step gate", () => {
  test("a gate that closes mid-step: the step finishes and its result is on record; no model call or step follows, and no result is written", async () => {
    const store = new LocalStore(join(root, "store"));
    const { registry, runs } = tools();
    let closed = false;
    const reached = Promise.withResolvers<void>();
    const gate = async () => {
      if (!closed) return;
      reached.resolve();
      await new Promise<never>(() => {});
    };
    const slow = defineTool({
      name: "Slow",
      description: "slow",
      readOnly: false,
      executes: true,
      schema: z.object({}),
      call: async () => {
        closed = true;
        await Bun.sleep(50);
        return { content: "slow done" };
      },
    });
    registry.register(slow as never);
    const model = new ScriptedModel([call(["tu1", "Slow", {}], ["tu2", "Count", { command: "next" }]), textDone("never")]);
    const events: EngineEvent[] = [];
    void (async () => {
      for await (const e of session(store, model, registry, { canUseTool: () => ({ behavior: "allow" }), stepGate: gate }).run({ text: "go" })) events.push(e);
    })();
    await reached.promise;
    await Bun.sleep(50);
    expect(events.filter((e) => e.type === "tool_result")).toEqual([expect.objectContaining({ toolUseId: "tu1", content: "slow done" })]);
    expect(runs).toEqual([]);
    expect(model.seen).toHaveLength(1);
    expect(await kinds(store)).toEqual(["system", "user", "assistant", "tool_result"]);
    // Left for the next engine: the turn is in flight, its unstarted call still to run.
    expect(inFlightTurn(effectiveEntries(await store.conversation.read("s1"))).length).toBe(3);
    expect(JSON.stringify(await loadMessages(store, "s1"))).toContain("slow done");
  });
});
