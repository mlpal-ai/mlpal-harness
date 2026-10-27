/**
 * An in-memory P1 session store on Bun.serve for the engine store's tests, kept to the real store's
 * contract (mlpal-harness-stack docs/API.md "session-store", checked against its contract fixtures in
 * fake-session-store.contract.test.ts): role-scoped bearer tokens, leases on an injectable clock,
 * single-writer appends with idempotent replay, the batch limits, paged reads, the SSE stream, the
 * projection's fold, the projection query, erasure, and fault injection.
 */
import { CryptoHasher } from "bun";

export type FakeRoute = "health" | "create" | "list" | "projection" | "delete" | "lease" | "renew" | "release" | "append" | "read" | "stream";

export interface FakeEvent {
  seq: number;
  kind: string;
  data: unknown;
  ts_ms: number;
  /** The clock when the store committed it (slice 3's metrics). */
  receivedAt: number;
}

export interface FakeLease {
  id: string;
  holder: string;
  ttlS: number;
  expiresAt: number;
}

export interface FakeIdentity {
  owner: string;
  unit: string;
  publication: string;
  hop: { name: string; version: string; digest: string };
  origin: string;
}

type Claims =
  | { role: "control" }
  | { role: "engine"; sid: string; leaseId: string }
  | { role: "reader"; sid: string; principal: string }
  | { role: "reader"; owner: string; publication: string };

interface AppendRecord {
  leaseId: string;
  afterSeq: number;
  hash: string;
  firstSeq: number;
  lastSeq: number;
}

interface Session {
  sid: string;
  identity: FakeIdentity;
  events: FakeEvent[];
  lastSeq: number;
  lease: FakeLease | null;
  appends: AppendRecord[];
  subscribers: Set<(e: FakeEvent) => void>;
  updatedAt: number;
  deleted?: { deletedAt: number; contentSha256: string };
}

export interface FakeSessionStore {
  /** Base url including `/v1`. */
  readonly url: string;
  readonly controlToken: string;
  engineToken(sid: string, leaseId: string): string;
  readerToken(sid: string, principal?: string): string;
  scopeReaderToken(owner: string, publication: string): string;
  /** Creates a session as control would (the identity defaults to the store's contract fixtures'). */
  createSession(sid: string, identity?: Partial<FakeIdentity>): void;
  /** Takes a lease as control would, and mints the engine token for it. */
  grant(sid: string, opts?: { holder?: string; ttlS?: number }): { leaseId: string; token: string };
  events(sid: string): FakeEvent[];
  /** The live lease, if any. */
  lease(sid: string): FakeLease | null;
  /** The next request on `route` is answered `status` with `{code, message}`, untouched otherwise. */
  failNext(route: FakeRoute, status: number, code: string): void;
  /** The next request on `route` takes effect, and its response is never sent (the client must time out). */
  dropNext(route: FakeRoute): void;
  stop(): Promise<void>;
}

export const DEFAULT_IDENTITY: FakeIdentity = {
  owner: "cust_7",
  unit: "unit_platform",
  publication: "infra-ro",
  hop: { name: "infra-ro", version: "0.9.2", digest: "sha256:9f2c" },
  origin: "api",
};

const MAX_EVENTS = 256;
const MAX_DATA_BYTES = 1024 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_TTL_S = 60;
const MAX_LIMIT = 500;
const KIND = /^[A-Za-z0-9_.:-]{1,64}$/;
const SID = /^[A-Za-z0-9_-]{1,128}$/;
const RUNNING_KINDS = new Set(["user", "system", "assistant", "tool_started", "tool_result", "tool_use_start", "text_delta", "thinking_delta"]);
const STATUSES = new Set(["idle", "running", "requires_action", "ended"]);

function fail(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ code, ...extra }, { status });
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

type Park = { kind: "permission" | "question" | "approval" | "parked_question"; id: string; at: number };

/** The projection's fold over event kinds (docs/API.md, "Projection"). */
function fold(events: FakeEvent[]) {
  let running = false;
  let ended = false;
  let stopReason: string | undefined;
  let parks: Park[] = [];
  let turn = { usage: false, stop: false, approval: false };
  const usage = { input_tokens: 0, output_tokens: 0, cost_cu: 0 };
  const isLive = (p: Park) => p.kind === "permission" || p.kind === "question";
  const addUsage = (p: Record<string, any>) => {
    const u = p.usage ?? {};
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cost_cu += u.compute_units ?? p.cost ?? 0;
    return p.usage !== undefined;
  };
  const startTurn = () => {
    if (running) return;
    running = true;
    ended = false;
    stopReason = undefined;
    parks = parks.filter((p) => p.kind !== "approval");
    turn = { usage: false, stop: false, approval: false };
  };
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, any>;
    const p = (typeof d.uuid === "string" && d.payload ? d.payload : d) as Record<string, any>;
    if (RUNNING_KINDS.has(e.kind)) startTurn();
    switch (e.kind) {
      case "permission_request":
      case "question_request":
        startTurn();
        parks.push({ kind: e.kind === "permission_request" ? "permission" : "question", id: String(p.id), at: e.ts_ms });
        break;
      case "ask_answered":
        parks = parks.filter((k) => !(isLive(k) && k.id === p.id));
        break;
      case "question_parked":
        parks.push({ kind: "parked_question", id: String(p.id), at: e.ts_ms });
        running = false;
        break;
      case "question_answered":
        parks = parks.filter((k) => !(k.kind === "parked_question" && k.id === p.id));
        break;
      case "result":
        stopReason = p.subtype;
        parks = parks.filter((k) => !isLive(k));
        running = false;
        turn.stop = true;
        if (addUsage(p)) turn.usage = true;
        if (p.subtype === "needs_approval") {
          parks.push({ kind: "approval", id: typeof d.uuid === "string" ? d.uuid : String(e.seq), at: e.ts_ms });
          turn.approval = true;
        }
        break;
      case "done":
        running = false;
        if (!turn.stop) stopReason = p.subtype;
        if (!turn.usage) addUsage(p);
        if (p.pendingApproval && !turn.approval) parks.push({ kind: "approval", id: String(p.pendingApproval.requestId), at: e.ts_ms });
        break;
      case "error":
        ended = true;
        running = false;
        stopReason = "error";
        parks = parks.filter((k) => !isLive(k));
        break;
    }
  }
  const status = parks.some(isLive) ? "requires_action" : running ? "running" : ended ? "ended" : "idle";
  return { status, parks, stopReason, usage };
}

export function startFakeSessionStore(opts: { clock?: () => number } = {}): FakeSessionStore {
  const clock = opts.clock ?? Date.now;
  const sessions = new Map<string, Session>();
  const tokens = new Map<string, Claims>();
  const faults = new Map<FakeRoute, { status: number; code: string } | "drop">();
  let minted = 0;
  const mint = (claims: Claims) => {
    const token = `test-token-${claims.role}-${++minted}`;
    tokens.set(token, claims);
    return token;
  };
  const controlToken = "test-token";
  tokens.set(controlToken, { role: "control" });

  const liveLease = (s: Session) => (s.lease && s.lease.expiresAt > clock() ? s.lease : null);

  function create(sid: string, identity: FakeIdentity): Session {
    const s: Session = { sid, identity, events: [], lastSeq: 0, lease: null, appends: [], subscribers: new Set(), updatedAt: clock() };
    sessions.set(sid, s);
    return s;
  }

  function projection(s: Session, claims: Claims) {
    const f = fold(s.events);
    const l = liveLease(s);
    return {
      sid: s.sid,
      owner: s.identity.owner,
      unit: s.identity.unit,
      publication: s.identity.publication,
      hop: s.identity.hop,
      status: f.status,
      parks: f.parks,
      ...(f.parks.length ? { park: f.parks.at(-1) } : {}),
      ...(f.stopReason !== undefined ? { stop_reason: f.stopReason } : {}),
      usage: f.usage,
      lease: l ? (claims.role === "reader" ? { expires_at: l.expiresAt } : { holder: l.holder, expires_at: l.expiresAt }) : null,
      last_seq: s.lastSeq,
      updated_at: s.updatedAt,
    };
  }

  /** Whether `claims` may read `s`: false answers as 404 (a reader learns nothing outside its scope). */
  function inScope(claims: Claims, s: Session): boolean {
    if (claims.role !== "reader") return true;
    if ("sid" in claims) return claims.principal === s.identity.owner;
    return claims.owner === s.identity.owner && claims.publication === s.identity.publication;
  }

  function route(method: string, parts: string[]): FakeRoute | null {
    const [root, sid, rest, id, verb] = parts;
    if (root === "health" && parts.length === 1 && method === "GET") return "health";
    if (root !== "sessions") return null;
    if (parts.length === 1) return method === "POST" ? "create" : method === "GET" ? "list" : null;
    if (!sid) return null;
    if (parts.length === 2) return method === "GET" ? "projection" : method === "DELETE" ? "delete" : null;
    if (rest === "lease" && parts.length === 3 && method === "POST") return "lease";
    if (rest === "lease" && id && verb === "renew" && parts.length === 5 && method === "POST") return "renew";
    if (rest === "lease" && id && parts.length === 4 && method === "DELETE") return "release";
    if (rest === "events" && parts.length === 3) return method === "POST" ? "append" : method === "GET" ? "read" : null;
    if (rest === "stream" && parts.length === 3 && method === "GET") return "stream";
    return null;
  }

  /** The routes each role may call on a session; a sid-scoped token on another sid is 403. */
  function permitted(r: FakeRoute, claims: Claims, sid: string, leaseId?: string): boolean {
    if (claims.role === "control") return true;
    const reads = r === "read" || r === "stream" || r === "projection";
    if (claims.role === "engine") {
      if (claims.sid !== sid) return false;
      if (r === "renew" || r === "release") return claims.leaseId === leaseId;
      return reads || r === "append";
    }
    if ("sid" in claims && claims.sid !== sid) return false;
    return reads;
  }

  async function body(req: Request): Promise<Record<string, any> | null> {
    const text = await req.text();
    if (!text) return {};
    try {
      const v = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }

  const invalidBody = () => fail(422, "invalid_body", { message: "the body is not the JSON this route takes" });
  const okString = (v: unknown) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 256;

  async function handleCreate(req: Request): Promise<Response> {
    const b = await body(req);
    const hop = b?.hop;
    if (!b || ![b.sid, b.owner, b.unit, b.publication, b.origin, hop?.name, hop?.version, hop?.digest].every(okString)) return invalidBody();
    if (!SID.test(b.sid)) return fail(422, "invalid_sid", { message: "sid must be [A-Za-z0-9_-]{1,128}" });
    if (!/^(ui|api|schedule:.+)$/.test(b.origin)) return fail(422, "invalid_origin", { message: "origin must be ui, api or schedule:<id>" });
    const identity: FakeIdentity = { owner: b.owner, unit: b.unit, publication: b.publication, hop: { name: hop.name, version: hop.version, digest: hop.digest }, origin: b.origin };
    const s = sessions.get(b.sid);
    if (s?.deleted) return fail(410, "session_deleted", { deleted_at: s.deleted.deletedAt });
    if (s) {
      if (JSON.stringify(s.identity) !== JSON.stringify(identity)) return fail(409, "session_exists", { message: "the sid belongs to a session with another identity" });
      return Response.json(projection(s, { role: "control" }), { status: 200 });
    }
    return Response.json(projection(create(b.sid, identity), { role: "control" }), { status: 201 });
  }

  function handleList(url: URL, claims: Claims): Response {
    const q = url.searchParams;
    const filter = { publication: q.get("publication"), owner: q.get("owner"), unit: q.get("unit") };
    if (claims.role === "reader") {
      if ("sid" in claims) return fail(403, "forbidden");
      if ((filter.owner && filter.owner !== claims.owner) || (filter.publication && filter.publication !== claims.publication)) return fail(403, "forbidden");
      filter.owner = claims.owner;
      filter.publication = claims.publication;
    } else if (claims.role !== "control") return fail(403, "forbidden");
    if (!filter.publication && !filter.owner && !filter.unit) return fail(400, "filter_required", { message: "name at least one of publication, owner, unit" });
    const status = q.get("status");
    if (status !== null && !STATUSES.has(status)) return fail(400, "invalid_status", { message: "status must be idle, running, requires_action or ended" });
    const limit = Number(q.get("limit") ?? MAX_LIMIT);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail(400, "invalid_limit", { message: "limit must be 1 to 500" });
    const afterId = q.get("after_id");
    const matching = [...sessions.values()]
      .filter((s) => !s.deleted)
      .filter((s) => (!filter.publication || s.identity.publication === filter.publication) && (!filter.owner || s.identity.owner === filter.owner) && (!filter.unit || s.identity.unit === filter.unit))
      .filter((s) => afterId === null || s.sid > afterId)
      .sort((a, b) => (a.sid < b.sid ? -1 : 1))
      .map((s) => projection(s, claims))
      .filter((p) => status === null || p.status === status);
    const page = matching.slice(0, limit);
    return Response.json({ sessions: page, next_after_id: matching.length > limit ? page.at(-1)!.sid : null });
  }

  function cursor(raw: string | null, s: Session): number | Response {
    const after = raw === null ? 0 : Number(raw);
    if (!Number.isInteger(after) || after < 0) return fail(400, "invalid_cursor", { last_seq: s.lastSeq, message: "the cursor is not an integer ≥ 0" });
    if (after > s.lastSeq) return fail(400, "invalid_cursor", { last_seq: s.lastSeq, message: "the cursor is past the session's last_seq" });
    return after;
  }

  function page(s: Session, after: number, limit: number): FakeEvent[] {
    const out: FakeEvent[] = [];
    let size = 0;
    for (const e of s.events) {
      if (e.seq <= after) continue;
      const b = bytes(e.data);
      if (out.length === limit || (out.length > 0 && size + b > MAX_PAGE_BYTES)) break;
      out.push(e);
      size += b;
    }
    return out;
  }

  const wire = (e: FakeEvent) => ({ seq: e.seq, kind: e.kind, data: e.data, ts_ms: e.ts_ms });

  async function handleSession(r: FakeRoute, s: Session, req: Request, url: URL, claims: Claims, leaseId: string | undefined): Promise<Response> {
    switch (r) {
      case "projection":
        return Response.json(projection(s, claims));
      case "delete":
        return handleDelete(s);
      case "lease": {
        const b = await body(req);
        if (!b || typeof b.holder !== "string" || typeof b.ttl_s !== "number") return invalidBody();
        if (!Number.isInteger(b.ttl_s) || b.ttl_s < 1 || b.ttl_s > MAX_TTL_S) return fail(422, "invalid_ttl", { max_ttl_s: MAX_TTL_S, message: "ttl_s must be 1 to 60" });
        const live = liveLease(s);
        if (live) return fail(409, "session_leased", { expires_at: live.expiresAt });
        s.lease = { id: crypto.randomUUID(), holder: b.holder, ttlS: b.ttl_s, expiresAt: clock() + b.ttl_s * 1000 };
        return Response.json({ lease_id: s.lease.id, expires_at: s.lease.expiresAt, last_seq: s.lastSeq });
      }
      case "renew": {
        const b = await body(req);
        if (!b || (b.ttl_s !== undefined && typeof b.ttl_s !== "number")) return invalidBody();
        if (b.ttl_s !== undefined && (!Number.isInteger(b.ttl_s) || b.ttl_s < 1 || b.ttl_s > MAX_TTL_S)) return fail(422, "invalid_ttl", { max_ttl_s: MAX_TTL_S, message: "ttl_s must be 1 to 60" });
        const l = liveLease(s);
        if (!l || l.id !== leaseId) return fail(409, "lease_lost");
        if (b.ttl_s !== undefined) l.ttlS = b.ttl_s;
        l.expiresAt = clock() + l.ttlS * 1000;
        return Response.json({ lease_id: l.id, expires_at: l.expiresAt, last_seq: s.lastSeq });
      }
      case "release": {
        if (!s.lease || s.lease.id !== leaseId) return fail(409, "lease_lost");
        s.lease = null;
        return new Response(null, { status: 204 });
      }
      case "append":
        return handleAppend(s, req, claims);
      case "read": {
        const after = cursor(url.searchParams.get("after"), s);
        if (after instanceof Response) return after;
        const limit = Number(url.searchParams.get("limit") ?? MAX_LIMIT);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return fail(400, "invalid_limit", { message: "limit must be 1 to 500" });
        return Response.json({ events: page(s, after, limit).map(wire), last_seq: s.lastSeq });
      }
      case "stream":
        return handleStream(s, req, url);
      default:
        return fail(404, "not_found");
    }
  }

  async function handleAppend(s: Session, req: Request, claims: Claims): Promise<Response> {
    const text = await req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return fail(413, "batch_too_large", { max_events: MAX_EVENTS, max_bytes: MAX_DATA_BYTES });
    let b: Record<string, any>;
    try {
      b = JSON.parse(text);
    } catch {
      return invalidBody();
    }
    const events = b?.events as { kind: unknown; data: unknown; ts_ms: unknown }[];
    if (typeof b?.lease_id !== "string" || !Number.isInteger(b.after_seq) || b.after_seq < 0 || !Array.isArray(events) || events.length === 0) return invalidBody();
    if (claims.role === "engine" && claims.leaseId !== b.lease_id) return fail(403, "forbidden");
    if (events.length > MAX_EVENTS || events.reduce((n, e) => n + bytes(e?.data ?? null), 0) > MAX_DATA_BYTES) {
      return fail(413, "batch_too_large", { max_events: MAX_EVENTS, max_bytes: MAX_DATA_BYTES });
    }
    const bad = events.findIndex((e) => typeof e?.kind !== "string" || !KIND.test(e.kind) || !Number.isInteger(e.ts_ms) || (e.ts_ms as number) < 0 || e.data === undefined);
    if (bad >= 0) return fail(422, "invalid_event", { index: bad, message: "kind must be [A-Za-z0-9_.:-]{1,64}" });
    const hasher = new CryptoHasher("sha256");
    for (const e of events) hasher.update(`${e.kind}\n${e.ts_ms}\n${JSON.stringify(e.data)}\n`);
    const hash = hasher.digest("hex");
    const replay = s.appends.find((a) => a.leaseId === b.lease_id && a.afterSeq === b.after_seq && a.hash === hash);
    if (replay) return Response.json({ first_seq: replay.firstSeq, last_seq: replay.lastSeq });
    const l = liveLease(s);
    if (!l || l.id !== b.lease_id) return fail(409, "lease_lost");
    if (b.after_seq !== s.lastSeq) return fail(409, "seq_conflict", { last_seq: s.lastSeq });
    const at = clock();
    const first = s.lastSeq + 1;
    for (const e of events) {
      const stored: FakeEvent = { seq: ++s.lastSeq, kind: e.kind as string, data: e.data, ts_ms: e.ts_ms as number, receivedAt: at };
      s.events.push(stored);
      for (const sub of s.subscribers) sub(stored);
    }
    s.updatedAt = at;
    s.appends.push({ leaseId: b.lease_id, afterSeq: b.after_seq, hash, firstSeq: first, lastSeq: s.lastSeq });
    return Response.json({ first_seq: first, last_seq: s.lastSeq });
  }

  function handleStream(s: Session, req: Request, url: URL): Response {
    const after = cursor(req.headers.get("last-event-id") ?? url.searchParams.get("after"), s);
    if (after instanceof Response) return after;
    const enc = new TextEncoder();
    const frame = (e: FakeEvent) => {
      const data = JSON.stringify(e.data)
        .split("\n")
        .map((line) => `data: ${line}`)
        .join("\n");
      return enc.encode(`id: ${e.seq}\nevent: ${e.kind}\n${data}\n\n`);
    };
    let sub: ((e: FakeEvent) => void) | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(ctl) {
        for (const e of s.events) if (e.seq > after) ctl.enqueue(frame(e));
        sub = (e) => ctl.enqueue(frame(e));
        s.subscribers.add(sub);
        keepAlive = setInterval(() => ctl.enqueue(enc.encode(": keep-alive\n\n")), 15_000);
      },
      cancel() {
        if (sub) s.subscribers.delete(sub);
        clearInterval(keepAlive);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }

  function handleDelete(s: Session): Response {
    if (!s.deleted) {
      const hasher = new CryptoHasher("sha256");
      for (const e of s.events) hasher.update(`${e.seq}\n${e.kind}\n${e.ts_ms}\n${JSON.stringify(e.data)}\n`);
      s.deleted = { deletedAt: clock(), contentSha256: hasher.digest("hex") };
      s.events = [];
      s.appends = [];
      s.lease = null;
      for (const sub of s.subscribers) s.subscribers.delete(sub);
    }
    return Response.json({ sid: s.sid, deleted_at: s.deleted.deletedAt, last_seq: s.lastSeq, content_sha256: s.deleted.contentSha256 });
  }

  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.replace(/^\/v1\//, "").split("/").filter(Boolean).map(decodeURIComponent);
      const r = route(req.method, parts);
      if (!r) return fail(404, "not_found");
      const fault = faults.get(r);
      if (fault) faults.delete(r);
      if (fault && fault !== "drop") return fail(fault.status, fault.code);
      const res = await dispatch(r, req, url, parts);
      if (fault === "drop") await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
      return res;
    },
  });

  async function dispatch(r: FakeRoute, req: Request, url: URL, parts: string[]): Promise<Response> {
    if (r === "health") return Response.json({ ok: true });
    const auth = req.headers.get("authorization");
    const claims = auth?.startsWith("Bearer ") ? tokens.get(auth.slice(7)) : undefined;
    if (!claims) return fail(401, "unauthorized");
    if (r === "create") return claims.role === "control" ? handleCreate(req) : fail(403, "forbidden");
    if (r === "list") return handleList(url, claims);
    const sid = parts[1]!;
    const leaseId = r === "renew" || r === "release" ? parts[3] : undefined;
    if (!permitted(r, claims, sid, leaseId)) return fail(403, "forbidden");
    const s = sessions.get(sid);
    if (!s || !inScope(claims, s)) return fail(404, "unknown_session");
    if (s.deleted) return r === "delete" ? handleDelete(s) : fail(410, "session_deleted", { deleted_at: s.deleted.deletedAt });
    return handleSession(r, s, req, url, claims, leaseId);
  }

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    controlToken,
    engineToken: (sid, leaseId) => mint({ role: "engine", sid, leaseId }),
    readerToken: (sid, principal) => mint({ role: "reader", sid, principal: principal ?? sessions.get(sid)?.identity.owner ?? DEFAULT_IDENTITY.owner }),
    scopeReaderToken: (owner, publication) => mint({ role: "reader", owner, publication }),
    createSession(sid, identity = {}) {
      create(sid, { ...DEFAULT_IDENTITY, ...identity });
    },
    grant(sid, { holder = "engine:test:1", ttlS = 60 } = {}) {
      const s = sessions.get(sid);
      if (!s || liveLease(s)) throw new Error(`fake store: cannot lease ${sid}`);
      s.lease = { id: crypto.randomUUID(), holder, ttlS, expiresAt: clock() + ttlS * 1000 };
      return { leaseId: s.lease.id, token: mint({ role: "engine", sid, leaseId: s.lease.id }) };
    },
    events: (sid) => sessions.get(sid)?.events ?? [],
    lease: (sid) => {
      const s = sessions.get(sid);
      return s ? liveLease(s) : null;
    },
    failNext(r, status, code) {
      faults.set(r, { status, code });
    },
    dropNext(r) {
      faults.set(r, "drop");
    },
    stop: () => server.stop(true),
  };
}
