import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  BatchTooLargeError,
  LeaseHeldError,
  LeaseLostError,
  SeqConflictError,
  SessionDeletedError,
  SessionNotFoundError,
  SessionStoreClient,
  type SessionStoreClientOptions,
  StoreHttpError,
  StoreUnreachableError,
  StreamBusyError,
  type StoredEvent,
} from "../src/store/remote/client";
import { FakeClock } from "./fake-clock";
import { type FakeSessionStore, startFakeSessionStore } from "./fake-session-store";

let clock: FakeClock;
let store: FakeSessionStore;

beforeEach(() => {
  clock = new FakeClock();
  store = startFakeSessionStore({ clock: clock.now });
  store.createSession("s1");
});
afterEach(async () => {
  await store.stop();
});

function client(over: Partial<SessionStoreClientOptions> = {}) {
  const sleeps: number[] = [];
  const c = new SessionStoreClient({
    baseUrl: store.url,
    tokenProvider: () => store.controlToken,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  return { c, sleeps };
}

/** A control client to lease with, and an engine client holding that lease's token. */
async function engine(over: Partial<SessionStoreClientOptions> = {}) {
  const lease = await client().c.lease("s1", { holder: "engine:test:1", ttlS: 30 });
  const token = store.engineToken("s1", lease.leaseId);
  return { lease, token, ...client({ tokenProvider: () => token, ...over }) };
}

const ev = (i: number) => ({ kind: "log", data: { i }, ts_ms: 1000 + i });

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("SessionStoreClient over P1", () => {
  test("lease (control), renew, append, read, readAll (paged past 500), projection, release (engine)", async () => {
    const { lease: l, c } = await engine();
    expect(l).toEqual({ leaseId: expect.any(String), expiresAt: clock.now() + 30_000, lastSeq: 0 });
    clock.advance(10_000);
    expect(await c.renew("s1", l.leaseId)).toEqual({ leaseId: l.leaseId, expiresAt: clock.now() + 30_000, lastSeq: 0 });
    let after = 0;
    for (const n of [256, 256, 88]) {
      const r = await c.append("s1", { leaseId: l.leaseId, afterSeq: after, events: Array.from({ length: n }, (_, i) => ev(after + i + 1)) });
      expect(r).toEqual({ firstSeq: after + 1, lastSeq: after + n });
      after = r.lastSeq;
    }
    const page = await c.read("s1", { after: 498, limit: 5 });
    expect(page.events.map((e) => e.seq)).toEqual([499, 500, 501, 502, 503]);
    expect(page.lastSeq).toBe(600);
    expect(page.events[0]).toEqual({ seq: 499, ...ev(499) });
    const all = await c.readAll("s1");
    expect(all.lastSeq).toBe(600);
    expect(all.events.map((e) => e.seq)).toEqual(Array.from({ length: 600 }, (_, i) => i + 1));
    const p = await c.projection("s1");
    expect(p).toEqual({
      sid: "s1",
      owner: "cust_7",
      unit: "unit_platform",
      publication: "infra-ro",
      hop: { name: "infra-ro", version: "0.9.2", digest: "sha256:9f2c" },
      status: "idle",
      parks: [],
      refusal: null,
      usage: { inputTokens: 0, outputTokens: 0, costCu: 0 },
      lease: { holder: "engine:test:1", expiresAt: clock.now() + 30_000 },
      lastSeq: 600,
      updatedAt: clock.now(),
    });
    await c.release("s1", l.leaseId);
    expect(store.lease("s1")).toBeNull();
  });

  test("readAll of an empty session asks once, at 0; it never asks past the head", async () => {
    store.createSession("empty");
    const urls: string[] = [];
    const { c } = client({ fetch: async (u, i) => (urls.push(u), fetch(u, i)) });
    expect(await c.readAll("empty")).toEqual({ events: [], lastSeq: 0 });
    expect(urls.map((u) => new URL(u).search)).toEqual(["?after=0&limit=500"]);
  });

  test("read refuses a limit over 500 before any request", async () => {
    let calls = 0;
    const { c } = client({ fetch: async (u, i) => (calls++, fetch(u, i)) });
    expect(await caught(c.read("s1", { after: 0, limit: 501 }))).toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  });

  test("each P1 refusal is a typed error carrying status and code", async () => {
    const control = client().c;
    const { lease: l, c } = await engine();
    const held = await caught(control.lease("s1", { holder: "b", ttlS: 30 }));
    expect(held).toBeInstanceOf(LeaseHeldError);
    expect(held).toMatchObject({ status: 409, code: "session_leased", expiresAt: clock.now() + 30_000 });
    expect(await caught(c.lease("s1", { holder: "b", ttlS: 30 }))).toMatchObject({ status: 403, code: "forbidden" }); // an engine never leases
    await c.append("s1", { leaseId: l.leaseId, afterSeq: 0, events: [ev(1), ev(2)] });
    const conflict = await caught(c.append("s1", { leaseId: l.leaseId, afterSeq: 1, events: [ev(9)] }));
    expect(conflict).toBeInstanceOf(SeqConflictError);
    expect(conflict).toMatchObject({ status: 409, code: "seq_conflict", lastSeq: 2 });
    const big = await caught(c.append("s1", { leaseId: l.leaseId, afterSeq: 2, events: Array.from({ length: 257 }, (_, i) => ev(i)) }));
    expect(big).toBeInstanceOf(BatchTooLargeError);
    expect(big).toMatchObject({ status: 413, code: "batch_too_large", maxEvents: 256, maxBytes: 1048576 });
    const missing = await caught(control.projection("nope"));
    expect(missing).toBeInstanceOf(SessionNotFoundError);
    expect(missing).toMatchObject({ status: 404, code: "unknown_session" });
    const cursor = await caught(c.read("s1", { after: 3 }));
    expect(cursor).toMatchObject({ status: 400, code: "invalid_cursor" });
    store.failNext("projection", 500, "store_unavailable");
    expect(await caught(c.projection("s1"))).toMatchObject({ status: 500, code: "store_unavailable" });
    clock.advance(31_000);
    const lost = await caught(c.append("s1", { leaseId: l.leaseId, afterSeq: 2, events: [ev(3)] }));
    expect(lost).toBeInstanceOf(LeaseLostError);
    expect(lost).toMatchObject({ status: 409, code: "lease_lost" });
    await control.release("s1", l.leaseId).catch(() => {});
    await fetch(`${store.url}/sessions/s1`, { method: "DELETE", headers: { authorization: `Bearer ${store.controlToken}` } });
    const gone = await caught(control.readAll("s1"));
    expect(gone).toBeInstanceOf(SessionDeletedError);
    expect(gone).toMatchObject({ status: 410, code: "session_deleted", deletedAt: clock.now() });
    for (const e of [held, conflict, big, missing, cursor, lost, gone]) expect(e).toBeInstanceOf(StoreHttpError);
  });

  test("a dropped append response is retried with the same after_seq and returns the original seqs", async () => {
    const { lease: l, c, sleeps } = await engine({ timeoutMs: 50 });
    store.dropNext("append");
    const r = await c.append("s1", { leaseId: l.leaseId, afterSeq: 0, events: [ev(1), ev(2)] });
    expect(r).toEqual({ firstSeq: 1, lastSeq: 2 });
    expect(store.events("s1").map((e) => e.seq)).toEqual([1, 2]);
    expect(sleeps).toHaveLength(1);
  });

  test("append retries a 5xx with the same after_seq and body, honouring Retry-After, at most 3 attempts", async () => {
    const { lease: l, c, sleeps } = await engine();
    store.failNext("append", 503, "session_busy");
    expect(await c.append("s1", { leaseId: l.leaseId, afterSeq: 0, events: [ev(1)] })).toEqual({ firstSeq: 1, lastSeq: 1 });
    expect(sleeps).toEqual([1000]); // the store's Retry-After for session_busy
    const bodies: string[] = [];
    const busy = async (_u: string, init: RequestInit) => (bodies.push(init.body as string), Response.json({ code: "store_unavailable" }, { status: 500 }));
    const e = await caught(client({ fetch: busy }).c.append("s1", { leaseId: "l", afterSeq: 7, events: [ev(1)] }));
    expect(e).toMatchObject({ status: 500, code: "store_unavailable" });
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!).after_seq).toBe(7);
  });

  test("the body is serialized once per call, not per attempt", async () => {
    let serialized = 0;
    const data = { toJSON: () => (serialized++, { x: 1 }) };
    let calls = 0;
    const flaky = async () => (++calls < 3 ? Response.json({ code: "store_busy" }, { status: 503 }) : Response.json({ first_seq: 1, last_seq: 1 }));
    await client({ fetch: flaky }).c.append("s1", { leaseId: "l", afterSeq: 0, events: [{ kind: "log", data, ts_ms: 1 }] });
    expect(calls).toBe(3);
    expect(serialized).toBe(1);
  });

  for (const [route, call] of [
    ["append", (c: SessionStoreClient) => c.append("s1", { leaseId: "l", afterSeq: 0, events: [ev(1)] })],
    ["renew", (c: SessionStoreClient) => c.renew("s1", "l", 30)],
    ["release", (c: SessionStoreClient) => c.release("s1", "l")],
    ["read", (c: SessionStoreClient) => c.read("s1", { after: 0 })],
    ["projection", (c: SessionStoreClient) => c.projection("s1")],
  ] as const) {
    test(`${route}: 503 store_busy and session_busy are retried after Retry-After, within 3 attempts; exhausted, the last code is thrown`, async () => {
      let calls = 0;
      const codes = ["store_busy", "session_busy", "store_busy"];
      const busy = async () => Response.json({ code: codes[calls++] }, { status: 503, headers: { "retry-after": "2" } });
      const { c, sleeps } = client({ fetch: busy });
      const e = await caught(call(c));
      expect(e).toBeInstanceOf(StoreHttpError);
      expect(e).toMatchObject({ status: 503, code: "store_busy" });
      expect(calls).toBe(3);
      expect(sleeps).toEqual([2000, 2000]);
    });
  }

  test("the retry budget is also 30 s per call: a long Retry-After ends it early", async () => {
    let t = 0;
    let calls = 0;
    const busy = async () => (calls++, Response.json({ code: "store_busy" }, { status: 503, headers: { "retry-after": "20" } }));
    const c = new SessionStoreClient({ baseUrl: store.url, tokenProvider: () => "t", fetch: busy, now: () => t, sleep: async (ms) => void (t += ms) });
    expect(await caught(c.read("s1", { after: 0 }))).toMatchObject({ code: "store_busy" });
    expect(calls).toBe(2); // 0 s, 20 s; a third at 40 s would pass the budget
  });

  test("only busy answers are retried off the append path; network failures there are tried once", async () => {
    let calls = 0;
    const down = (status: number, code: string) => async () => (calls++, Response.json({ code }, { status }));
    expect(await caught(client({ fetch: down(500, "store_unavailable") }).c.renew("s1", "l", 30))).toMatchObject({ status: 500 });
    expect(calls).toBe(1);
  });

  test("each attempt is bounded by a 20 s timeout by default", async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => (timeouts.push(ms), real(ms)));
    try {
      await client().c.projection("s1");
      expect(timeouts).toEqual([20_000]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a caller's timeout can only shorten the client's own per attempt, never lengthen it", async () => {
    const timeouts: number[] = [];
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => (timeouts.push(ms), real(ms)));
    try {
      const { lease: l } = await engine();
      const c = client({ timeoutMs: 5_000, tokenProvider: () => store.engineToken("s1", l.leaseId) }).c;
      await c.renew("s1", l.leaseId, 30, { timeoutMs: 8_000 });
      await c.renew("s1", l.leaseId, 30, { timeoutMs: 3_000 });
      expect(timeouts.slice(-2)).toEqual([5_000, 3_000]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a caller's signal stops a call: an aborted attempt is not retried and no attempt starts after the abort", async () => {
    const ctl = new AbortController();
    let calls = 0;
    const busy = async () => (calls++, ctl.abort(new Error("lease lost")), Response.json({ code: "session_busy" }, { status: 503 }));
    const e = await caught(client({ fetch: busy }).c.renew("s1", "l", 30, { signal: ctl.signal }));
    expect(e.message).toBe("lease lost");
    expect(calls).toBe(1);
  });

  test("413 event_too_large is a BatchTooLargeError carrying the store's max_event_bytes", async () => {
    const tooLarge = async () => Response.json({ code: "event_too_large", max_event_bytes: 2048 }, { status: 413 });
    const e = await caught(client({ fetch: tooLarge }).c.append("s1", { leaseId: "l", afterSeq: 0, events: [ev(1)] }));
    expect(e).toBeInstanceOf(BatchTooLargeError);
    expect(e).toMatchObject({ code: "event_too_large", maxEventBytes: 2048 });
  });

  test("readAll keeps paging past a short page until the last event's seq is the head", async () => {
    const page = (seqs: number[], last: number) => Response.json({ events: seqs.map((seq) => ({ seq, kind: "log", data: {}, ts_ms: 1 })), last_seq: last });
    const pages = [page([1, 2], 5), page([3], 5), page([4, 5], 5)];
    const afters: string[] = [];
    const { c } = client({ fetch: async (u) => (afters.push(new URL(u).searchParams.get("after")!), pages.shift()!) });
    expect((await c.readAll("s1")).events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(afters).toEqual(["0", "2", "3"]);
    const short = client({ fetch: async () => page([], 5) }).c;
    expect((await caught(short.readAll("s1"))).message).toContain("an empty page after 0, before last_seq 5"); // never taken for the end
  });

  test("stream: events as they land; an erased session ends it as a normal close, and a reconnect after the last seq resumes", async () => {
    const { lease: l, c } = await engine();
    await c.append("s1", { leaseId: l.leaseId, afterSeq: 0, events: [ev(1), ev(2)] });
    const seen: { seq: number; kind: string; data: unknown }[] = [];
    const reading = (async () => {
      for await (const e of c.stream("s1", { after: 1 })) {
        seen.push(e);
        if (e.seq === 3) await fetch(`${store.url}/sessions/s1`, { method: "DELETE", headers: { authorization: `Bearer ${store.controlToken}` } });
      }
    })();
    while (seen.length < 1) await new Promise((r) => setTimeout(r, 1));
    await c.append("s1", { leaseId: l.leaseId, afterSeq: 2, events: [ev(3)] });
    await reading; // the erasure closed the stream: no throw
    expect(seen).toEqual([
      { seq: 2, kind: "log", data: ev(2).data },
      { seq: 3, kind: "log", data: ev(3).data },
    ]);
    expect(await caught((async () => { for await (const _ of c.stream("s1", { after: 3 })) void _; })())).toBeInstanceOf(SessionDeletedError);
  });

  test("stream: a CR ending one chunk and the LF starting the next are one line break", async () => {
    const enc = new TextEncoder();
    const chunks = ["id: 1\r", "\nevent: x\r\ndata: 1\r", "\n\r\n"];
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (const ch of chunks) ctl.enqueue(enc.encode(ch));
        ctl.close();
      },
    });
    const { c } = client({ fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
    const got: unknown[] = [];
    for await (const e of c.stream("s1", {})) got.push(e);
    expect(got).toEqual([{ seq: 1, kind: "x", data: 1 }]);
  });

  test("stream: an empty token does not garble a transport error", async () => {
    const { c } = client({ tokenProvider: () => "", fetch: async () => { throw new TypeError("connect ECONNREFUSED"); } });
    const e = await caught((async () => { for await (const _ of c.stream("s1", {})) void _; })());
    expect(e.message).toContain("connect ECONNREFUSED");
  });

  test("stream: a full replica or a principal's cap is a StreamBusyError with its Retry-After", async () => {
    const { c } = client();
    for (const [status, code] of [[503, "stream_capacity"], [429, "too_many_streams"]] as const) {
      store.failNext("stream", status, code);
      const e = await caught((async () => { for await (const _ of c.stream("s1", {})) void _; })());
      expect(e).toBeInstanceOf(StreamBusyError);
      expect(e).toMatchObject({ status, code, retryAfterS: 5 });
    }
  });

  test("stream: data spanning several data: lines is joined; comments are skipped; the caller's abort ends it quietly", async () => {
    const body = `: keep-alive\n\nid: 7\nevent: user\ndata: {"a":\ndata: 1}\n\n`;
    const { c } = client({ fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
    const got: StoredEvent[] = [];
    for await (const e of c.stream("s1", { after: 6 })) got.push(e as StoredEvent);
    expect(got).toEqual([{ seq: 7, kind: "user", data: { a: 1 } }] as never);
    const ctl = new AbortController();
    const live = client();
    const it = live.c.stream("s1", { after: 0, signal: ctl.signal });
    const next = it.next();
    ctl.abort();
    expect(await next).toEqual({ done: true, value: undefined });
  });

  test("append gives up after 3 attempts on network failures; every other call is tried once", async () => {
    let calls = 0;
    const down = async () => {
      calls++;
      throw new TypeError("connect ECONNREFUSED");
    };
    const { c, sleeps } = client({ fetch: down });
    const e = await caught(c.append("s1", { leaseId: "l", afterSeq: 0, events: [ev(1)] }));
    expect(e).toBeInstanceOf(StoreUnreachableError);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([200, 400]);
    for (const call of [() => c.read("s1", { after: 0 }), () => c.renew("s1", "l"), () => c.lease("s1", { holder: "a", ttlS: 30 }), () => c.release("s1", "l"), () => c.projection("s1")]) {
      calls = 0;
      expect(await caught(call())).toBeInstanceOf(StoreUnreachableError);
      expect(calls).toBe(1);
    }
  });

  test("the bearer comes from the token provider on every request", async () => {
    let token = store.controlToken;
    const { c } = client({ tokenProvider: () => token });
    await c.projection("s1");
    token = "rotated-elsewhere";
    expect(await caught(c.projection("s1"))).toMatchObject({ status: 401, code: "unauthorized" });
  });

  test("the token never appears in an error, even when the transport or the body echoes it", async () => {
    const token = "test-token-SECRET";
    const errors: Error[] = [];
    const echoBody = async () => Response.json({ code: "unauthorized", message: `bad Bearer ${token}`, token }, { status: 401 });
    const echoThrow = async () => {
      throw new TypeError(`fetch failed for Authorization: Bearer ${token}`);
    };
    for (const f of [echoBody, echoThrow]) {
      const { c } = client({ fetch: f, tokenProvider: () => token });
      errors.push(await caught(c.projection("s1")));
      errors.push(await caught(c.append("s1", { leaseId: "l", afterSeq: 0, events: [ev(1)] })));
    }
    const real = client({ tokenProvider: () => token }).c;
    errors.push(await caught(real.lease("nope", { holder: "a", ttlS: 30 })));
    for (const e of errors) {
      expect(`${e.message} ${e.stack} ${JSON.stringify(e)} ${String((e as { cause?: unknown }).cause ?? "")}`).not.toContain(token);
    }
  });
});
