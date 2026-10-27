/**
 * The engine's client for the P1 session store (mlpal-harness-stack docs/API.md, "session-store"):
 * leases, single-writer appends keyed by `after_seq`, paged reads and the projection. Pure
 * TypeScript over an injected fetch, so it runs in the engine, a test, or any host. Every store
 * timestamp is an integer of unix milliseconds.
 */
import type { Logger } from "../../obs/logger";
import { silentLogger } from "../../obs/logger";

/** An event as the engine appends it: `kind` is the protocol frame's `type`, `data` the frame. */
export interface StoreEvent {
  kind: string;
  data: unknown;
  ts_ms: number;
}

export interface StoredEvent extends StoreEvent {
  seq: number;
}

export interface SessionPark {
  kind: "permission" | "question" | "approval" | "parked_question";
  id: string;
  at: number;
}

export interface SessionProjection {
  sid: string;
  owner: string;
  unit: string;
  publication: string;
  hop: { name: string; version: string; digest: string };
  status: "idle" | "running" | "requires_action" | "ended";
  /** Every open park, oldest first: what a person owes. */
  parks: SessionPark[];
  /** The newest of `parks`. */
  park?: SessionPark;
  stopReason?: string;
  usage: { inputTokens: number; outputTokens: number; costCu: number };
  /** The live lease; a reader is not shown its holder. */
  lease: { holder?: string; expiresAt: number } | null;
  lastSeq: number;
  updatedAt: number;
}

export type StoreFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SessionStoreClientOptions {
  /** The store's base url, `…/v1`. */
  baseUrl: string;
  /** The bearer for each request, read per request so a rotated grant or token file takes effect. */
  tokenProvider: () => string;
  fetch?: StoreFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Per-request timeout (default 5000 ms); a timed-out append counts as a network failure. */
  timeoutMs?: number;
  logger?: Logger;
}

/** The store answered with a status that is not 2xx; `code` is the body's, the contract. */
export class StoreHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "StoreHttpError";
  }
}

/** 409 `session_leased`: another holder's lease is live until `expiresAt`. */
export class LeaseHeldError extends StoreHttpError {
  override name = "LeaseHeldError";
  constructor(
    message: string,
    status: number,
    code: string,
    readonly expiresAt?: number,
  ) {
    super(message, status, code);
  }
}

/** 409 `lease_lost`: the lease this engine wrote under is gone (lapsed leases are never revived). */
export class LeaseLostError extends StoreHttpError {
  override name = "LeaseLostError";
}

/** 409 `seq_conflict`: `after_seq` is not the store's last seq; another writer owns the session. */
export class SeqConflictError extends StoreHttpError {
  override name = "SeqConflictError";
  constructor(
    message: string,
    status: number,
    code: string,
    readonly lastSeq?: number,
  ) {
    super(message, status, code);
  }
}

/** 404 `unknown_session`: no such session, or none this token may see (control creates sessions). */
export class SessionNotFoundError extends StoreHttpError {
  override name = "SessionNotFoundError";
}

/** 410 `session_deleted`: the session was erased; its sid is never reused. */
export class SessionDeletedError extends StoreHttpError {
  override name = "SessionDeletedError";
  constructor(
    message: string,
    status: number,
    code: string,
    readonly deletedAt?: number,
  ) {
    super(message, status, code);
  }
}

/** 413 `batch_too_large`: over the store's per-batch limits. */
export class BatchTooLargeError extends StoreHttpError {
  override name = "BatchTooLargeError";
  constructor(
    message: string,
    status: number,
    code: string,
    readonly maxEvents?: number,
    readonly maxBytes?: number,
  ) {
    super(message, status, code);
  }
}

/** No answer from the store: a refused connection, a reset, or a timeout. */
export class StoreUnreachableError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
    this.name = "StoreUnreachableError";
  }
}

const MAX_READ_LIMIT = 500;
const APPEND_RETRIES = 3;
const RETRY_BASE_MS = 200;

type Op = "lease" | "renew" | "release" | "append" | "read" | "projection";

const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function httpError(op: Op, sid: string, status: number, body: Record<string, unknown>): StoreHttpError {
  const code = typeof body.code === "string" ? body.code : `http_${status}`;
  const message = `session store ${op} (${sid}): ${status} ${code}`;
  if (status === 404) return new SessionNotFoundError(message, status, code);
  if (status === 410) return new SessionDeletedError(message, status, code, num(body.deleted_at));
  if (status === 413) return new BatchTooLargeError(message, status, code, num(body.max_events), num(body.max_bytes));
  if (status === 409 && code === "session_leased") return new LeaseHeldError(message, status, code, num(body.expires_at));
  if (status === 409 && code === "lease_lost") return new LeaseLostError(message, status, code);
  if (status === 409 && code === "seq_conflict") return new SeqConflictError(message, status, code, num(body.last_seq));
  return new StoreHttpError(message, status, code);
}

export class SessionStoreClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: () => string;
  private readonly fetchImpl: StoreFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(opts: SessionStoreClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokenProvider = opts.tokenProvider;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.log = opts.logger ?? silentLogger;
  }

  /** Control-role only: an engine never takes its own lease; it is handed one (`LeaseKeeper.adopt`). */
  async lease(sid: string, opts: { holder: string; ttlS: number }): Promise<LeaseGrant> {
    return grant(await this.call<WireLease>("lease", sid, "POST", "/lease", { holder: opts.holder, ttl_s: opts.ttlS }));
  }

  /** Extends the live lease by its ttl (or `ttlS`); a lapsed lease is never revived (`LeaseLostError`). */
  async renew(sid: string, leaseId: string, ttlS?: number): Promise<LeaseGrant> {
    return grant(await this.call<WireLease>("renew", sid, "POST", `/lease/${encodeURIComponent(leaseId)}/renew`, ttlS === undefined ? undefined : { ttl_s: ttlS }));
  }

  async release(sid: string, leaseId: string): Promise<void> {
    await this.call("release", sid, "DELETE", `/lease/${encodeURIComponent(leaseId)}`);
  }

  /** Retried on a network failure or a 5xx with the same `after_seq`: the store answers a replay
   *  (same lease, same content) with the original seqs, even after the lease lapsed. */
  async append(sid: string, opts: { leaseId: string; afterSeq: number; events: StoreEvent[] }): Promise<{ firstSeq: number; lastSeq: number }> {
    const t0 = this.now();
    const body = { lease_id: opts.leaseId, after_seq: opts.afterSeq, events: opts.events };
    const b = await this.call<{ first_seq: number; last_seq: number }>("append", sid, "POST", "/events", body, 1 + APPEND_RETRIES);
    this.log.debug("store.append", { sid, events: opts.events.length, firstSeq: b.first_seq, lastSeq: b.last_seq, ms: this.now() - t0 });
    return { firstSeq: b.first_seq, lastSeq: b.last_seq };
  }

  /** `after` past the store's last seq is `400 invalid_cursor`. */
  async read(sid: string, opts: { after: number; limit?: number }): Promise<{ events: StoredEvent[]; lastSeq: number }> {
    const limit = opts.limit ?? MAX_READ_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) throw new RangeError(`read limit must be 1..${MAX_READ_LIMIT}, got ${limit}`);
    const b = await this.call<{ events: StoredEvent[]; last_seq: number }>("read", sid, "GET", `/events?after=${opts.after}&limit=${limit}`);
    return { events: b.events, lastSeq: b.last_seq };
  }

  /** The whole log, page after page. Each cursor is a seq the store returned, so it never passes the head. */
  async readAll(sid: string): Promise<{ events: StoredEvent[]; lastSeq: number }> {
    const events: StoredEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await this.read(sid, { after });
      events.push(...page.events);
      const last = page.events.at(-1)?.seq;
      if (last === undefined || last >= page.lastSeq) return { events, lastSeq: page.lastSeq };
      after = last;
    }
  }

  async projection(sid: string): Promise<SessionProjection> {
    const b = await this.call<{
      sid: string;
      owner: string;
      unit: string;
      publication: string;
      hop: SessionProjection["hop"];
      status: SessionProjection["status"];
      parks: SessionPark[];
      park?: SessionPark;
      stop_reason?: string;
      usage: { input_tokens: number; output_tokens: number; cost_cu: number };
      lease: { holder?: string; expires_at: number } | null;
      last_seq: number;
      updated_at: number;
    }>("projection", sid, "GET", "");
    return {
      sid: b.sid,
      owner: b.owner,
      unit: b.unit,
      publication: b.publication,
      hop: b.hop,
      status: b.status,
      parks: b.parks,
      ...(b.park ? { park: b.park } : {}),
      ...(b.stop_reason !== undefined ? { stopReason: b.stop_reason } : {}),
      usage: { inputTokens: b.usage.input_tokens, outputTokens: b.usage.output_tokens, costCu: b.usage.cost_cu },
      lease: b.lease ? { ...(b.lease.holder !== undefined ? { holder: b.lease.holder } : {}), expiresAt: b.lease.expires_at } : null,
      lastSeq: b.last_seq,
      updatedAt: b.updated_at,
    };
  }

  private async call<T>(op: Op, sid: string, method: string, path: string, body?: unknown, attempts = 1): Promise<T> {
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(sid)}${path}`;
    let lastFailure = "";
    let retryAfterMs = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await this.sleep(Math.max(RETRY_BASE_MS * 2 ** (attempt - 2), retryAfterMs));
      const token = this.tokenProvider();
      // Built from parts we choose; anything foreign that reaches a message is scrubbed of the token.
      const scrub = (s: string) => (token ? s.split(token).join("[redacted]") : s);
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        text = await res.text();
      } catch (e) {
        lastFailure = scrub(String((e as Error)?.message ?? e));
        retryAfterMs = 0;
        if (attempt < attempts) this.log.warn("session store unreachable; retrying", { op, sid, attempt, error: lastFailure });
        continue;
      }
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (res.ok) return parsed as T;
      const err = httpError(op, sid, res.status, (parsed ?? {}) as Record<string, unknown>);
      if (res.status < 500 || attempt === attempts) throw err;
      retryAfterMs = Number(res.headers.get("retry-after") ?? 0) * 1000 || 0;
      this.log.warn("session store answered 5xx; retrying", { op, sid, attempt, status: res.status, code: err.code });
    }
    throw new StoreUnreachableError(`session store ${op} (${sid}): unreachable after ${attempts} attempt(s): ${lastFailure}`, attempts);
  }
}

interface WireLease {
  lease_id: string;
  expires_at: number;
  last_seq: number;
}

export interface LeaseGrant {
  leaseId: string;
  expiresAt: number;
  lastSeq: number;
}

function grant(b: WireLease): LeaseGrant {
  return { leaseId: b.lease_id, expiresAt: b.expires_at, lastSeq: b.last_seq };
}
