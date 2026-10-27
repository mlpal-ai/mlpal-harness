/**
 * An in-memory P1 session store (plans/2026-10-27-harness-platform-part-2.md §P1) on Bun.serve,
 * for the engine store's tests: leases with a TTL on an injectable clock, single-writer appends
 * keyed by after_seq, the batch limits, paged reads, an SSE stream, a bearer check, and faults.
 */

export type FakeRoute = "lease" | "renew" | "release" | "append" | "read" | "stream" | "projection";

export interface FakeEvent {
  seq: number;
  kind: string;
  data: unknown;
  ts_ms: number;
  /** The clock when the store committed it (slice 3's metrics). */
  receivedAt: number;
}

export interface FakeSessionMeta {
  owner?: string;
  unit?: string;
  publication?: string;
  hop?: { name: string; version: string; digest: string };
}

export interface FakeLease {
  id: string;
  holder: string;
  ttlS: number;
  expiresAt: number;
}

interface Session {
  sid: string;
  meta: FakeSessionMeta;
  events: FakeEvent[];
  lease: FakeLease | null;
  subscribers: Set<(e: FakeEvent) => void>;
}

export interface FakeSessionStore {
  /** Base url including `/v1`. */
  readonly url: string;
  readonly token: string;
  createSession(sid: string, meta?: FakeSessionMeta): void;
  events(sid: string): FakeEvent[];
  lease(sid: string): FakeLease | null;
  /** The next request on `route` is answered `status` with `{error, code: reason}`, untouched otherwise. */
  failNext(route: FakeRoute, status: number, reason: string): void;
  /** The next request on `route` takes effect, and its response is never sent (the client must time out). */
  dropNext(route: FakeRoute): void;
  stop(): Promise<void>;
}

const MAX_EVENTS = 256;
const MAX_BYTES = 1024 * 1024;
const MAX_TTL_S = 60;
const MAX_LIMIT = 500;

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, code, ...extra }, { status });
}

function wire(e: FakeEvent) {
  return { seq: e.seq, kind: e.kind, data: e.data, ts_ms: e.ts_ms };
}

function sameEvent(stored: FakeEvent, e: { kind: string; data: unknown; ts_ms: number }): boolean {
  return stored.kind === e.kind && stored.ts_ms === e.ts_ms && JSON.stringify(stored.data) === JSON.stringify(e.data);
}

/** The projection's fold over event kinds (phase-1b sub-plan §6). */
function project(s: Session) {
  type Park = { kind: string; id: string; at: string };
  let status = "idle";
  let park: Park | undefined;
  const live = new Map<string, Park>();
  const usage = { input_tokens: 0, output_tokens: 0, cost_cu: 0 };
  for (const e of s.events) {
    const d = (e.data ?? {}) as Record<string, any>;
    const at = new Date(e.ts_ms).toISOString();
    switch (e.kind) {
      case "user":
        if (d.uuid) [status, park] = ["running", undefined];
        break;
      case "result": {
        usage.input_tokens += d.payload?.usage?.input_tokens ?? 0;
        usage.output_tokens += d.payload?.usage?.output_tokens ?? 0;
        if (d.payload?.subtype === "needs_approval") [status, park] = ["requires_action", { kind: "approval", id: d.uuid, at }];
        else [status, park] = ["idle", undefined];
        break;
      }
      case "error":
        if (d.uuid) status = "ended";
        break;
      case "question_parked":
        [status, park] = ["requires_action", { kind: "parked_question", id: d.id, at }];
        break;
      case "question_answered":
        if (park?.kind === "parked_question" && park.id === d.id) [status, park] = ["idle", undefined];
        break;
      case "permission_request":
      case "question_request":
        live.set(d.id, { kind: e.kind === "permission_request" ? "permission" : "question", id: d.id, at });
        break;
      case "ask_answered":
        live.delete(d.id);
        break;
    }
  }
  const liveAsk = [...live.values()].at(-1);
  return {
    sid: s.sid,
    owner: s.meta.owner ?? null,
    unit: s.meta.unit ?? null,
    publication: s.meta.publication ?? null,
    hop: s.meta.hop ?? null,
    status,
    ...(liveAsk ?? park ? { park: liveAsk ?? park } : {}),
    usage,
    last_seq: s.events.length,
    updated_at: new Date(s.events.at(-1)?.receivedAt ?? 0).toISOString(),
  };
}

export function startFakeSessionStore(opts: { clock?: () => number; token?: string } = {}): FakeSessionStore {
  const clock = opts.clock ?? Date.now;
  const token = opts.token ?? "test-token";
  const sessions = new Map<string, Session>();
  const faults = new Map<FakeRoute, { status: number; reason: string } | "drop">();

  const liveLease = (s: Session) => (s.lease && s.lease.expiresAt > clock() ? s.lease : null);

  function route(method: string, parts: string[]): FakeRoute | null {
    const [, , rest, id, verb] = parts;
    if (method === "GET" && parts.length === 2) return "projection";
    if (method === "POST" && rest === "lease" && parts.length === 3) return "lease";
    if (method === "POST" && rest === "lease" && id && verb === "renew") return "renew";
    if (method === "DELETE" && rest === "lease" && id && parts.length === 4) return "release";
    if (rest === "events" && parts.length === 3) return method === "POST" ? "append" : method === "GET" ? "read" : null;
    if (method === "GET" && rest === "stream" && parts.length === 3) return "stream";
    return null;
  }

  async function handle(r: FakeRoute, s: Session, req: Request, url: URL, leaseId: string | undefined): Promise<Response> {
    switch (r) {
      case "projection":
        return Response.json(project(s));
      case "lease": {
        const body = (await req.json()) as { holder?: string; ttl_s?: number };
        if (typeof body.holder !== "string" || typeof body.ttl_s !== "number" || body.ttl_s <= 0 || body.ttl_s > MAX_TTL_S) {
          return fail(400, "invalid_request", `holder and ttl_s (1..${MAX_TTL_S}) are required`);
        }
        if (liveLease(s)) return fail(409, "session_leased", "another lease is live");
        s.lease = { id: crypto.randomUUID(), holder: body.holder, ttlS: body.ttl_s, expiresAt: clock() + body.ttl_s * 1000 };
        return Response.json({ lease_id: s.lease.id, expires_at: new Date(s.lease.expiresAt).toISOString(), last_seq: s.events.length });
      }
      case "renew": {
        const l = liveLease(s);
        if (!l || l.id !== leaseId) return fail(409, "lease_lost", "the lease is gone");
        l.expiresAt = clock() + l.ttlS * 1000;
        return Response.json({ expires_at: new Date(l.expiresAt).toISOString() });
      }
      case "release": {
        const l = liveLease(s);
        if (!l || l.id !== leaseId) return fail(409, "lease_lost", "the lease is gone");
        s.lease = null;
        return new Response(null, { status: 204 });
      }
      case "append": {
        const body = (await req.json()) as { lease_id?: string; after_seq?: number; events?: { kind: string; data: unknown; ts_ms: number }[] };
        const events = body.events;
        if (!Array.isArray(events) || events.length === 0 || typeof body.after_seq !== "number" || events.some((e) => typeof e?.kind !== "string" || !e.kind || typeof e.ts_ms !== "number" || e.data === undefined)) {
          return fail(400, "invalid_request", "lease_id, after_seq and a non-empty events[{kind, data, ts_ms}] are required");
        }
        if (events.length > MAX_EVENTS) return fail(413, "too_many_events", `at most ${MAX_EVENTS} events per batch`);
        if (Buffer.byteLength(JSON.stringify(events)) > MAX_BYTES) return fail(413, "batch_too_large", `at most ${MAX_BYTES} bytes per batch`);
        const l = liveLease(s);
        if (!l || l.id !== body.lease_id) return fail(409, "lease_lost", "the lease is gone");
        const after = body.after_seq;
        const last = s.events.length;
        if (after !== last) {
          const replay = after >= 0 && after + events.length <= last && events.every((e, i) => sameEvent(s.events[after + i]!, e));
          if (replay) return Response.json({ first_seq: after + 1, last_seq: after + events.length });
          return fail(409, "seq_conflict", `after_seq ${after} is not the last seq ${last}`, { last_seq: last });
        }
        const at = clock();
        for (const e of events) {
          const stored: FakeEvent = { seq: s.events.length + 1, kind: e.kind, data: e.data, ts_ms: e.ts_ms, receivedAt: at };
          s.events.push(stored);
          for (const sub of s.subscribers) sub(stored);
        }
        return Response.json({ first_seq: last + 1, last_seq: s.events.length });
      }
      case "read": {
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? MAX_LIMIT);
        if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
          return fail(400, "invalid_request", `after ≥ 0 and limit 1..${MAX_LIMIT}`);
        }
        return Response.json({ events: s.events.slice(after, after + limit).map(wire), last_seq: s.events.length });
      }
      case "stream": {
        const after = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? 0);
        const enc = new TextEncoder();
        const frame = (e: FakeEvent) => enc.encode(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(wire(e))}\n\n`);
        let sub: ((e: FakeEvent) => void) | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(ctl) {
            for (const e of s.events.slice(after)) ctl.enqueue(frame(e));
            sub = (e) => ctl.enqueue(frame(e));
            s.subscribers.add(sub);
          },
          cancel() {
            if (sub) s.subscribers.delete(sub);
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
      }
    }
  }

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${token}`) return fail(401, "unauthorized", "a valid bearer token is required");
      const parts = url.pathname.replace(/^\/v1\//, "").split("/").filter(Boolean);
      if (parts[0] !== "sessions" || !parts[1]) return fail(404, "not_found", "no such route");
      const r = route(req.method, parts);
      if (!r) return fail(404, "not_found", "no such route");
      const fault = faults.get(r);
      if (fault) faults.delete(r);
      if (fault && fault !== "drop") return fail(fault.status, fault.reason, "injected fault");
      const s = sessions.get(decodeURIComponent(parts[1]));
      if (!s) return fail(404, "session_not_found", "no such session");
      const res = await handle(r, s, req, url, parts[3]);
      if (fault === "drop") {
        await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return res;
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    token,
    createSession(sid, meta = {}) {
      sessions.set(sid, { sid, meta, events: [], lease: null, subscribers: new Set() });
    },
    events: (sid) => sessions.get(sid)?.events ?? [],
    lease: (sid) => {
      const s = sessions.get(sid);
      return s ? liveLease(s) : null;
    },
    failNext(r, status, reason) {
      faults.set(r, { status, reason });
    },
    dropNext(r) {
      faults.set(r, "drop");
    },
    stop: () => server.stop(true),
  };
}
