import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

  test("a 5xx on append is retried with the same after_seq, honouring Retry-After; elsewhere it is thrown at once", async () => {
    const { lease: l, c, sleeps } = await engine();
    store.failNext("append", 503, "session_busy");
    expect(await c.append("s1", { leaseId: l.leaseId, afterSeq: 0, events: [ev(1)] })).toEqual({ firstSeq: 1, lastSeq: 1 });
    expect(sleeps).toEqual([200]);
    let calls = 0;
    const busy = async () => (calls++, Response.json({ code: "session_busy" }, { status: 503, headers: { "retry-after": "1" } }));
    const flaky = client({ fetch: busy });
    const e = await caught(flaky.c.append("s1", { leaseId: "l", afterSeq: 0, events: [ev(1)] }));
    expect(e).toMatchObject({ status: 503, code: "session_busy" });
    expect(calls).toBe(4);
    expect(flaky.sleeps).toEqual([1000, 1000, 1000]);
    calls = 0;
    expect(await caught(flaky.c.renew("s1", "l"))).toMatchObject({ status: 503 });
    expect(calls).toBe(1);
  });

  test("append gives up after 3 retries; every other call is tried once", async () => {
    let calls = 0;
    const down = async () => {
      calls++;
      throw new TypeError("connect ECONNREFUSED");
    };
    const { c, sleeps } = client({ fetch: down });
    const e = await caught(c.append("s1", { leaseId: "l", afterSeq: 0, events: [ev(1)] }));
    expect(e).toBeInstanceOf(StoreUnreachableError);
    expect(calls).toBe(4);
    expect(sleeps).toEqual([200, 400, 800]);
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
