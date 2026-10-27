import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeClock } from "./fake-clock";
import { type FakeSessionStore, startFakeSessionStore } from "./fake-session-store";

let clock: FakeClock;
let store: FakeSessionStore;

beforeEach(() => {
  clock = new FakeClock();
  store = startFakeSessionStore({ clock: clock.now });
});
afterEach(async () => {
  await store.stop();
});

async function call(method: string, path: string, body?: unknown, token: string | null = store.token) {
  const res = await fetch(`${store.url}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

const ev = (i: number) => ({ kind: "log", data: { i }, ts_ms: 1000 + i });

async function leased(sid = "s1"): Promise<string> {
  store.createSession(sid);
  const r = await call("POST", `/sessions/${sid}/lease`, { holder: "engine:test:1", ttl_s: 30 });
  expect(r.status).toBe(200);
  return r.body!.lease_id as string;
}

describe("fake P1 session store", () => {
  test("append assigns contiguous seqs from 1, stamps receivedAt, and GET events pages by after/limit", async () => {
    const lease = await leased();
    const a = await call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: 0, events: [ev(1), ev(2), ev(3)] });
    expect(a).toEqual({ status: 200, body: { first_seq: 1, last_seq: 3 } });
    expect(store.events("s1").map((e) => e.receivedAt)).toEqual([clock.now(), clock.now(), clock.now()]);
    const p1 = await call("GET", "/sessions/s1/events?after=0&limit=2");
    expect(p1.body).toEqual({ events: [{ seq: 1, ...ev(1) }, { seq: 2, ...ev(2) }], last_seq: 3 });
    const p2 = await call("GET", "/sessions/s1/events?after=2&limit=2");
    expect(p2.body).toEqual({ events: [{ seq: 3, ...ev(3) }], last_seq: 3 });
    expect((await call("GET", "/sessions/s1/events?after=0&limit=501")).status).toBe(400);
  });

  test("a stale after_seq is seq_conflict with the store's last_seq; the same batch replayed returns its original seqs", async () => {
    const lease = await leased();
    await call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: 0, events: [ev(1), ev(2)] });
    const replay = await call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: 0, events: [ev(1), ev(2)] });
    expect(replay).toEqual({ status: 200, body: { first_seq: 1, last_seq: 2 } });
    const stale = await call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: 0, events: [ev(9)] });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "seq_conflict", last_seq: 2 });
    const ahead = await call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: 5, events: [ev(9)] });
    expect(ahead.body).toMatchObject({ code: "seq_conflict", last_seq: 2 });
    expect(store.events("s1")).toHaveLength(2);
  });

  test("leases: session_leased while live, takeable after the TTL on the clock, lease_lost for the old holder", async () => {
    const first = await leased();
    const held = await call("POST", "/sessions/s1/lease", { holder: "engine:b:2", ttl_s: 30 });
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ code: "session_leased" });
    const renewed = await call("POST", `/sessions/s1/lease/${first}/renew`);
    expect(renewed.status).toBe(200);
    expect(renewed.body!.expires_at).toBe(new Date(clock.now() + 30_000).toISOString());
    clock.advance(30_000);
    const second = await call("POST", "/sessions/s1/lease", { holder: "engine:b:2", ttl_s: 30 });
    expect(second.status).toBe(200);
    expect(second.body!.last_seq).toBe(0);
    expect(store.lease("s1")?.holder).toBe("engine:b:2");
    const lost = await call("POST", "/sessions/s1/events", { lease_id: first, after_seq: 0, events: [ev(1)] });
    expect(lost.body).toMatchObject({ code: "lease_lost" });
    expect((await call("POST", `/sessions/s1/lease/${first}/renew`)).body).toMatchObject({ code: "lease_lost" });
    expect((await call("DELETE", `/sessions/s1/lease/${second.body!.lease_id}`)).status).toBe(204);
    expect(store.lease("s1")).toBeNull();
    expect((await call("POST", "/sessions/s1/lease", { holder: "x", ttl_s: 61 })).status).toBe(400);
  });

  test("a batch over 256 events or 1 MiB is refused 413 with a reason and nothing is committed", async () => {
    const lease = await leased();
    const many = await call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: 0, events: Array.from({ length: 257 }, (_, i) => ev(i)) });
    expect(many.status).toBe(413);
    expect(many.body).toMatchObject({ code: "too_many_events" });
    const big = await call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: 0, events: [{ kind: "log", data: "x".repeat(1024 * 1024), ts_ms: 1 }] });
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({ code: "batch_too_large" });
    expect(store.events("s1")).toEqual([]);
  });

  test("a missing or wrong bearer is 401; an unknown session is 404", async () => {
    store.createSession("s1");
    expect((await call("GET", "/sessions/s1/events", undefined, null)).status).toBe(401);
    expect((await call("GET", "/sessions/s1/events", undefined, "wrong")).body).toMatchObject({ code: "unauthorized" });
    expect((await call("GET", "/sessions/nope/events")).status).toBe(404);
    expect((await call("GET", "/sessions/nope")).body).toMatchObject({ code: "session_not_found" });
  });

  test("the projection folds status, park and usage from event kinds", async () => {
    const lease = await leased();
    const entry = (payload: Record<string, unknown>) => ({ kind: payload.type as string, data: { uuid: crypto.randomUUID(), parentUuid: null, ts: "t", payload }, ts_ms: 1 });
    const post = (events: unknown[]) => call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: store.events("s1").length, events });
    expect((await call("GET", "/sessions/s1")).body).toMatchObject({ sid: "s1", status: "idle", last_seq: 0 });
    await post([entry({ type: "user" })]);
    expect((await call("GET", "/sessions/s1")).body).toMatchObject({ status: "running" });
    await post([entry({ type: "result", subtype: "needs_approval", usage: { input_tokens: 5, output_tokens: 2 } })]);
    const parked = (await call("GET", "/sessions/s1")).body!;
    expect(parked).toMatchObject({ status: "requires_action", park: { kind: "approval" }, usage: { input_tokens: 5, output_tokens: 2 }, last_seq: 2 });
    await post([entry({ type: "user" }), entry({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } })]);
    const idle = (await call("GET", "/sessions/s1")).body!;
    expect(idle).toMatchObject({ status: "idle", usage: { input_tokens: 6, output_tokens: 3 } });
    expect(idle.park).toBeUndefined();
    await post([{ kind: "question_parked", data: { id: "q1", questions: [] }, ts_ms: 1 }]);
    expect((await call("GET", "/sessions/s1")).body).toMatchObject({ status: "requires_action", park: { kind: "parked_question", id: "q1" } });
    await post([{ kind: "question_answered", data: { id: "q1" }, ts_ms: 1 }]);
    expect((await call("GET", "/sessions/s1")).body).toMatchObject({ status: "idle" });
  });

  test("failNext answers one request with the given status and reason; dropNext commits and never answers", async () => {
    const lease = await leased();
    store.failNext("read", 503, "store_unavailable");
    expect(await call("GET", "/sessions/s1/events")).toEqual({ status: 503, body: { error: "injected fault", code: "store_unavailable" } });
    expect((await call("GET", "/sessions/s1/events")).status).toBe(200);
    store.dropNext("append");
    const dropped = fetch(`${store.url}/sessions/s1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${store.token}`, "content-type": "application/json" },
      body: JSON.stringify({ lease_id: lease, after_seq: 0, events: [ev(1)] }),
      signal: AbortSignal.timeout(50),
    });
    await expect(dropped).rejects.toThrow();
    expect(store.events("s1").map((e) => e.seq)).toEqual([1]);
  });

  test("stream: SSE with id = seq from `after`, live appends follow, and Last-Event-ID resumes after that seq", async () => {
    const lease = await leased();
    await call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: 0, events: [ev(1), ev(2), ev(3)] });
    const first = await readSse("/sessions/s1/stream?after=1", {}, 3, async () => {
      await call("POST", "/sessions/s1/events", { lease_id: lease, after_seq: 3, events: [ev(4)] });
    });
    expect(first.map((f) => f.id)).toEqual(["2", "3", "4"]);
    expect(JSON.parse(first[0]!.data)).toEqual({ seq: 2, ...ev(2) });
    const resumed = await readSse("/sessions/s1/stream?after=0", { "last-event-id": "3" }, 1);
    expect(resumed.map((f) => f.id)).toEqual(["4"]);
  });
});

/** Reads `n` SSE frames from a stream, running `whileOpen` once the stream is connected. */
async function readSse(path: string, headers: Record<string, string>, n: number, whileOpen?: () => Promise<void>) {
  const ctl = new AbortController();
  const res = await fetch(`${store.url}${path}`, { headers: { authorization: `Bearer ${store.token}`, ...headers }, signal: ctl.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { id: string; data: string }[] = [];
  let buf = "";
  let started = false;
  while (frames.length < n) {
    if (!started && whileOpen) {
      started = true;
      void whileOpen();
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (id !== undefined && data !== undefined) frames.push({ id, data });
    }
  }
  ctl.abort();
  return frames;
}
