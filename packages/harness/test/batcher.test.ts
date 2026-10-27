import { describe, expect, test } from "bun:test";
import { AppendBatcher, type AppendBatcherOptions, EventTooLargeError } from "../src/store/remote/batcher";
import { BatchTooLargeError, type EncodedEvent, LeaseLostError, SeqConflictError, SessionStoreClient, type StoreEvent, type StoredEvent } from "../src/store/remote/client";
import { startFakeSessionStore } from "./fake-session-store";

interface Sent {
  afterSeq: number;
  events: StoreEvent[];
  leaseId: string;
}

/** A client whose appends are answered by the test: `auto` acknowledges at once, otherwise `answer()`. */
function stubClient(auto = true) {
  const sent: Sent[] = [];
  const waiting: { resolve: (v: { firstSeq: number; lastSeq: number }) => void; reject: (e: Error) => void; sent: Sent }[] = [];
  const client = {
    appendEncoded: (_sid: string, opts: { leaseId: string; afterSeq: number; events: EncodedEvent[] }) => {
      sent.push({ ...opts, events: opts.events.map((e) => ({ kind: e.kind, data: JSON.parse(e.json), ts_ms: e.ts_ms })) });
      return new Promise<{ firstSeq: number; lastSeq: number }>((resolve, reject) => {
        const w = { resolve, reject, sent: sent.at(-1)! };
        if (auto) ack(w);
        else waiting.push(w);
      });
    },
  };
  function ack(w: (typeof waiting)[number]) {
    w.resolve({ firstSeq: w.sent.afterSeq + 1, lastSeq: w.sent.afterSeq + w.sent.events.length });
  }
  return {
    client,
    sent,
    answer: () => ack(waiting.shift()!),
    refuse: (e: Error) => waiting.shift()!.reject(e),
    inFlight: () => waiting.length,
  };
}

function batcher(stub: ReturnType<typeof stubClient>, over: Partial<AppendBatcherOptions> = {}) {
  const fatals: Error[] = [];
  const b = new AppendBatcher({ client: stub.client, sid: "s1", leaseId: () => "L", afterSeq: 0, now: () => 7, onFatal: (e) => fatals.push(e), ...over });
  return { b, fatals };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AppendBatcher", () => {
  test("a burst is cut at 256 events; every batch carries after_seq = the last acknowledged seq; each append resolves to its seq", async () => {
    const stub = stubClient();
    const { b } = batcher(stub);
    const seqs = Array.from({ length: 600 }, (_, i) => b.append("log", { i }));
    await b.flush();
    expect(stub.sent.map((s) => s.events.length)).toEqual([256, 256, 88]);
    expect(stub.sent.map((s) => s.afterSeq)).toEqual([0, 256, 512]);
    expect(stub.sent.every((s) => s.leaseId === "L")).toBe(true);
    expect(await Promise.all(seqs)).toEqual(Array.from({ length: 600 }, (_, i) => i + 1));
    expect(stub.sent.flatMap((s) => s.events.map((e) => (e.data as { i: number }).i))).toEqual(Array.from({ length: 600 }, (_, i) => i));
    expect(stub.sent[0]!.events[0]).toEqual({ kind: "log", data: { i: 0 }, ts_ms: 7 });
    expect(b.lastSeq).toBe(600);
  });

  test("a batch is cut before its events' data passes the byte budget (1 MiB by default, as the store sums it)", async () => {
    const stub = stubClient();
    const { b } = batcher(stub);
    const big = "x".repeat(400_000);
    for (let i = 0; i < 5; i++) void b.append("log", big, 1);
    await b.flush();
    expect(stub.sent.map((s) => s.events.length)).toEqual([2, 2, 1]);
    for (const s of stub.sent) expect(s.events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e.data)), 0)).toBeLessThanOrEqual(1024 * 1024);

    const exact = stubClient();
    const one = Buffer.byteLength(JSON.stringify("abc"));
    const tight = batcher(exact, { batchMaxBytes: 2 * one }).b; // two fit exactly; a third does not
    for (let i = 0; i < 3; i++) void tight.append("k", "abc", 1);
    await tight.flush();
    expect(exact.sent.map((s) => s.events.length)).toEqual([2, 1]);
  });

  test("flush sends what is queued and resolves only once it is acknowledged", async () => {
    const stub = stubClient(false);
    const { b } = batcher(stub);
    void b.append("a", 1);
    void b.append("b", 2);
    let flushed = false;
    const f = b.flush().then(() => (flushed = true));
    await tick();
    expect(stub.sent.map((s) => s.events.length)).toEqual([2]);
    expect(flushed).toBe(false);
    stub.answer();
    await f;
    expect(flushed).toBe(true);
    await b.flush(); // empty: resolves at once, sends nothing
    expect(stub.sent).toHaveLength(1);
  });

  test("one batch in flight at a time; what arrives meanwhile is the next batch, in order, never resent", async () => {
    const stub = stubClient(false);
    const { b } = batcher(stub);
    const p1 = b.append("a", 1);
    await tick();
    expect(stub.inFlight()).toBe(1);
    const p2 = b.append("b", 2);
    const p3 = b.append("c", 3);
    await tick();
    expect(stub.sent).toHaveLength(1);
    stub.answer();
    await tick();
    expect(stub.sent).toHaveLength(2);
    expect(stub.sent[1]).toMatchObject({ afterSeq: 1, events: [{ kind: "b" }, { kind: "c" }] });
    stub.answer();
    expect(await Promise.all([p1, p2, p3])).toEqual([1, 2, 3]);
    await b.flush();
    expect(stub.sent).toHaveLength(2);
  });

  test("an append made as a batch is acknowledged goes out on its own, without a later append or flush", async () => {
    const stub = stubClient(false);
    const { b } = batcher(stub);
    const p1 = b.append("a", 1);
    await tick();
    stub.answer();
    await p1; // resumes while the drain that acknowledged it is still unwinding
    const p2 = b.append("b", 2);
    await tick();
    expect(stub.sent.map((s) => s.events.map((e) => e.kind))).toEqual([["a"], ["b"]]);
    stub.answer();
    expect(await p2).toBe(2);
  });

  test("everything queued behind a fatal batch rejects with it", async () => {
    const stub = stubClient(false);
    const { b } = batcher(stub);
    const first = b.append("a", 1);
    await tick();
    const behind = b.append("b", 2);
    const settled = Promise.allSettled([first, behind]);
    const err = new LeaseLostError("lost", 409, "lease_lost");
    stub.refuse(err);
    expect((await settled).map((r) => r.status === "rejected" && r.reason)).toEqual([err, err]);
    expect(stub.sent).toHaveLength(1);
  });

  test("onAck hands the host each acknowledged event with its seq", async () => {
    const stub = stubClient();
    const acked: StoredEvent[] = [];
    const { b } = batcher(stub, { afterSeq: 10, onAck: (evs) => acked.push(...evs) });
    void b.append("a", { x: 1 }, 5);
    void b.append("b", null, 6);
    await b.flush();
    expect(acked).toEqual([
      { seq: 11, kind: "a", data: { x: 1 }, ts_ms: 5 },
      { seq: 12, kind: "b", data: null, ts_ms: 6 },
    ]);
    expect(stub.sent[0]!.afterSeq).toBe(10);
  });

  for (const [name, err] of [
    ["lease_lost", new LeaseLostError("lost", 409, "lease_lost")],
    ["seq_conflict", new SeqConflictError("conflict", 409, "seq_conflict", 99)],
  ] as const) {
    test(`${name} is fatal: the batch and everything queued reject, onFatal fires once, nothing is sent after`, async () => {
      const stub = stubClient(false);
      const { b, fatals } = batcher(stub);
      const ok = b.append("a", 1);
      await tick();
      stub.answer();
      expect(await ok).toBe(1);
      const inBatch = b.append("b", 2);
      await tick();
      const queued = b.append("c", 3);
      const settled = Promise.allSettled([inBatch, queued, b.flush()]);
      stub.refuse(err);
      expect((await settled).map((r) => r.status === "rejected" && r.reason)).toEqual([err, err, err]);
      await tick();
      expect(fatals).toEqual([err]);
      expect(b.fatal).toBe(err);
      await expect(b.append("d", 4)).rejects.toBe(err);
      await expect(b.flush()).rejects.toBe(err);
      await tick();
      expect(stub.sent).toHaveLength(2);
      expect(fatals).toHaveLength(1);
    });
  }

  test("append serializes at once: a failure throws synchronously and queues nothing; later changes to the caller's object do not reach the store", async () => {
    const stub = stubClient();
    const { b } = batcher(stub);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => b.append("log", cyclic)).toThrow(TypeError);
    const data = { n: 1 };
    const p = b.append("log", data);
    data.n = 2;
    await p;
    expect(stub.sent.flatMap((s) => s.events.map((e) => e.data))).toEqual([{ n: 1 }]);
  });

  test("an event over maxEventBytes is refused at once with EventTooLargeError; the writer carries on", async () => {
    const stub = stubClient();
    const { b, fatals } = batcher(stub, { maxEventBytes: 100 });
    const big = "x".repeat(200);
    let err: unknown;
    try {
      b.append("tool_result", big);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EventTooLargeError);
    expect(err).toMatchObject({ bytes: 202, limit: 100 });
    expect(await b.append("log", "ok")).toBe(1);
    expect(fatals).toEqual([]);
    expect(stub.sent.flatMap((s) => s.events.map((e) => e.data))).toEqual(["ok"]);
  });

  test("413 batch_too_large on a shared batch is fatal (a batcher bug), as is event_too_large on more than one event", async () => {
    for (const code of ["batch_too_large", "event_too_large"]) {
      const stub = stubClient(false);
      const { b, fatals } = batcher(stub);
      const settled = Promise.allSettled([b.append("a", 1), b.append("b", 2)]);
      await tick();
      const err = new BatchTooLargeError("too large", 413, code, 256, 1024 * 1024, 10);
      stub.refuse(err);
      expect((await settled).map((r) => r.status)).toEqual(["rejected", "rejected"]);
      expect(fatals).toEqual([err]);
    }
  });

  test("against the fake store: under 1 MiB shares a batch, over 1 MiB goes alone and is taken; over the store's limit is refused, learned, and the writer carries on", async () => {
    const store = startFakeSessionStore({ maxEventBytes: 2 * 1024 * 1024 });
    try {
      store.createSession("s1");
      const { leaseId, token } = store.grant("s1");
      const sizes: number[] = [];
      const client = new SessionStoreClient({ baseUrl: store.url, tokenProvider: () => token });
      const counting = { appendEncoded: (sid: string, o: Parameters<SessionStoreClient["appendEncoded"]>[1]) => (sizes.push(o.events.length), client.appendEncoded(sid, o)) };
      const fatals: Error[] = [];
      const b = new AppendBatcher({ client: counting, sid: "s1", leaseId: () => leaseId, afterSeq: 0, onFatal: (e) => fatals.push(e) });
      const small = "s".repeat(300 * 1024);
      const big = "b".repeat(1500 * 1024);
      const huge = "h".repeat(3 * 1024 * 1024);
      const seqs = [b.append("log", small), b.append("log", small), b.append("tool_result", big), b.append("log", small)];
      const refused = b.append("tool_result", huge);
      const after = b.append("log", "after");
      expect(await Promise.all(seqs)).toEqual([1, 2, 3, 4]);
      const err = await refused.catch((e) => e);
      expect(err).toBeInstanceOf(EventTooLargeError);
      expect(err).toMatchObject({ bytes: huge.length + 2, limit: 2 * 1024 * 1024 });
      expect(await after).toBe(5);
      expect(sizes).toEqual([2, 1, 1, 1, 1]);
      expect(fatals).toEqual([]);
      expect(b.maxEventBytes).toBe(2 * 1024 * 1024);
      expect(() => b.append("tool_result", huge)).toThrow(EventTooLargeError); // learned: refused locally now
      expect(store.events("s1").map((e) => e.kind)).toEqual(["log", "log", "tool_result", "log", "log"]);
    } finally {
      await store.stop();
    }
  });

  test("against the fake store: 300 events land contiguous under the lease", async () => {
    const store = startFakeSessionStore();
    try {
      store.createSession("s1");
      const { leaseId, token } = store.grant("s1");
      const client = new SessionStoreClient({ baseUrl: store.url, tokenProvider: () => token });
      const b = new AppendBatcher({ client, sid: "s1", leaseId: () => leaseId, afterSeq: 0 });
      for (let i = 0; i < 300; i++) void b.append("log", { i });
      await b.flush();
      expect(store.events("s1").map((e) => e.seq)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
      expect(store.events("s1").map((e) => (e.data as { i: number }).i)).toEqual(Array.from({ length: 300 }, (_, i) => i));
    } finally {
      await store.stop();
    }
  });
});
