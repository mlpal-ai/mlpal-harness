/**
 * Engine store slice 2 (plan §5): the side-effect key and resume, over both backends. A tool that is
 * not read-only leaves a durable `tool_started` marker before it runs; a fresh engine resuming a
 * session a dead one left mid-turn never re-runs a started tool, runs a never-started one once, and
 * continues the turn to its result.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EngineEvent, HUMAN, type SDKMessage } from "@mlpal/harness-protocol";
import { z } from "zod";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import { FunctionHook, HookEngine } from "../src/hooks/engine";
import { AgentSession, type AgentConfig, INTERRUPTED_TOOL_RESULT } from "../src/loop/agent";
import { loadMessages } from "../src/loop/messages";
import { createPolicy } from "../src/permission/engine";
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

const toolUse = (id: string, name: string): ModelResult => ({
  model: "test",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
  usage: { input_tokens: 10, output_tokens: 5 },
  stopReason: "tool_use",
});
const textDone = (text: string): ModelResult => ({
  model: "test",
  message: { role: "assistant", content: [{ type: "text", text }] },
  usage: { input_tokens: 8, output_tokens: 4 },
  stopReason: "end_turn",
});

const memory: MemoryStore = { readIndex: async () => "", writeTopic: async () => {}, readTopic: async () => null, listTopics: async () => [] };

interface Backend {
  readonly store: Store;
  /** The same session through a new store object, as a new engine process would open it. */
  reopen(opts?: { maxEventBytes?: number }): Promise<Store>;
  /** Whether a `tool_started` marker for `toolUseId` is durable right now (on disk, or in the store). */
  durable(toolUseId: string): boolean;
  /** Every event kind the backend holds for the session (entries and others). */
  kinds(): Promise<string[]>;
  close(): Promise<void>;
}

let root: string;
let cwd: string;
let fake: FakeSessionStore | undefined;
const open: RemoteStore[] = [];

beforeEach(() => {
  root = join(tmpdir(), `yodex-resume-${crypto.randomUUID()}`);
  cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => {});
  await fake?.stop();
  fake = undefined;
  rmSync(root, { recursive: true, force: true });
});

function local(): Backend {
  const dir = join(root, "store");
  return {
    store: new LocalStore(dir),
    reopen: async () => new LocalStore(dir),
    durable: (id) => {
      const f = join(dir, "logs", "s1.events.jsonl");
      return existsSync(f) && readFileSync(f, "utf8").includes(id);
    },
    kinds: async () => {
      const s = new LocalStore(dir);
      const entries = (await s.conversation.read("s1")).map((e) => e.payload.type);
      const events = (await s.logs.read("s1", "events")).map((r) => String(r.kind));
      return [...entries, ...events];
    },
    close: async () => {},
  };
}

async function remoteOn(f: FakeSessionStore, opts: { maxEventBytes?: number } = {}): Promise<RemoteStore> {
  const g = f.grant("s1", { ttlS: 60 });
  const client = new SessionStoreClient({ baseUrl: f.url, tokenProvider: () => g.token });
  const lease = new LeaseKeeper({ client, sid: "s1", ttlS: 60 });
  lease.adopt({ leaseId: g.leaseId });
  const store = new RemoteStore({ client, sid: "s1", lease, memory, artifactsDir: join(root, "artifacts"), ...opts });
  await store.open();
  open.push(store);
  return store;
}

async function remote(opts: { maxEventBytes?: number } = {}): Promise<Backend> {
  const f = startFakeSessionStore();
  fake = f;
  f.createSession("s1");
  const first = await remoteOn(f, opts);
  return {
    store: first,
    // A new engine: the old one's writes are all in the store; its lease is given back first.
    reopen: async (o = {}) => {
      for (const s of open.splice(0)) await s.close();
      return remoteOn(f, o);
    },
    durable: (id) => f.events("s1").some((e) => e.kind === "tool_started" && (e.data as { toolUseId?: string }).toolUseId === id),
    kinds: async () => f.events("s1").map((e) => e.kind),
    close: async () => {},
  };
}

const backends: [string, () => Promise<Backend>][] = [
  ["LocalStore", async () => local()],
  ["RemoteStore", () => remote()],
];

/** A tool with an effect: counts its runs. */
function counting() {
  const runs: string[] = [];
  const tool = defineTool({
    name: "Count",
    description: "counts",
    readOnly: false,
    executes: true,
    schema: z.object({}),
    call: async () => {
      runs.push("call");
      return { content: String(runs.length) };
    },
  });
  return { tool, runs };
}

function session(store: Store, model: ModelClient, tools: ToolRegistry, extra: Partial<AgentConfig> = {}): AgentSession {
  return new AgentSession({
    agentId: "ag1",
    sessionId: "s1",
    workspace: "w",
    cwd,
    model: "test",
    systemPrompt: "test",
    tools,
    store,
    model_client: model,
    canUseTool: createPolicy({ mode: "autopilot" }),
    ...extra,
  });
}

function registry(...tools: ReturnType<typeof defineTool<Record<string, never>>>[]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t as never);
  return r;
}

async function drain<R>(gen: AsyncGenerator<EngineEvent, R, void>): Promise<{ events: EngineEvent[]; value: R }> {
  const events: EngineEvent[] = [];
  for (;;) {
    const n = await gen.next();
    if (n.done) return { events, value: n.value };
    events.push(n.value);
  }
}

/** The state a dead engine leaves: a turn whose assistant asked for `Count` (tu1), and, when
 *  `started`, the marker that the tool began; no result. */
async function deadMidTool(store: Store, started: boolean): Promise<void> {
  const sys = await store.conversation.append("s1", { type: "system", subtype: "init", sessionId: "s1", agentId: "ag1", model: "test", cwd, ts: "t0" } as SDKMessage, null);
  const user = await store.conversation.append("s1", { type: "user", message: { role: "user", content: "count once" }, author: HUMAN, ts: "t1" } as SDKMessage, sys.uuid);
  await store.conversation.append(
    "s1",
    { type: "assistant", message: toolUse("tu1", "Count").message, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use", model: "test", ts: "t2" } as SDKMessage,
    user.uuid,
  );
  if (started) await store.appendEvent!("s1", "tool_started", { toolUseId: "tu1", name: "Count", ts: "t3" });
  await store.flush?.();
}

for (const [name, make] of backends) {
  describe(`resume and the side-effect key (${name})`, () => {
    test("a tool with an effect leaves a tool_started marker, durable before the tool runs", async () => {
      const b = await make();
      const order: string[] = [];
      let durableAtCall = false;
      const tool = defineTool({
        name: "Count",
        description: "counts",
        readOnly: false,
        executes: true,
        schema: z.object({}),
        call: async () => {
          durableAtCall = b.durable("tu1");
          order.push("call");
          return { content: "1" };
        },
      });
      const store = b.store;
      const appendEvent = store.appendEvent!.bind(store);
      store.appendEvent = async (sid, kind, data) => {
        order.push(`event:${kind}`);
        const stored = await appendEvent(sid, kind, data);
        order.push(`stored:${kind}`);
        return stored;
      };
      await drain(session(store, new ScriptedModel([toolUse("tu1", "Count"), textDone("done")]), registry(tool)).run({ text: "count" }));
      expect(order).toEqual(["event:tool_started", "stored:tool_started", "call"]);
      // Only a backend that can resume promises durability: the remote one resolves on the store's ack.
      if (name === "RemoteStore") expect(durableAtCall).toBe(true);
      expect(await store.readEvents!("s1", "tool_started")).toEqual([expect.objectContaining({ toolUseId: "tu1", name: "Count" })]);
    });

    test("a read-only tool leaves no marker", async () => {
      const b = await make();
      const peek = defineTool({ name: "Peek", description: "reads", readOnly: true, schema: z.object({}), call: async () => ({ content: "seen" }) });
      await drain(session(b.store, new ScriptedModel([toolUse("tu1", "Peek"), textDone("done")]), registry(peek)).run({ text: "peek" }));
      expect(await b.store.readEvents!("s1", "tool_started")).toEqual([]);
    });

    test("resume, started: the tool is never re-run; an interrupted result is persisted and the turn ends", async () => {
      const b = await make();
      await deadMidTool(b.store, true);
      const { tool, runs } = counting();
      const store = await b.reopen();
      const model = new ScriptedModel([textDone("checked; done")]);
      const { events, value } = await drain(session(store, model, registry(tool)).resume());
      expect(value).toEqual({ resumed: true });
      expect(runs).toEqual([]);
      const tr = events.find((e) => e.type === "tool_result");
      expect(tr).toMatchObject({ toolUseId: "tu1", isError: true, content: INTERRUPTED_TOOL_RESULT });
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
      const entries = await store.conversation.read("s1");
      expect(entries.map((e) => e.payload.type)).toEqual(["system", "user", "assistant", "tool_result", "assistant", "result"]);
      expect(model.seen).toHaveLength(1);
      const sent = JSON.stringify(model.seen[0]!.messages);
      expect(sent).toContain(INTERRUPTED_TOOL_RESULT);
      // A real entry now: nothing left for the in-memory healer to synthesize.
      expect(JSON.stringify(await loadMessages(store, "s1"))).not.toContain("no result recorded");
    });

    test("resume, never started: the tool runs once, its result is persisted, the turn ends", async () => {
      const b = await make();
      await deadMidTool(b.store, false);
      const { tool, runs } = counting();
      const store = await b.reopen();
      const { events, value } = await drain(session(store, new ScriptedModel([textDone("done")]), registry(tool)).resume());
      expect(value).toEqual({ resumed: true });
      expect(runs).toEqual(["call"]);
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ toolUseId: "tu1", isError: false, content: "1" });
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
      expect(await store.readEvents!("s1", "tool_started")).toEqual([expect.objectContaining({ toolUseId: "tu1" })]);
      expect((await store.conversation.read("s1")).filter((e) => e.payload.type === "user")).toHaveLength(1);
    });

    test("resume settles only the unanswered calls of the head: an answered one is kept, a started one is not re-run", async () => {
      const b = await make();
      const sys = await b.store.conversation.append("s1", { type: "system", subtype: "init", sessionId: "s1", agentId: "ag1", model: "test", cwd, ts: "t0" } as SDKMessage, null);
      const user = await b.store.conversation.append("s1", { type: "user", message: { role: "user", content: "two" }, author: HUMAN, ts: "t1" } as SDKMessage, sys.uuid);
      const both = { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "tu1", name: "Count", input: {} }, { type: "tool_use" as const, id: "tu2", name: "Count", input: {} }] };
      const asst = await b.store.conversation.append("s1", { type: "assistant", message: both, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use", model: "test", ts: "t2" } as SDKMessage, user.uuid);
      await b.store.appendEvent!("s1", "tool_started", { toolUseId: "tu1", name: "Count", ts: "t3" });
      await b.store.conversation.append("s1", { type: "tool_result", toolUseId: "tu1", toolName: "Count", content: "1", isError: false, ts: "t4" } as SDKMessage, asst.uuid);
      await b.store.appendEvent!("s1", "tool_started", { toolUseId: "tu2", name: "Count", ts: "t5" });
      await b.store.flush?.();
      const { tool, runs } = counting();
      const store = await b.reopen();
      const model = new ScriptedModel([textDone("done")]);
      const { events } = await drain(session(store, model, registry(tool)).resume());
      expect(runs).toEqual([]);
      expect(events.filter((e) => e.type === "tool_result")).toEqual([expect.objectContaining({ toolUseId: "tu2", content: INTERRUPTED_TOOL_RESULT })]);
      const sent = model.seen[0]!.messages.at(-1)!;
      expect((sent.content as { tool_use_id: string }[]).map((b) => b.tool_use_id)).toEqual(["tu1", "tu2"]);
    });

    /** A turn whose model call answered without a tool call; only the run's end was lost. A trailing
     *  sub-agent entry, when `subagent`, sits after the answer. */
    async function deadAfterAnswer(store: Store, opts: { subagent?: boolean; seeded?: boolean; onlySystem?: boolean; cutOff?: boolean } = {}): Promise<void> {
      let at = (await store.conversation.append("s1", { type: "system", subtype: "init", sessionId: "s1", agentId: "ag1", model: "test", cwd, ts: "t0" } as SDKMessage, null)).uuid;
      if (opts.seeded) at = (await store.conversation.append("s1", { type: "user", message: { role: "user", content: "seeded context" }, author: { type: "system" }, ts: "t1" } as SDKMessage, at)).uuid;
      const author = opts.onlySystem ? { type: "system" } : opts.seeded ? { type: "agent", id: "peer-1" } : HUMAN;
      at = (await store.conversation.append("s1", { type: "user", message: { role: "user", content: "hi" }, author, ts: "t1" } as SDKMessage, at)).uuid;
      at = (
        await store.conversation.append(
          "s1",
          { type: "assistant", message: textDone("hello").message, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: opts.cutOff ? "max_tokens" : "end_turn", model: "test", ts: "t2" } as SDKMessage,
          at,
        )
      ).uuid;
      if (opts.subagent) {
        await store.conversation.append("s1", { type: "subagent", kind: "end", toolUseId: "tu9", childSessionId: "c1", description: "child", background: true, outcome: "success", ts: "t3" } as SDKMessage, at);
      }
      await store.flush?.();
    }

    test("resume, the model had answered: the turn ends through the normal end-of-turn path, with no second model call", async () => {
      const b = await make();
      await deadAfterAnswer(b.store);
      const { tool } = counting();
      const hooks = new HookEngine();
      const stops: number[] = [];
      hooks.register(new FunctionHook("verifier", ["Stop"], (input) => (stops.push(input.event === "Stop" ? input.numTurns : -1), {})));
      const store = await b.reopen();
      const model = new ScriptedModel([]);
      const { events, value } = await drain(session(store, model, registry(tool), { hooks }).resume());
      expect(value).toEqual({ resumed: true });
      expect(model.seen).toHaveLength(0);
      expect(stops).toEqual([1]); // the Stop verifier ran, as at the end of a live turn
      expect(events.map((e) => e.type)).toEqual(["result"]);
      expect((await store.conversation.read("s1")).map((e) => e.payload.type)).toEqual(["system", "user", "assistant", "result"]);
    });

    test("resume, the model had answered and the Stop verifier fails it: the turn goes on as a live one would", async () => {
      const b = await make();
      await deadAfterAnswer(b.store);
      const { tool } = counting();
      const hooks = new HookEngine();
      let calls = 0;
      hooks.register(new FunctionHook("verifier", ["Stop"], () => (calls++ === 0 ? { block: true, reason: "the answer is incomplete" } : {})));
      const store = await b.reopen();
      const model = new ScriptedModel([textDone("hello, complete")]);
      const { events } = await drain(session(store, model, registry(tool), { hooks }).resume());
      expect(model.seen).toHaveLength(1); // the continuation the verifier asked for, not a redo of the answer
      const sent = model.seen[0]!.messages;
      expect(sent.at(-2)).toMatchObject({ role: "assistant" });
      expect(JSON.stringify(sent.at(-1))).toContain("[Verification] the answer is incomplete");
      expect(events.map((e) => e.type)).toEqual(["user", "assistant", "result"]);
    });

    test("resume looks past a trailing sub-agent entry to the head's answer", async () => {
      const b = await make();
      await deadAfterAnswer(b.store, { subagent: true });
      const { tool } = counting();
      const store = await b.reopen();
      const model = new ScriptedModel([]);
      const { events } = await drain(session(store, model, registry(tool)).resume());
      expect(model.seen).toHaveLength(0);
      expect(events.map((e) => e.type)).toEqual(["result"]);
    });

    test("the resumed run is its asker's: its author skips a system-seeded turn, and its records carry the prompt", async () => {
      const b = await make();
      await deadAfterAnswer(b.store, { seeded: true });
      const { tool } = counting();
      const outcomes: unknown[] = [];
      const store = await b.reopen();
      await drain(
        session(store, new ScriptedModel([]), registry(tool), {
          telemetry: { hop: { name: "h", version: "1" }, repo: "r", role: "main", emit: (e) => void outcomes.push(e) },
        }).resume(),
      );
      await store.flush?.();
      const records = await store.logs.read("s1", "events");
      const start = records.find((r) => r.kind === "run.start")!;
      const end = records.find((r) => r.kind === "run.end")!;
      expect(start).toMatchObject({ author: "agent", resumed: true }); // the peer that asked, not the seed
      expect(typeof start.prompt).toBe("string");
      expect(end.prompt).toBe(start.prompt);
      expect(outcomes).toHaveLength(1);
    });

    test("the resumed result counts the turn's model calls before the restart", async () => {
      const b = await make();
      await deadMidTool(b.store, true); // its assistant entry spent 1 + 1 tokens
      const { tool } = counting();
      const store = await b.reopen();
      const { events } = await drain(session(store, new ScriptedModel([textDone("done")]), registry(tool)).resume());
      expect(events.at(-1)).toMatchObject({ type: "result", usage: { input_tokens: 9, output_tokens: 5 } }); // 1 + 8, 1 + 4
    });

    test("the answered iteration is not compacted first", async () => {
      const b = await make();
      // An earlier finished turn to summarize, then the dead one's answered turn.
      let at = (await b.store.conversation.append("s1", { type: "system", subtype: "init", sessionId: "s1", agentId: "ag1", model: "test", cwd, ts: "t0" } as SDKMessage, null)).uuid;
      at = (await b.store.conversation.append("s1", { type: "user", message: { role: "user", content: "first" }, author: HUMAN, ts: "t1" } as SDKMessage, at)).uuid;
      at = (await b.store.conversation.append("s1", { type: "assistant", message: textDone("one").message, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn", model: "test", ts: "t2" } as SDKMessage, at)).uuid;
      at = (await b.store.conversation.append("s1", { type: "result", subtype: "success", numTurns: 1, usage: { input_tokens: 1, output_tokens: 1 }, ts: "t3" } as SDKMessage, at)).uuid;
      at = (await b.store.conversation.append("s1", { type: "user", message: { role: "user", content: "hi" }, author: HUMAN, ts: "t4" } as SDKMessage, at)).uuid;
      await b.store.conversation.append("s1", { type: "assistant", message: textDone("hello").message, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn", model: "test", ts: "t5" } as SDKMessage, at);
      await b.store.flush?.();
      const { tool } = counting();
      const store = await b.reopen();
      const model = new ScriptedModel([]);
      // A window this small is over budget at once: any compaction check here would summarize the first turn.
      const tight = { maxTokens: 100, contextWindow: 1600, compaction: { enabled: true, keepRecentTurns: 1 } };
      const { events } = await drain(session(store, model, registry(tool), tight).resume());
      expect(model.seen).toHaveLength(0);
      expect(events.map((e) => e.type)).toEqual(["result"]);
      expect((await store.conversation.read("s1")).some((e) => e.payload.type === "compact")).toBe(false);
    });

    test("the answered iteration gets no memory-checkpoint nudge", async () => {
      const b = await make();
      await deadAfterAnswer(b.store);
      const { tool } = counting();
      const store = await b.reopen();
      const { events } = await drain(session(store, new ScriptedModel([]), registry(tool), { memoryCheckpoint: { everyTurns: 1, nudge: () => "checkpoint now" } }).resume());
      expect(events.map((e) => e.type)).toEqual(["result"]);
      expect(JSON.stringify(await store.conversation.read("s1"))).not.toContain("checkpoint now");
    });

    test("a resumed answer cut off at max_tokens gets the continuation, as a live one does", async () => {
      const b = await make();
      await deadAfterAnswer(b.store, { cutOff: true });
      const { tool } = counting();
      const store = await b.reopen();
      const model = new ScriptedModel([textDone("…and the rest")]);
      const { events } = await drain(session(store, model, registry(tool)).resume());
      expect(model.seen).toHaveLength(1);
      const notes = (await store.conversation.read("s1")).filter((e) => e.payload.type === "user" && JSON.stringify(e.payload).includes("[Output limit]"));
      expect(notes).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success", numTurns: 2 });
    });

    test("a turn whose every user entry is system-seeded resumes with the human as its author", async () => {
      const b = await make();
      await deadAfterAnswer(b.store, { onlySystem: true });
      const { tool } = counting();
      const store = await b.reopen();
      await drain(session(store, new ScriptedModel([]), registry(tool)).resume());
      await store.flush?.();
      const start = (await store.logs.read("s1", "events")).find((r) => r.kind === "run.start")!;
      expect(start.author).toBe("human");
    });

    test("a hook-blocked or a denied call leaves no marker", async () => {
      const b = await make();
      const { tool, runs } = counting();
      const hooks = new HookEngine();
      hooks.register(new FunctionHook("block", ["PreToolUse"], () => ({ block: true, reason: "no" })));
      await drain(session(b.store, new ScriptedModel([toolUse("tu1", "Count"), textDone("done")]), registry(tool), { hooks }).run({ text: "count" }));
      await drain(
        session(b.store, new ScriptedModel([toolUse("tu2", "Count"), textDone("done")]), registry(tool), { canUseTool: async () => ({ behavior: "deny", reason: "nope" }) }).run({ text: "again" }),
      );
      expect(await b.store.readEvents!("s1", "tool_started")).toEqual([]);
      expect(runs).toEqual([]);
    });

    test("resume, nothing in flight: no events, no writes, no model call", async () => {
      const b = await make();
      const { tool } = counting();
      await drain(session(b.store, new ScriptedModel([textDone("hi")]), registry(tool)).run({ text: "hello" }));
      await b.store.flush?.();
      const store = await b.reopen();
      const before = await b.kinds();
      const model = new ScriptedModel([]);
      const { events, value } = await drain(session(store, model, registry(tool)).resume());
      expect(value).toEqual({ resumed: false });
      expect(events).toEqual([]);
      expect(model.seen).toHaveLength(0);
      await store.flush?.();
      expect(await b.kinds()).toEqual(before);
    });

    test("resume, died mid model call: the model is called from the user turn, and no new user entry is written", async () => {
      const b = await make();
      const sys = await b.store.conversation.append("s1", { type: "system", subtype: "init", sessionId: "s1", agentId: "ag1", model: "test", cwd, ts: "t0" } as SDKMessage, null);
      await b.store.conversation.append("s1", { type: "user", message: { role: "user", content: "say hi" }, author: HUMAN, ts: "t1" } as SDKMessage, sys.uuid);
      await b.store.flush?.();
      const { tool } = counting();
      const store = await b.reopen();
      const model = new ScriptedModel([textDone("hi")]);
      const { events, value } = await drain(session(store, model, registry(tool)).resume());
      expect(value).toEqual({ resumed: true });
      expect(model.seen).toHaveLength(1);
      expect(events.map((e) => e.type)).toEqual(["assistant", "result"]);
      expect((await store.conversation.read("s1")).map((e) => e.payload.type)).toEqual(["system", "user", "assistant", "result"]);
    });

    test("a hook failure the run survives leaves no error entry", async () => {
      const b = await make();
      const { tool } = counting();
      const hooks = new HookEngine();
      hooks.register(new FunctionHook("boom", ["PostToolUse"], () => { throw new Error("hook broke"); }));
      const { events } = await drain(session(b.store, new ScriptedModel([toolUse("tu1", "Count"), textDone("done")]), registry(tool), { hooks }).run({ text: "count" }));
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
      await b.store.flush?.();
      expect(await b.kinds()).not.toContain("error");
    });
  });
}

describe("the side-effect key on the remote store", () => {
  test("a marker the store refuses (lease lost) stops the tool: it never runs", async () => {
    const b = await remote();
    const { tool, runs } = counting();
    const store = b.store;
    const appendEvent = store.appendEvent!.bind(store);
    store.appendEvent = async (sid, kind, data) => (fake!.failNext("append", 409, "lease_lost"), appendEvent(sid, kind, data));
    const err = await drain(session(store, new ScriptedModel([toolUse("tu1", "Count"), textDone("done")]), registry(tool)).run({ text: "count" })).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(runs).toEqual([]);
  });
});

describe("an oversize tool result", () => {
  const big = () => defineTool({ name: "Big", description: "big", readOnly: true, schema: z.object({}), call: async () => ({ content: "x".repeat(100 * 1024) }) });

  test("on a store with a 64 KiB event limit becomes an error result naming the sizes, and the turn goes on", async () => {
    const b = await remote({ maxEventBytes: 64 * 1024 });
    const model = new ScriptedModel([toolUse("tu1", "Big"), textDone("smaller then")]);
    const { events } = await drain(session(b.store, model, registry(big())).run({ text: "read it" }));
    const tr = events.find((e) => e.type === "tool_result") as { isError: boolean; content: string };
    expect(tr.isError).toBe(true);
    expect(tr.content).toMatch(/^the tool's result of 0\.1 MiB exceeds the session store's event limit of 0\.06 MiB; read a smaller range or write it to a file$/);
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    expect(JSON.stringify(model.seen[1]!.messages)).toContain("exceeds the session store's event limit");
    const stored = (await b.store.conversation.read("s1")).find((e) => e.payload.type === "tool_result")!.payload as { content: string };
    expect(stored.content).toBe(tr.content);
  });

  test("with the store's limit not configured, the store's 413 still swaps the result before the model or the stream sees it", async () => {
    const f = startFakeSessionStore({ maxEventBytes: 1536 * 1024 });
    fake = f;
    f.createSession("s1");
    const store = await remoteOn(f);
    const huge = defineTool({ name: "Big", description: "big", readOnly: true, schema: z.object({}), call: async () => ({ content: "x".repeat(2 * 1024 * 1024) }) });
    const model = new ScriptedModel([toolUse("tu1", "Big"), textDone("smaller then")]);
    const { events } = await drain(session(store, model, registry(huge)).run({ text: "read it" }));
    const tr = events.find((e) => e.type === "tool_result") as { isError: boolean; content: string };
    expect(tr.isError).toBe(true);
    expect(tr.content).toBe("the tool's result of 2 MiB exceeds the session store's event limit of 1.5 MiB; read a smaller range or write it to a file");
    expect(JSON.stringify(model.seen[1]!.messages).length).toBeLessThan(100_000);
    expect(JSON.stringify(model.seen[1]!.messages)).toContain("exceeds the session store's event limit");
    await store.flush();
    const stored = f.events("s1").filter((e) => e.kind === "tool_result");
    expect(stored).toHaveLength(1);
    expect((stored[0]!.data as { payload: { content: string } }).payload.content).toBe(tr.content);
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
  });

  test("on LocalStore is stored whole", async () => {
    const b = local();
    await drain(session(b.store, new ScriptedModel([toolUse("tu1", "Big"), textDone("ok")]), registry(big())).run({ text: "read it" }));
    const stored = (await b.store.conversation.read("s1")).find((e) => e.payload.type === "tool_result")!.payload as { content: string; isError: boolean };
    expect(stored.isError).toBe(false);
    expect(stored.content.length).toBeGreaterThanOrEqual(100 * 1024);
  });
});
