import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeClock } from "./fake-clock";
import { type FakeSessionStore, startFakeSessionStore } from "./fake-session-store";

/** The fake's semantics beyond the single shapes the contract fixtures pin. */

let clock: FakeClock;
let store: FakeSessionStore;

beforeEach(() => {
  clock = new FakeClock();
  store = startFakeSessionStore({ clock: clock.now });
});
afterEach(async () => {
  await store.stop();
});

async function call(method: string, path: string, body?: unknown, token: string | null = store.controlToken) {
  const res = await fetch(`${store.url}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
}

const ev = (i: number) => ({ kind: "log", data: { i }, ts_ms: 1000 + i });

function leased(sid = "s1", ttlS = 30) {
  store.createSession(sid);
  return store.grant(sid, { ttlS });
}

const append = (sid: string, g: { leaseId: string; token: string }, afterSeq: number, events: unknown[]) =>
  call("POST", `/sessions/${sid}/events`, { lease_id: g.leaseId, after_seq: afterSeq, events }, g.token);

describe("fake P1 session store", () => {
  test("append assigns contiguous seqs from 1, stamps receivedAt; reads page by after/limit and refuse a cursor past the head", async () => {
    const g = leased();
    expect(await append("s1", g, 0, [ev(1), ev(2), ev(3)])).toEqual({ status: 200, body: { first_seq: 1, last_seq: 3 } });
    expect(store.events("s1").map((e) => e.receivedAt)).toEqual([clock.now(), clock.now(), clock.now()]);
    expect((await call("GET", "/sessions/s1/events?after=0&limit=2", undefined, g.token)).body).toEqual({ events: [{ seq: 1, ...ev(1) }, { seq: 2, ...ev(2) }], last_seq: 3 });
    expect((await call("GET", "/sessions/s1/events?after=2")).body).toEqual({ events: [{ seq: 3, ...ev(3) }], last_seq: 3 });
    expect((await call("GET", "/sessions/s1/events?after=3")).body).toEqual({ events: [], last_seq: 3 });
    expect((await call("GET", "/sessions/s1/events?after=4")).body).toMatchObject({ code: "invalid_cursor", last_seq: 3 });
    store.createSession("empty");
    expect((await call("GET", "/sessions/empty/events?after=0")).body).toEqual({ events: [], last_seq: 0 });
  });

  test("a page holds at most 4 MiB of data; a single larger event is a page of its own", async () => {
    const g = leased();
    const big = (c: string) => ({ kind: "log", data: c.repeat(900 * 1024), ts_ms: 1 });
    for (let i = 0; i < 6; i++) await append("s1", g, i, [big(String(i))]);
    const p1 = await call("GET", "/sessions/s1/events?after=0");
    expect(p1.body!.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2, 3, 4]);
    const p2 = await call("GET", "/sessions/s1/events?after=4");
    expect(p2.body!.events.map((e: { seq: number }) => e.seq)).toEqual([5, 6]);
  });

  test("a replay (same lease, after_seq and content) answers its original seqs, even after the lease lapsed; other content is seq_conflict", async () => {
    const g = leased();
    await append("s1", g, 0, [ev(1), ev(2)]);
    expect(await append("s1", g, 0, [ev(1), ev(2)])).toEqual({ status: 200, body: { first_seq: 1, last_seq: 2 } });
    expect((await append("s1", g, 0, [ev(9)])).body).toEqual({ code: "seq_conflict", last_seq: 2 });
    expect((await append("s1", g, 5, [ev(9)])).body).toEqual({ code: "seq_conflict", last_seq: 2 });
    clock.advance(31_000);
    expect(await append("s1", g, 0, [ev(1), ev(2)])).toEqual({ status: 200, body: { first_seq: 1, last_seq: 2 } });
    expect((await append("s1", g, 2, [ev(3)])).body).toEqual({ code: "lease_lost" });
    expect(store.events("s1")).toHaveLength(2);
  });

  test("leases: control takes one; renew extends it (optionally to a new ttl); a lapsed lease is never revived; release frees the session", async () => {
    const g = leased("s1", 30);
    expect((await call("POST", "/sessions/s1/lease", { holder: "b", ttl_s: 30 })).body).toEqual({ code: "session_leased", expires_at: clock.now() + 30_000 });
    expect((await call("POST", "/sessions/s1/lease", { holder: "b", ttl_s: 30 }, g.token)).status).toBe(403); // an engine never leases
    clock.advance(10_000);
    const renewed = await call("POST", `/sessions/s1/lease/${g.leaseId}/renew`, undefined, g.token);
    expect(renewed.body).toEqual({ lease_id: g.leaseId, expires_at: clock.now() + 30_000, last_seq: 0 });
    expect((await call("POST", `/sessions/s1/lease/${g.leaseId}/renew`, { ttl_s: 50 }, g.token)).body!.expires_at).toBe(clock.now() + 50_000);
    clock.advance(50_000);
    expect((await call("POST", `/sessions/s1/lease/${g.leaseId}/renew`, undefined, g.token)).body).toEqual({ code: "lease_lost" });
    expect(store.lease("s1")).toBeNull();
    const second = await call("POST", "/sessions/s1/lease", { holder: "engine:b:2", ttl_s: 30 });
    expect(second.body).toEqual({ lease_id: expect.any(String), expires_at: clock.now() + 30_000, last_seq: 0 });
    expect((await call("DELETE", `/sessions/s1/lease/${g.leaseId}`, undefined, g.token)).body).toEqual({ code: "lease_lost" });
    expect((await call("DELETE", `/sessions/s1/lease/${second.body!.lease_id}`, undefined, g.token)).status).toBe(403);
    expect((await call("DELETE", `/sessions/s1/lease/${second.body!.lease_id}`)).status).toBe(204);
    expect(store.lease("s1")).toBeNull();
  });

  test("limits: 256 events, 1 MiB summed over data, a 2 MiB body; a bad kind or negative ts_ms is invalid_event with its index", async () => {
    const g = leased();
    const tooLarge = { code: "batch_too_large", max_events: 256, max_bytes: 1048576 };
    expect((await append("s1", g, 0, Array.from({ length: 257 }, (_, i) => ev(i)))).body).toEqual(tooLarge);
    const half = "x".repeat(512 * 1024 - 2); // a JSON string of exactly 512 KiB
    expect((await append("s1", g, 0, [{ kind: "log", data: half, ts_ms: 1 }, { kind: "log", data: half, ts_ms: 1 }])).status).toBe(200);
    expect((await append("s1", g, 2, [{ kind: "log", data: half, ts_ms: 1 }, { kind: "log", data: `${half}x`, ts_ms: 1 }])).body).toEqual(tooLarge);
    expect((await append("s1", g, 2, [ev(1), { kind: "a".repeat(65), data: {}, ts_ms: 1 }])).body).toMatchObject({ code: "invalid_event", index: 1 });
    expect((await append("s1", g, 2, [{ kind: "log", data: {}, ts_ms: -1 }])).body).toMatchObject({ code: "invalid_event", index: 0 });
    expect((await append("s1", g, 2, [])).body).toMatchObject({ code: "invalid_body" });
    expect((await call("POST", "/sessions/s1/events", "{not json", g.token)).body).toMatchObject({ code: "invalid_body" });
    expect(store.events("s1")).toHaveLength(2);
  });

  test("one event over 1 MiB goes alone up to max_event_bytes; over it, 413 event_too_large; shared batches keep the 1 MiB sum", async () => {
    await store.stop();
    store = startFakeSessionStore({ clock: clock.now, maxEventBytes: 3 * 1024 * 1024 });
    const g = leased();
    const big = (n: number) => ({ kind: "tool_result", data: "x".repeat(n), ts_ms: 1 });
    expect((await append("s1", g, 0, [big(2 * 1024 * 1024)])).body).toEqual({ first_seq: 1, last_seq: 1 });
    expect((await append("s1", g, 1, [big(4 * 1024 * 1024)])).body).toEqual({ code: "event_too_large", max_event_bytes: 3 * 1024 * 1024 });
    expect((await append("s1", g, 1, [big(600 * 1024), big(600 * 1024)])).body).toMatchObject({ code: "batch_too_large" });
    expect(store.events("s1")).toHaveLength(1);
  });

  test("injected busy answers carry the store's Retry-After", async () => {
    leased();
    for (const [code, after] of [["store_busy", "1"], ["session_busy", "1"]] as const) {
      store.failNext("read", 503, code);
      const res = await fetch(`${store.url}/sessions/s1/events`, { headers: { authorization: `Bearer ${store.controlToken}` } });
      expect([res.status, res.headers.get("retry-after")]).toEqual([503, after]);
    }
  });

  test("tokens: none or unknown is 401; an engine token is scoped to its session and lease; a reader reads only its own session", async () => {
    const g = leased("s1");
    store.createSession("s2", { owner: "cust_9" });
    expect((await call("GET", "/sessions/s1/events", undefined, null)).body).toEqual({ code: "unauthorized" });
    expect((await call("GET", "/sessions/s1/events", undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/sessions/s1", undefined, g.token)).status).toBe(200);
    expect((await call("GET", "/sessions/s2", undefined, g.token)).body).toEqual({ code: "forbidden" });
    expect((await call("POST", "/sessions/s1/events", { lease_id: "other", after_seq: 0, events: [ev(1)] }, g.token)).body).toEqual({ code: "forbidden" });
    const reader = store.readerToken("s1");
    expect((await call("GET", "/sessions/s1", undefined, reader)).body!.lease).toEqual({ expires_at: clock.now() + 30_000 });
    expect((await call("GET", "/sessions/s1")).body!.lease).toEqual({ holder: "engine:test:1", expires_at: clock.now() + 30_000 });
    expect((await call("GET", "/sessions/s1", undefined, store.readerToken("s1", "cust_9"))).body).toEqual({ code: "unknown_session" });
    expect((await call("POST", "/sessions/s1/events", { lease_id: g.leaseId, after_seq: 0, events: [ev(1)] }, reader)).status).toBe(403);
    expect((await call("GET", "/sessions/s1", undefined, store.readerToken("s1", null))).body).toEqual({ code: "unauthorized" }); // a {sid} reader needs a principal
  });

  test("the projection lists every open park; a persisted park is idle, a live ask requires action; a new turn clears an approval park", async () => {
    const g = leased();
    let seq = 0;
    const post = async (...events: { kind: string; data: unknown }[]) => {
      const r = await append("s1", g, seq, events.map((e, i) => ({ ...e, ts_ms: 1000 + seq + i })));
      expect(r.status).toBe(200);
      seq = r.body!.last_seq;
      return (await call("GET", "/sessions/s1")).body!;
    };
    const entry = (payload: Record<string, unknown>) => ({ kind: payload.type as string, data: { uuid: crypto.randomUUID(), parentUuid: null, ts: "t", payload } });
    expect(await post(entry({ type: "user" }))).toMatchObject({ status: "running", parks: [] });
    const parkedQ = await post({ kind: "question_parked", data: { id: "q1", questions: [] } });
    expect(parkedQ).toMatchObject({ status: "idle", parks: [{ kind: "parked_question", id: "q1" }], park: { kind: "parked_question", id: "q1" } });
    await post(entry({ type: "user" }), { kind: "permission_request", data: { id: "p1" } });
    const busy = (await call("GET", "/sessions/s1")).body!;
    expect(busy).toMatchObject({ status: "requires_action", park: { kind: "permission", id: "p1" } });
    expect(busy.parks.map((p: { id: string }) => p.id)).toEqual(["q1", "p1"]);
    const approval = await post({ kind: "ask_answered", data: { id: "p1" } }, entry({ type: "result", subtype: "needs_approval", usage: { input_tokens: 5, output_tokens: 2, compute_units: 0.5 } }));
    expect(approval).toMatchObject({ status: "idle", stop_reason: "needs_approval", usage: { input_tokens: 5, output_tokens: 2, cost_cu: 0.5 } });
    expect(approval.parks.map((p: { kind: string }) => p.kind)).toEqual(["parked_question", "approval"]);
    const next = await post(entry({ type: "user" }));
    expect(next.parks.map((p: { kind: string }) => p.kind)).toEqual(["parked_question"]);
    expect(next.stop_reason).toBeUndefined();
    const answered = await post({ kind: "question_answered", data: { id: "q1" } }, entry({ type: "error", message: "boom" }));
    expect(answered).toMatchObject({ status: "ended", stop_reason: "error", parks: [] });
    expect(answered.park).toBeUndefined();
  });

  test("erasure: the stub answers again; the session is 410 to its readers and gone from listings", async () => {
    const g = leased();
    await append("s1", g, 0, [ev(1)]);
    const stub = (await call("DELETE", "/sessions/s1")).body!;
    expect(stub).toMatchObject({ sid: "s1", last_seq: 1, deleted_at: clock.now() });
    expect((await call("DELETE", "/sessions/s1")).body).toEqual(stub);
    expect((await call("GET", "/sessions/s1/events", undefined, g.token)).body).toEqual({ code: "session_deleted", deleted_at: clock.now() });
    expect((await call("GET", "/sessions?owner=cust_7")).body).toEqual({ sessions: [], next_after_id: null });
    expect(store.events("s1")).toEqual([]);
    for (const [method, path] of [["GET", "/sessions/s1"], ["POST", "/sessions/s1/lease"], ["GET", "/sessions/s1/stream"], ["POST", `/sessions/s1/lease/${g.leaseId}/renew`]]) {
      expect((await call(method!, path!, method === "POST" ? { holder: "h", ttl_s: 30 } : undefined)).status).toBe(410);
    }
  });

  test("the projection carries a typed refusal: it is also the stop_reason, and the next turn clears it", async () => {
    const g = leased();
    const entry = (payload: Record<string, unknown>) => ({ kind: payload.type as string, data: { uuid: crypto.randomUUID(), parentUuid: null, ts: "t", payload }, ts_ms: 1 });
    expect((await call("GET", "/sessions/s1")).body).toMatchObject({ refusal: null });
    await append("s1", g, 0, [entry({ type: "user" }), entry({ type: "error", message: "no", refusal: { code: "model_access_denied" } })]);
    expect((await call("GET", "/sessions/s1")).body).toMatchObject({ status: "ended", stop_reason: "model_access_denied", refusal: { code: "model_access_denied" } });
    await append("s1", g, 2, [entry({ type: "user" })]);
    const next = (await call("GET", "/sessions/s1")).body!;
    expect(next).toMatchObject({ status: "running", refusal: null });
    expect(next.stop_reason).toBeUndefined();
  });

  test("a stream ends when its session is erased", async () => {
    const g = leased();
    await append("s1", g, 0, [ev(1)]);
    const res = await fetch(`${store.url}/sessions/s1/stream`, { headers: { authorization: `Bearer ${store.controlToken}` } });
    const reader = res.body!.getReader();
    await reader.read();
    await call("DELETE", "/sessions/s1");
    for (;;) if ((await reader.read()).done) break;
  });

  test("the list's leased filter keeps the sessions whose lease is live now; anything but true or false is invalid_leased", async () => {
    leased("a");
    store.createSession("b");
    const names = async (q: string) => (await call("GET", `/sessions?owner=cust_7&${q}`)).body!.sessions.map((s: { sid: string }) => s.sid);
    expect(await names("leased=true")).toEqual(["a"]);
    expect(await names("leased=false")).toEqual(["b"]);
    clock.advance(31_000);
    expect(await names("leased=true")).toEqual([]);
    expect((await call("GET", "/sessions?owner=cust_7&leased=yes")).body).toMatchObject({ code: "invalid_leased" });
  });

  test("failNext answers one request with the given status and code; dropNext commits and never answers", async () => {
    const g = leased();
    store.failNext("read", 503, "store_unavailable");
    expect(await call("GET", "/sessions/s1/events")).toEqual({ status: 503, body: { code: "store_unavailable" } });
    expect((await call("GET", "/sessions/s1/events")).status).toBe(200);
    store.dropNext("append");
    const dropped = fetch(`${store.url}/sessions/s1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${g.token}`, "content-type": "application/json" },
      body: JSON.stringify({ lease_id: g.leaseId, after_seq: 0, events: [ev(1)] }),
      signal: AbortSignal.timeout(50),
    });
    await expect(dropped).rejects.toThrow();
    expect(store.events("s1").map((e) => e.seq)).toEqual([1]);
  });

  test("stream: SSE from `after`, live appends follow, Last-Event-ID wins over after, a cursor past the head is 400", async () => {
    const g = leased();
    await append("s1", g, 0, [ev(1), ev(2), ev(3)]);
    const first = await readSse("/sessions/s1/stream?after=1", {}, 3, () => append("s1", g, 3, [ev(4)]));
    expect(first.map((f) => f.id)).toEqual(["2", "3", "4"]);
    expect(first[0]).toEqual({ id: "2", event: "log", data: JSON.stringify(ev(2).data) });
    const resumed = await readSse("/sessions/s1/stream?after=0", { "last-event-id": "3" }, 1);
    expect(resumed.map((f) => f.id)).toEqual(["4"]);
    expect((await call("GET", "/sessions/s1/stream?after=9")).body).toMatchObject({ code: "invalid_cursor" });
  });
});

/** Reads `n` SSE frames from a stream, running `whileOpen` once the stream is connected. */
async function readSse(path: string, headers: Record<string, string>, n: number, whileOpen?: () => Promise<unknown>) {
  const ctl = new AbortController();
  const res = await fetch(`${store.url}${path}`, { headers: { authorization: `Bearer ${store.controlToken}`, ...headers }, signal: ctl.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: { id: string; event: string; data: string }[] = [];
  let buf = "";
  if (whileOpen) void whileOpen();
  while (frames.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1];
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = [...block.matchAll(/^data: (.*)$/gm)].map((m) => m[1]).join("\n");
      if (id !== undefined && event !== undefined) frames.push({ id, event, data });
    }
  }
  ctl.abort();
  return frames;
}
