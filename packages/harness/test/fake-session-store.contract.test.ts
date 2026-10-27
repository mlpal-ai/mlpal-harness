/**
 * The fake store and the client against the real store's contract fixtures
 * (test/fixtures/session-store, see its README). Each fixture's state is rebuilt on a fresh fake the
 * way mlpal-harness-stack's session-store/tests/contract.rs builds it, the fixture's request is sent,
 * and the answer must equal the fixture but for timestamps and minted ids. Separately, the client
 * reads every fixture body of a route it has: a success parses, an error maps to its class.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BatchTooLargeError,
  LeaseHeldError,
  LeaseLostError,
  SeqConflictError,
  SessionDeletedError,
  SessionNotFoundError,
  SessionStoreClient,
  StoreHttpError,
} from "../src/store/remote/client";
import { FakeClock } from "./fake-clock";
import { type FakeSessionStore, startFakeSessionStore } from "./fake-session-store";

const DIR = join(import.meta.dir, "fixtures", "session-store");
const T0 = 1_760_000_000_000;
const SID = "sess-contract-1";

interface Fixture {
  name: string;
  route: string;
  case: string;
  request?: Record<string, unknown>;
  status: number;
  content_type: string | null;
  body: unknown;
  generated?: string[];
}

const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({ name: f.slice(0, -5), ...JSON.parse(readFileSync(join(DIR, f), "utf8")) }));

// ── the store's test events (contract.rs) ─────────────────────────────────────────────────────

/** Keys in sorted order at every depth, as serde_json writes the store's test events: the store keeps
 *  `data` byte for byte, so the stream fixture holds that order. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
}
const ev = (kind: string, data: unknown, ts_ms: number) => ({ kind, data: sorted(data), ts_ms });
const user = () => ev("user", { uuid: "u1", parentUuid: null, ts: "2025-10-09T08:53:20.000Z", payload: { type: "user", message: { role: "user", content: "Reply pong" } } }, T0);
const result = (subtype: string) =>
  ev("result", { uuid: "r1", parentUuid: "u1", ts: "2025-10-09T08:53:21.000Z", payload: { type: "result", subtype, numTurns: 1, usage: { input_tokens: 12, output_tokens: 3, compute_units: 0.0004 } } }, T0 + 1_000);
const deltas = (n: number) => Array.from({ length: n }, (_, i) => ev("text_delta", { type: "text_delta", text: `t${i}` }, T0));

// ── a scenario per fixture ───────────────────────────────────────────────────────────────────

class Ctx {
  readonly clock = new FakeClock(T0);
  readonly fake: FakeSessionStore = startFakeSessionStore({ clock: this.clock.now });
  lease = "";
  engine = "";

  send(method: string, path: string, opts: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const token = opts.token === undefined ? this.fake.controlToken : opts.token;
    return fetch(`${this.fake.url}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.body === undefined ? {} : { "content-type": "application/json" }), ...opts.headers },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  }

  /** The fixture's request with the lease placeholder filled in. */
  request(f: Fixture): unknown {
    return JSON.parse(JSON.stringify(f.request).replaceAll("<lease_id>", this.lease));
  }

  leased(sid = SID, ttlS = 60): void {
    this.fake.createSession(sid);
    const g = this.fake.grant(sid, { ttlS });
    this.lease = g.leaseId;
    this.engine = g.token;
  }

  async append(afterSeq: number, events: unknown[], sid = SID): Promise<void> {
    const res = await this.send("POST", `/sessions/${sid}/events`, { token: this.engine, body: { lease_id: this.lease, after_seq: afterSeq, events } });
    expect(res.status).toBe(200);
  }

  async erase(sid = SID): Promise<void> {
    expect((await this.send("DELETE", `/sessions/${sid}`)).status).toBe(200);
  }
}

type Scenario = (c: Ctx, f: Fixture) => Promise<Response>;

const create = (c: Ctx, f: Fixture, token?: string | null) => c.send("POST", "/sessions", { token, body: c.request(f) });
const appendReq = (c: Ctx, f: Fixture, token = c.engine) => c.send("POST", `/sessions/${SID}/events`, { token, body: c.request(f) });
const projectionAfter =
  (events: unknown[]): Scenario =>
  async (c) => {
    c.leased();
    if (events.length) await c.append(0, events);
    return c.send("GET", `/sessions/${SID}`, { token: c.fake.readerToken(SID) });
  };
const readSetup = async (c: Ctx) => {
  c.leased();
  await c.append(0, [user(), ev("permission_request", { type: "permission_request", id: "perm-1", sessionId: SID, toolName: "Bash", input: { command: "ls" } }, T0 + 300), result("success")]);
};
const listSetup = async (c: Ctx) => {
  for (const sid of ["sess-a", "sess-b", "sess-c"]) c.fake.createSession(sid);
  const g = c.fake.grant("sess-b");
  [c.lease, c.engine] = [g.leaseId, g.token];
  await c.append(0, [user()], "sess-b");
};
const first = async (c: Ctx) => {
  c.leased();
  await c.append(0, [user(), ev("text_delta", { type: "text_delta", text: "po" }, T0 + 250)]);
};

const scenarios: Record<string, Scenario> = {
  "health-200": (c) => c.send("GET", "/health", { token: null }),
  "create-201": (c, f) => create(c, f),
  "create-200-retried": async (c, f) => (await create(c, f), create(c, f)),
  "create-409-session-exists": async (c, f) => (c.fake.createSession(SID), create(c, f)),
  "create-422-invalid-body": (c, f) => create(c, f),
  "create-422-invalid-sid": (c, f) => create(c, f),
  "create-422-invalid-origin": (c, f) => create(c, f),
  "create-401-unauthorized": (c, f) => create(c, f, null),
  "create-403-forbidden": (c, f) => create(c, f, c.fake.readerToken(SID)),
  "create-410-session-deleted": async (c, f) => (c.fake.createSession(SID), await c.erase(), create(c, f)),
  "delete-200": async (c) => (c.leased(), await c.append(0, [user(), result("success")]), c.clock.advance(5_000), c.send("DELETE", `/sessions/${SID}`)),
  "delete-200-repeated": async (c) => (c.leased(), await c.append(0, [user(), result("success")]), c.clock.advance(5_000), await c.erase(), c.send("DELETE", `/sessions/${SID}`)),
  "delete-404-unknown-session": (c) => c.send("DELETE", "/sessions/sess-none"),
  "lease-200": (c, f) => (c.fake.createSession(SID), c.send("POST", `/sessions/${SID}/lease`, { body: f.request })),
  "lease-409-session-leased": (c, f) => (c.leased(), c.send("POST", `/sessions/${SID}/lease`, { body: f.request })),
  "lease-422-invalid-ttl": (c, f) => (c.fake.createSession(SID), c.send("POST", `/sessions/${SID}/lease`, { body: f.request })),
  "lease-404-unknown-session": (c, f) => c.send("POST", "/sessions/sess-none/lease", { body: f.request }),
  "renew-200": (c) => (c.leased(), c.clock.advance(20_000), c.send("POST", `/sessions/${SID}/lease/${c.lease}/renew`, { token: c.engine })),
  "renew-403-forbidden": (c) => (c.leased(), c.send("POST", `/sessions/${SID}/lease/${c.lease}/renew`, { token: c.fake.engineToken(SID, "another-lease") })),
  "renew-409-lease-lost": (c) => (c.leased(), c.clock.advance(81_000), c.send("POST", `/sessions/${SID}/lease/${c.lease}/renew`, { token: c.engine })),
  "release-204": (c) => (c.leased(SID, 30), c.send("DELETE", `/sessions/${SID}/lease/${c.lease}`, { token: c.engine })),
  "release-409-lease-lost": async (c) => (c.leased(SID, 30), await c.send("DELETE", `/sessions/${SID}/lease/${c.lease}`, { token: c.engine }), c.send("DELETE", `/sessions/${SID}/lease/${c.lease}`, { token: c.engine })),
  "append-200": (c, f) => (c.leased(), appendReq(c, f)),
  "append-200-retried": async (c, f) => (c.leased(), await appendReq(c, f), appendReq(c, f)),
  "append-409-seq-conflict": async (c, f) => (await first(c), appendReq(c, f)),
  "append-422-invalid-event": async (c, f) => (await first(c), appendReq(c, f)),
  "append-413-batch-too-large": async (c) => (await first(c), c.send("POST", `/sessions/${SID}/events`, { token: c.engine, body: { lease_id: c.lease, after_seq: 2, events: deltas(257) } })),
  "append-403-forbidden": async (c, f) => (await first(c), appendReq(c, f, c.fake.readerToken(SID))),
  "append-409-lease-lost": async (c, f) => (await first(c), c.clock.advance(61_000), appendReq(c, f)),
  "append-410-session-deleted": async (c, f) => (await first(c), c.clock.advance(61_000), await c.erase(), appendReq(c, f)),
  // The fake has no object storage; the fault stands in for it being down.
  "append-503-blobs-unavailable": (c) => (
    c.leased(),
    c.fake.failNext("append", 503, "blobs_unavailable"),
    c.send("POST", `/sessions/${SID}/events`, { token: c.engine, body: { lease_id: c.lease, after_seq: 0, events: [ev("tool_result", { type: "tool_result", content: "y".repeat(70 * 1024) }, T0)] } })
  ),
  "read-200": async (c) => (await readSetup(c), c.send("GET", `/sessions/${SID}/events?after=1&limit=2`, { token: c.fake.readerToken(SID) })),
  "read-400-invalid-cursor": async (c) => (await readSetup(c), c.send("GET", `/sessions/${SID}/events?after=9`, { token: c.fake.readerToken(SID) })),
  "read-400-invalid-limit": async (c) => (await readSetup(c), c.send("GET", `/sessions/${SID}/events?limit=501`, { token: c.fake.readerToken(SID) })),
  "read-404-unknown-session": (c) => c.send("GET", "/sessions/sess-none/events"),
  "stream-200": async (c) => (await readSetup(c), c.send("GET", `/sessions/${SID}/stream?after=0`, { token: c.fake.readerToken(SID), headers: { "last-event-id": "0" } })),
  "projection-200-idle": projectionAfter([]),
  "projection-200-running": projectionAfter([user()]),
  "projection-200-permission": projectionAfter([user(), ev("permission_request", { type: "permission_request", id: "perm-1" }, T0 + 300)]),
  "projection-200-question": projectionAfter([user(), ev("question_request", { type: "question_request", id: "q-1", questions: [] }, T0 + 300)]),
  "projection-200-approval": projectionAfter([user(), result("needs_approval")]),
  "projection-200-parked-question": projectionAfter([user(), ev("question_parked", { type: "question_parked", id: "q-7", questions: [] }, T0 + 500)]),
  "projection-200-ended": projectionAfter([user(), ev("error", { uuid: "e1", payload: { type: "error", message: "model refused", ts: "t" } }, T0 + 200)]),
  "projection-200-refusal": projectionAfter([
    user(),
    ev(
      "result",
      {
        uuid: "r1",
        payload: {
          type: "result",
          subtype: "error",
          numTurns: 1,
          usage: { input_tokens: 12, output_tokens: 0 },
          refusal: { code: "budget_exceeded", model: "gpt-6-sol", hop: "infra-ro", reason: "gateway", message: "the daily budget is spent", window: "daily" },
        },
      },
      T0 + 1_000,
    ),
  ]),
  "projection-410-session-deleted": async (c) => (c.fake.createSession(SID), await c.erase(), c.send("GET", `/sessions/${SID}`)),
  "list-200": async (c) => (await listSetup(c), c.send("GET", "/sessions?publication=infra-ro&status=running")),
  "list-200-leased": async (c) => (await listSetup(c), c.fake.grant("sess-c", { ttlS: 30 }), c.send("GET", "/sessions?publication=infra-ro&leased=true")),
  "list-200-page": async (c) => (await listSetup(c), c.send("GET", "/sessions?owner=cust_7&limit=2")),
  "list-400-filter-required": async (c) => (await listSetup(c), c.send("GET", "/sessions?status=running")),
  "list-400-invalid-status": async (c) => (await listSetup(c), c.send("GET", "/sessions?owner=cust_7&status=busy")),
  "list-403-forbidden": async (c) => (await listSetup(c), c.send("GET", "/sessions?owner=cust_8", { token: c.fake.scopeReaderToken("cust_7", "infra-ro") })),
};

/** Timestamps and minted values are checked for their type, then masked. */
function masked(v: unknown, generated: string[], top = true): unknown {
  if (Array.isArray(v)) return v.map((x) => masked(x, generated, false));
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "at" || k.endsWith("_at")) {
      expect(Number.isInteger(x)).toBe(true);
      out[k] = "<ms>";
    } else if (k === "content_sha256") {
      expect(x).toMatch(/^[0-9a-f]{64}$/);
      out[k] = "<sha256>";
    } else if (top && generated.includes(k)) {
      expect(typeof x === "string" && x.length > 0).toBe(true);
      out[k] = "<generated>";
    } else out[k] = masked(x, generated, false);
  }
  return out;
}

async function readSse(res: Response, frames: number): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.split("\n\n").length - 1 < frames) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

let ctx: Ctx | undefined;
afterEach(async () => {
  await ctx?.fake.stop();
  ctx = undefined;
});

describe("the fake store answers every contract fixture as the real store does", () => {
  test("every fixture has a scenario, and every scenario a fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.map((f) => f.name).filter((n) => !scenarios[n])).toEqual([]);
    expect(Object.keys(scenarios).filter((n) => !fixtures.some((f) => f.name === n))).toEqual([]);
  });

  for (const f of fixtures) {
    test(`${f.name}: ${f.case}`, async () => {
      const scenario = scenarios[f.name];
      if (!scenario) throw new Error(`no scenario for fixture ${f.name}`);
      ctx = new Ctx();
      const res = await scenario(ctx, f);
      expect(res.status).toBe(f.status);
      const type = res.headers.get("content-type")?.split(";")[0] ?? null;
      expect(f.content_type === null ? type === null || res.status === 204 : type === f.content_type).toBe(true);
      if (f.content_type === "text/event-stream") {
        expect(await readSse(res, 3)).toBe(f.body as string);
      } else if (f.content_type === null) {
        expect(await res.text()).toBe("");
      } else {
        expect(masked(await res.json(), f.generated ?? [])).toEqual(masked(f.body, f.generated ?? []));
      }
    });
  }
});

// ── the client reads each fixture body ──────────────────────────────────────────────────────

type ClientCall = (c: SessionStoreClient) => Promise<unknown>;

const clientCalls: Record<string, ClientCall> = {
  lease: (c) => c.lease(SID, { holder: "engine:node-a:4242", ttlS: 60 }),
  renew: (c) => c.renew(SID, "L"),
  release: (c) => c.release(SID, "L"),
  append: (c) => c.append(SID, { leaseId: "L", afterSeq: 0, events: [ev("text_delta", {}, T0)] }),
  read: (c) => c.read(SID, { after: 1, limit: 2 }),
  projection: (c) => c.projection(SID),
  stream: async (c) => {
    const events: unknown[] = [];
    for await (const e of c.stream(SID, { after: 0 })) events.push(e);
    return events;
  },
};

const noClientRoute: Record<string, string> = {
  health: "an open liveness route",
  create: "control-only",
  list: "control-only",
  delete: "control-only",
};

function errorClass(f: Fixture): typeof StoreHttpError {
  const code = (f.body as { code: string }).code;
  if (f.status === 404) return SessionNotFoundError;
  if (f.status === 410) return SessionDeletedError;
  if (f.status === 413) return BatchTooLargeError;
  if (code === "session_leased") return LeaseHeldError;
  if (code === "lease_lost") return LeaseLostError;
  if (code === "seq_conflict") return SeqConflictError;
  return StoreHttpError;
}

function successShape(op: string, v: unknown): void {
  const n = expect.any(Number);
  switch (op) {
    case "lease":
    case "renew":
      expect(v).toEqual({ leaseId: expect.any(String), expiresAt: n, lastSeq: n });
      return;
    case "release":
      expect(v).toBeUndefined();
      return;
    case "append":
      expect(v).toEqual({ firstSeq: n, lastSeq: n });
      return;
    case "read": {
      const r = v as { events: unknown[]; lastSeq: number };
      expect(r.lastSeq).toEqual(n);
      for (const e of r.events) expect(e).toEqual({ seq: n, kind: expect.any(String), data: expect.anything(), ts_ms: n });
      return;
    }
    case "stream": {
      const events = v as { seq: number; kind: string; data: unknown }[];
      expect(events.map((e) => [e.seq, e.kind])).toEqual([
        [1, "user"],
        [2, "permission_request"],
        [3, "result"],
      ]);
      expect(events[2]!.data).toMatchObject({ uuid: "r1", payload: { type: "result" } });
      return;
    }
    case "projection": {
      const p = v as Record<string, any>;
      // A clone: Bun's toMatchObject writes its asymmetric matchers into the object it is given.
      expect(structuredClone(p)).toMatchObject({ sid: SID, status: expect.any(String), parks: expect.any(Array), usage: { inputTokens: n, outputTokens: n, costCu: n }, lastSeq: n, updatedAt: n });
      for (const park of [...p.parks, ...(p.park ? [p.park] : [])]) expect(park).toEqual({ kind: expect.any(String), id: expect.any(String), at: n });
      expect(p.park).toEqual(p.parks.at(-1));
      if (p.lease) expect(p.lease.expiresAt).toEqual(n);
      expect(p.refusal === null || typeof p.refusal.code === "string").toBe(true);
      if (p.refusal) expect(p.stopReason).toBe(p.refusal.code);
      return;
    }
  }
}

describe("SessionStoreClient reads every fixture body of its routes", () => {
  for (const f of fixtures) {
    const op = f.name.split("-")[0]!;
    const call = clientCalls[op];
    if (!call) {
      test.skip(`${f.name}: the client has no ${op} route (${noClientRoute[op] ?? "unknown"})`, () => {});
      continue;
    }
    test(`${f.name}: ${f.status === 200 || f.status === 204 ? "parses" : "maps to its error class"}`, async () => {
      const respond = () =>
        new Response(f.body === null ? null : typeof f.body === "string" ? f.body : JSON.stringify(f.body), { status: f.status, headers: f.content_type ? { "content-type": f.content_type } : {} });
      const client = new SessionStoreClient({ baseUrl: "http://store/v1", tokenProvider: () => "test-token", fetch: async () => respond(), sleep: async () => {} });
      const out = await call(client).then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e: e as StoreHttpError }),
      );
      if (f.status < 300) {
        expect(out.ok).toBe(true);
        if (out.ok) successShape(op, out.v);
        return;
      }
      expect(out.ok).toBe(false);
      if (out.ok) return;
      const body = f.body as Record<string, unknown>;
      expect(out.e).toBeInstanceOf(errorClass(f));
      expect(out.e).toMatchObject({ status: f.status, code: body.code });
      if (out.e instanceof SeqConflictError) expect(out.e.lastSeq).toBe(body.last_seq as number);
      if (out.e instanceof LeaseHeldError) expect(out.e.expiresAt).toBe(body.expires_at as number);
      if (out.e instanceof SessionDeletedError) expect(out.e.deletedAt).toBe(body.deleted_at as number);
      if (out.e instanceof BatchTooLargeError) expect([out.e.maxEvents, out.e.maxBytes]).toEqual([256, 1024 * 1024]);
    });
  }
});
