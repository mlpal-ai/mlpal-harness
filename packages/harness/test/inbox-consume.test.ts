/**
 * P1 1.2 consume rules on the engine's writer (INBOX spec §3.6, I4), and an inbox turn's opening entry:
 * 1. isolated: everything queued before goes first; the consuming batch holds only its own events, opening event first;
 * 2. awaited: the consume resolves once the store acknowledged it, and the turn writes nothing before;
 * 3. non-fatal 409: `inbox_item_not_pending` rejects the consume with InboxItemNotPendingError, writes nothing, and the
 *    writer goes on.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@mlpal/harness-protocol";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { AgentSession, type AgentConfig } from "../src/loop/agent";
import { SessionEventBus } from "../src/events/session-bus";
import { createPolicy } from "../src/permission/engine";
import { AppendBatcher } from "../src/store/remote/batcher";
import { type EncodedEvent, InboxFullError, InboxItemNotPendingError, type InboxConsume, SessionStoreClient, StoreHttpError, type StoredEvent } from "../src/store/remote/client";
import { LeaseKeeper } from "../src/store/remote/lease";
import { RemoteStore } from "../src/store/remote/remote-store";
import type { MemoryStore } from "../src/store/types";
import { ToolRegistry } from "../src/tools/registry";

interface Sent {
  afterSeq: number;
  kinds: string[];
  consumes?: InboxConsume;
}

/** A store client that acknowledges appends in order, refuses a consume of an item in `withdrawn`, and records each
 *  batch as sent. */
function stub(o: { withdrawn?: Set<string>; events?: StoredEvent[] } = {}) {
  const sent: Sent[] = [];
  let last = o.events?.at(-1)?.seq ?? 0;
  const client = {
    readAll: async () => ({ events: o.events ?? [], lastSeq: last }),
    appendEncoded: async (_sid: string, req: { leaseId: string; afterSeq: number; events: EncodedEvent[]; consumes?: InboxConsume }) => {
      sent.push({ afterSeq: req.afterSeq, kinds: req.events.map((e) => e.kind), ...(req.consumes ? { consumes: req.consumes } : {}) });
      await new Promise((r) => setTimeout(r, 5));
      if (req.consumes && o.withdrawn?.has(req.consumes.requestId)) {
        throw new InboxItemNotPendingError("session store append (s1): 409 inbox_item_not_pending", 409, "inbox_item_not_pending", "rejected");
      }
      const first = last + 1;
      last += req.events.length;
      return { firstSeq: first, lastSeq: last };
    },
  };
  return { client, sent };
}

describe("AppendBatcher.consume (P1 1.2 I4)", () => {
  test("isolated: what was queued before goes first, the consuming batch alone with its consumes, what follows after", async () => {
    const s = stub();
    const b = new AppendBatcher({ client: s.client, sid: "s1", leaseId: () => "L", afterSeq: 0 });
    void b.append("done", { tail: true });
    void b.append("record", { mode: "manual" });
    const consumed = b.consume([{ kind: "user", json: '{"uuid":"u1"}', bytes: 13, ts_ms: 1 }], { requestId: "rq-1", outcome: "turn" });
    void b.append("text_delta", { after: true });
    expect(await consumed).toEqual([3]);
    await b.flush();
    expect(s.sent.map((x) => x.kinds)).toEqual([["done", "record"], ["user"], ["text_delta"]]);
    expect(s.sent[1]).toMatchObject({ afterSeq: 2, consumes: { requestId: "rq-1", outcome: "turn" } });
    expect(s.sent[0]!.consumes).toBeUndefined();
    expect(s.sent[2]!.consumes).toBeUndefined();
  });

  test("non-fatal 409: a withdrawn item rejects the consume with InboxItemNotPendingError; the writer goes on, nothing advanced", async () => {
    const s = stub({ withdrawn: new Set(["rq-2"]) });
    const fatals: Error[] = [];
    const b = new AppendBatcher({ client: s.client, sid: "s1", leaseId: () => "L", afterSeq: 0, onFatal: (e) => fatals.push(e) });
    const err = await b.consume([{ kind: "user", json: '{"uuid":"u2"}', bytes: 13, ts_ms: 1 }], { requestId: "rq-2", outcome: "turn" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboxItemNotPendingError);
    expect((err as InboxItemNotPendingError).state).toBe("rejected");
    expect(fatals).toEqual([]);
    expect(b.fatal).toBeNull();
    expect(await b.append("user", { next: true })).toBe(1);
    expect(s.sent.at(-1)).toMatchObject({ afterSeq: 0, kinds: ["user"] });
  });

  test("the client maps 409 inbox_item_not_pending to the typed error, and sends consumes on the wire", async () => {
    const bodies: string[] = [];
    const client = new SessionStoreClient({
      baseUrl: "http://store.test/v1",
      tokenProvider: () => "t",
      fetch: async (_url, init) => {
        bodies.push(String(init.body));
        return new Response(JSON.stringify({ code: "inbox_item_not_pending", state: "consumed" }), { status: 409 });
      },
    });
    const err = await client
      .appendEncoded("s1", { leaseId: "L", afterSeq: 4, events: [{ kind: "user", json: "{}", bytes: 2, ts_ms: 1 }], consumes: { requestId: "rq-9", outcome: "turn" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InboxItemNotPendingError);
    expect((err as InboxItemNotPendingError).state).toBe("consumed");
    expect(JSON.parse(bodies[0]!)).toMatchObject({ after_seq: 4, consumes: { request_id: "rq-9", outcome: "turn" } });
  });

  test("the head read: 200 is the item, 204 is null; `answers` asks for that ask's answer", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let n = 0;
    const client = new SessionStoreClient({
      baseUrl: "http://store.test/v1",
      tokenProvider: () => "t",
      fetch: async (url, init) => {
        calls.push({ url, body: String(init.body) });
        if (n++ === 1) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ request_id: "rq-1", kind: "turn", inbox_seq: 1, message: { type: "run", prompt: "hi" }, context_sha256: "a".repeat(64), accepted_at_ms: 5, attempts: 1 }), { status: 200 });
      },
    });
    expect(await client.inboxHead("s1")).toEqual({ requestId: "rq-1", kind: "turn", inboxSeq: 1, message: { type: "run", prompt: "hi" }, contextSha256: "a".repeat(64), acceptedAtMs: 5, attempts: 1 });
    expect(await client.inboxHead("s1", "ask:toolu_1")).toBeNull();
    expect(calls.map((c) => [c.url, JSON.parse(c.body)])).toEqual([
      ["http://store.test/v1/sessions/s1/inbox/head", {}],
      ["http://store.test/v1/sessions/s1/inbox/head", { answers: "ask:toolu_1" }],
    ]);
  });
});

const memory: MemoryStore = { readIndex: async () => "", writeTopic: async () => {}, readTopic: async () => null, listTopics: async () => [] };

async function remoteStore(s: ReturnType<typeof stub>, root: string): Promise<RemoteStore> {
  const lease = new LeaseKeeper({ client: new SessionStoreClient({ baseUrl: "http://x/v1", tokenProvider: () => "t" }), sid: "s1", ttlS: 60 });
  lease.adopt({ leaseId: "L" });
  const store = new RemoteStore({ client: s.client, sid: "s1", lease, memory, artifactsDir: root });
  await store.open();
  return store;
}

function answering(text: string): ModelClient {
  return {
    async *stream(): AsyncGenerator<never, ModelResult, void> {
      return { model: "test", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" };
    },
  };
}

function session(store: RemoteStore, root: string, model: ModelClient, extra: Partial<AgentConfig> = {}): AgentSession {
  return new AgentSession({ agentId: "a", sessionId: "s1", workspace: "w", cwd: root, model: "test", systemPrompt: "t", tools: new ToolRegistry(), store, model_client: model, canUseTool: createPolicy({ mode: "autopilot" }), ...extra });
}

describe("an inbox turn's opening entry (P2 1.1)", () => {
  test("the user entry is the consuming batch's only event, acknowledged before the model is called", async () => {
    const root = join(tmpdir(), `inbox-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    try {
      const s = stub();
      const store = await remoteStore(s, root);
      let calledAfter = -1;
      const model: ModelClient = {
        async *stream(): AsyncGenerator<never, ModelResult, void> {
          calledAfter = s.sent.findIndex((x) => x.consumes !== undefined);
          return { model: "test", message: { role: "assistant", content: [{ type: "text", text: "pong" }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" };
        },
      };
      const events: EngineEvent[] = [];
      for await (const e of session(store, root, model).run({ text: "ping", requestId: "rq-1", consumes: { requestId: "rq-1", outcome: "turn" } })) events.push(e);
      await store.flush();
      const consuming = s.sent.find((x) => x.consumes);
      expect(consuming).toEqual({ afterSeq: expect.any(Number), kinds: ["user"], consumes: { requestId: "rq-1", outcome: "turn" } });
      expect(calledAfter).toBeGreaterThanOrEqual(0);
      expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
      expect((await store.conversation.read("s1")).map((e) => e.payload.type)).toEqual(["system", "user", "assistant", "result"]);
      // The opening entry carries the item's request id (P2 1.1).
      expect((await store.conversation.read("s1")).find((e) => e.payload.type === "user")!.payload).toMatchObject({ requestId: "rq-1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a withdrawn item: the run rejects with InboxItemNotPendingError, no model call, and no user entry is kept", async () => {
    const root = join(tmpdir(), `inbox-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    try {
      const s = stub({ withdrawn: new Set(["rq-2"]) });
      const store = await remoteStore(s, root);
      const bus = new SessionEventBus(store);
      let calls = 0;
      const model: ModelClient = {
        async *stream(): AsyncGenerator<never, ModelResult, void> {
          calls++;
          return { model: "test", message: { role: "assistant", content: [{ type: "text", text: "never" }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" };
        },
      };
      const run = async () => {
        for await (const _ of session(store, root, model, { events: bus }).run({ text: "do X", consumes: { requestId: "rq-2", outcome: "turn" } })) void _;
      };
      await expect(run()).rejects.toBeInstanceOf(InboxItemNotPendingError);
      expect(calls).toBe(0);
      // The withdrawn run left no subscription behind: the session does not read as running.
      expect(bus.isSubscribed("s1")).toBe(false);
      expect((await store.conversation.read("s1")).map((e) => e.payload.type)).not.toContain("user");
      // The writer is live: the next item's turn runs.
      for await (const _ of session(store, root, answering("ok")).run({ text: "next", consumes: { requestId: "rq-3", outcome: "turn" } })) void _;
      await store.flush();
      expect((await store.conversation.read("s1")).filter((e) => e.payload.type === "user")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a store-closed turn (P1 1.2 closing entry)", () => {
  test("the store's closing `error` entry ends the turn: nothing is in flight, and history heals the unanswered call", async () => {
    const { inFlightTurn } = await import("../src/loop/agent");
    const { effectiveEntries, loadMessages } = await import("../src/loop/messages");
    const root = join(tmpdir(), `inbox-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    try {
      const entry = (seq: number, uuid: string, parentUuid: string | null, payload: Record<string, unknown>): StoredEvent => ({ seq, kind: String(payload.type), data: { uuid, parentUuid, ts: "2026-10-31T00:00:00.000Z", payload }, ts_ms: seq });
      const events: StoredEvent[] = [
        entry(1, "u1", null, { type: "user", message: { role: "user", content: "run it" }, ts: "t" }),
        entry(2, "a1", "u1", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 9" } }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use", model: "m", ts: "t" }),
        { seq: 3, kind: "tool_started", data: { toolUseId: "tu1", name: "Bash" }, ts_ms: 3 },
        // As the store authors it in the lease-free work (P1 1.2 "Store-authored events").
        entry(4, "e1", "a1", { type: "error", message: "the turn was stopped", code: "turn_stopped", ts: "2026-10-31T00:00:01.000Z" }),
      ];
      const store = await remoteStore(stub({ events }), root);
      expect(inFlightTurn(effectiveEntries(await store.conversation.read("s1")))).toEqual([]);
      const messages = await loadMessages(store, "s1");
      expect(JSON.stringify(messages)).toContain("no result recorded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("SessionStoreClient.acceptTurn (P1 1.2 accept, the instance writer's turn)", () => {
  const sha = (t: string) => new Bun.CryptoHasher("sha256").update(t).digest("hex");
  function client(answer: (body: Record<string, unknown>) => Response) {
    const calls: Array<{ url: string; method: string; body: string }> = [];
    const c = new SessionStoreClient({
      baseUrl: "http://store/v1",
      tokenProvider: () => "W",
      fetch: async (url, init) => {
        calls.push({ url, method: String(init.method), body: String(init.body) });
        return answer(JSON.parse(String(init.body)));
      },
    });
    return { c, calls };
  }

  test("sends a turn item, never pumpable, with the sha of the exact message bytes, and no context (W-1)", async () => {
    const { c, calls } = client(() => Response.json({ request_id: "rq-ui", kind: "turn", state: "pending", inbox_seq: 4, replayed: false, pending: 2, position: 2, lease: { holder: "engine:sp:1" } }));
    const message = '{"type":"run","sessionId":"s1","prompt":"go"}';
    const a = await c.acceptTurn("s1", { requestId: "rq-ui", message });
    expect(a).toEqual({ requestId: "rq-ui", state: "pending", inboxSeq: 4, replayed: false, pending: 2, position: 2, holder: "engine:sp:1" });
    expect(calls[0]!.url).toBe("http://store/v1/sessions/s1/inbox");
    const body = JSON.parse(calls[0]!.body);
    expect(body).toEqual({ request_id: "rq-ui", kind: "turn", pumpable: false, message: JSON.parse(message), message_sha256: sha(message) });
    expect(calls[0]!.body).toContain(`"message":${message}`);
  });

  test("a replay of an item no longer pending has a null position and its code", async () => {
    const { c } = client(() => Response.json({ request_id: "rq-ui", kind: "turn", state: "rejected", inbox_seq: 4, replayed: true, pending: 0, position: null, lease: null, code: "session_stopped" }));
    const a = await c.acceptTurn("s1", { requestId: "rq-ui", message: "{}" });
    expect(a).toEqual({ requestId: "rq-ui", state: "rejected", inboxSeq: 4, replayed: true, pending: 0, position: null, code: "session_stopped" });
  });

  test("a full inbox is InboxFullError with its counts and Retry-After, sent once", async () => {
    const { c, calls } = client(() => new Response(JSON.stringify({ code: "inbox_full", pending: 32, limit: 32 }), { status: 429, headers: { "retry-after": "5" } }));
    const err = await c.acceptTurn("s1", { requestId: "rq-ui", message: "{}" }).catch((e) => e);
    expect(err).toBeInstanceOf(InboxFullError);
    expect([err.code, err.pending, err.limit, err.retryAfterS]).toEqual(["inbox_full", 32, 32, 5]);
    expect(calls.length).toBe(1);
  });

  test("the same request id with another message is a typed 409, and a 403 stays a StoreHttpError", async () => {
    for (const [status, code] of [[409, "request_id_conflict"], [403, "forbidden"]] as const) {
      const { c } = client(() => new Response(JSON.stringify({ code }), { status }));
      const err = await c.acceptTurn("s1", { requestId: "rq-ui", message: "{}" }).catch((e) => e);
      expect(err).toBeInstanceOf(StoreHttpError);
      expect([err.status, err.code]).toEqual([status, code]);
    }
  });
});

describe("SessionStoreClient.inboxPending (P1 1.3 pending read, D-63)", () => {
  function client(answer: () => Response) {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const c = new SessionStoreClient({
      baseUrl: "http://store/v1",
      tokenProvider: () => "R",
      fetch: async (url, init) => {
        calls.push({ url, method: String(init.method), ...(init.body === undefined ? {} : { body: String(init.body) }) });
        return answer();
      },
    });
    return { c, calls };
  }

  test("reads the session's pending items in queue order; a writer's carries its message, control's none", async () => {
    // The store's fixture inbox-pending-200 (stack d63-pending-read).
    const { c, calls } = client(() =>
      Response.json({
        items: [
          { request_id: "rq-ui", kind: "turn", position: 1, inbox_seq: 1, accepted_by: "writer", accepted_at_ms: 1_760_000_000_000, message: { type: "run", sessionId: "s1", prompt: "Reply pong", origin: "api" } },
          { request_id: "rq-api", kind: "turn", position: 2, inbox_seq: 2, accepted_by: "control", accepted_at_ms: 1_760_000_000_000 },
        ],
      }),
    );
    expect(await c.inboxPending("s1")).toEqual([
      { requestId: "rq-ui", kind: "turn", position: 1, inboxSeq: 1, acceptedBy: "writer", acceptedAtMs: 1_760_000_000_000, message: { type: "run", sessionId: "s1", prompt: "Reply pong", origin: "api" } },
      { requestId: "rq-api", kind: "turn", position: 2, inboxSeq: 2, acceptedBy: "control", acceptedAtMs: 1_760_000_000_000 },
    ]);
    expect(calls).toEqual([{ url: "http://store/v1/sessions/s1/inbox?state=pending", method: "GET" }]);
  });

  test("an older store (no pending read) and a refusal stay typed StoreHttpErrors", async () => {
    for (const [status, code] of [[405, null], [404, "unknown_session"]] as const) {
      const { c } = client(() => new Response(code ? JSON.stringify({ code }) : "", { status }));
      const err = await c.inboxPending("s1").catch((e) => e);
      expect(err).toBeInstanceOf(StoreHttpError);
      expect(err.status).toBe(status);
    }
  });
});

describe("RemoteStore.consume with opening events (I-1)", () => {
  test("the opening events and the user entry go as one consuming batch, opening first", async () => {
    const s = stub();
    const b = new AppendBatcher({ client: s.client, sid: "s1", leaseId: () => "L", afterSeq: 0 });
    const seqs = await b.consume(
      [
        { kind: "question_answered", json: '{"id":"p1","outcome":"answered"}', bytes: 33, ts_ms: 1 },
        { kind: "user", json: '{"uuid":"u1"}', bytes: 13, ts_ms: 1 },
      ],
      { requestId: "rq-q", outcome: "answer" },
    );
    expect(seqs).toEqual([1, 2]);
    expect(s.sent).toEqual([{ afterSeq: 0, kinds: ["question_answered", "user"], consumes: { requestId: "rq-q", outcome: "answer" } }]);
  });
});

describe("RemoteStore.readEventsAt (store review r3)", () => {
  test("the events of the kinds asked, with their seqs, in seq order, read at open and acknowledged since", async () => {
    const root = join(tmpdir(), `harness-readat-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(root, { recursive: true });
    try {
      const s = stub({
        events: [
          { seq: 1, kind: "result", data: { uuid: "P" }, ts_ms: 1 },
          { seq: 2, kind: "log", data: { channel: "events", record: {} }, ts_ms: 1 },
          { seq: 3, kind: "ask_answered", data: { id: "P", decision: "allow" }, ts_ms: 1 },
        ],
      });
      const store = await remoteStore(s, root);
      await store.appendEvent("s1", "result", { uuid: "P" });
      await store.flush();
      expect(await store.readEventsAt("s1", ["result", "ask_answered"])).toEqual([
        { seq: 1, kind: "result", data: { uuid: "P" } },
        { seq: 3, kind: "ask_answered", data: { id: "P", decision: "allow" } },
        { seq: 4, kind: "result", data: { uuid: "P" } },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
