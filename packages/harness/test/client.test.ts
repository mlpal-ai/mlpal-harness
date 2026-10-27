import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  LeaseHeldError,
  LeaseLostError,
  SeqConflictError,
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
    tokenProvider: () => store.token,
    sleep: async (ms) => void sleeps.push(ms),
    ...over,
  });
  return { c, sleeps };
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
  test("lease, renew, append, read, readAll (paged past 500), projection, release", async () => {
    const { c } = client();
    const l = await c.lease("s1", { holder: "engine:test:1", ttlS: 30 });
    expect(l).toEqual({ leaseId: expect.any(String), expiresAt: new Date(clock.now() + 30_000).toISOString(), lastSeq: 0 });
    clock.advance(10_000);
    expect(await c.renew("s1", l.leaseId)).toEqual({ expiresAt: new Date(clock.now() + 30_000).toISOString() });
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
    expect(p).toMatchObject({ sid: "s1", status: "idle", lastSeq: 600, usage: { inputTokens: 0, outputTokens: 0, costCu: 0 } });
    await c.release("s1", l.leaseId);
    expect(store.lease("s1")).toBeNull();
    expect(await c.readAll("s2").catch((e) => e)).toBeInstanceOf(SessionNotFoundError);
  });

  test("read refuses a limit over 500 before any request", async () => {
    let calls = 0;
    const { c } = client({ fetch: async (u, i) => (calls++, fetch(u, i)) });
    expect(await caught(c.read("s1", { after: 0, limit: 501 }))).toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  });

  test("each P1 refusal is a typed error carrying status and reason", async () => {
    const { c } = client();
    const l = await c.lease("s1", { holder: "a", ttlS: 30 });
    const held = await caught(c.lease("s1", { holder: "b", ttlS: 30 }));
    expect(held).toBeInstanceOf(LeaseHeldError);
    expect(held).toMatchObject({ status: 409, reason: "session_leased" });
    await c.append("s1", { leaseId: l.leaseId, afterSeq: 0, events: [ev(1), ev(2)] });
    const conflict = await caught(c.append("s1", { leaseId: l.leaseId, afterSeq: 1, events: [ev(9)] }));
    expect(conflict).toBeInstanceOf(SeqConflictError);
    expect(conflict).toMatchObject({ status: 409, reason: "seq_conflict", lastSeq: 2 });
    const lost = await caught(c.append("s1", { leaseId: "not-the-lease", afterSeq: 2, events: [ev(3)] }));
    expect(lost).toBeInstanceOf(LeaseLostError);
    expect(lost).toMatchObject({ status: 409, reason: "lease_lost" });
    const missing = await caught(c.projection("nope"));
    expect(missing).toBeInstanceOf(SessionNotFoundError);
    expect(missing).toMatchObject({ status: 404, reason: "session_not_found" });
    const big = await caught(c.append("s1", { leaseId: l.leaseId, afterSeq: 2, events: Array.from({ length: 257 }, (_, i) => ev(i)) }));
    expect(big).toBeInstanceOf(StoreHttpError);
    expect(big).toMatchObject({ status: 413, reason: "too_many_events" });
    store.failNext("projection", 503, "store_unavailable");
    expect(await caught(c.projection("s1"))).toMatchObject({ status: 503, reason: "store_unavailable" });
    for (const e of [held, conflict, lost, missing, big]) expect(e).toBeInstanceOf(StoreHttpError);
  });

  test("a dropped append response is retried with the same after_seq and returns the original seqs", async () => {
    const { c, sleeps } = client({ timeoutMs: 50 });
    const l = await c.lease("s1", { holder: "a", ttlS: 30 });
    store.dropNext("append");
    const r = await c.append("s1", { leaseId: l.leaseId, afterSeq: 0, events: [ev(1), ev(2)] });
    expect(r).toEqual({ firstSeq: 1, lastSeq: 2 });
    expect(store.events("s1").map((e) => e.seq)).toEqual([1, 2]);
    expect(sleeps).toHaveLength(1);
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
    expect(sleeps).toHaveLength(3);
    for (const call of [() => c.read("s1", { after: 0 }), () => c.renew("s1", "l"), () => c.lease("s1", { holder: "a", ttlS: 30 }), () => c.release("s1", "l"), () => c.projection("s1")]) {
      calls = 0;
      expect(await caught(call())).toBeInstanceOf(StoreUnreachableError);
      expect(calls).toBe(1);
    }
  });

  test("the bearer comes from the token provider on every request", async () => {
    let token = store.token;
    const { c } = client({ tokenProvider: () => token });
    await c.lease("s1", { holder: "a", ttlS: 30 });
    token = "rotated-elsewhere";
    expect(await caught(c.projection("s1"))).toMatchObject({ status: 401, reason: "unauthorized" });
  });

  test("the token never appears in an error, even when the transport or the body echoes it", async () => {
    const token = "test-token-SECRET";
    const errors: Error[] = [];
    const echoBody = async () => Response.json({ error: `bad Bearer ${token}`, code: "unauthorized", token }, { status: 401 });
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
