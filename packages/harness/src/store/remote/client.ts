/**
 * The engine's client for the P1 session store (plans/2026-10-27-harness-platform-part-2.md §P1):
 * leases, single-writer appends keyed by `after_seq`, paged reads and the projection. Pure
 * TypeScript over an injected fetch, so it runs in the engine, a test, or any host.
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

export interface Projection {
  sid: string;
  owner: string | null;
  unit: string | null;
  publication: string | null;
  hop: { name: string; version: string; digest: string } | null;
  status: "idle" | "running" | "requires_action" | "ended";
  park?: { kind: "permission" | "question" | "approval" | "parked_question"; id: string; at: string };
  stopReason?: string;
  usage: { inputTokens: number; outputTokens: number; costCu: number };
  lastSeq: number;
  updatedAt: string;
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SessionStoreClientOptions {
  /** The store's base url, `…/v1`. */
  baseUrl: string;
  /** The bearer for each request, read per request so a rotated grant or token file takes effect. */
  tokenProvider: () => string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Per-request timeout (default 5000 ms); a timed-out append counts as a network failure. */
  timeoutMs?: number;
  logger?: Logger;
}

/** The store answered with a status that is not 2xx. `reason` is P1's `code`. */
export class StoreHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = "StoreHttpError";
  }
}

/** 409 `session_leased`: another holder's lease is live. */
export class LeaseHeldError extends StoreHttpError {
  override name = "LeaseHeldError";
}

/** 409 `lease_lost`: the lease this engine wrote under is gone. */
export class LeaseLostError extends StoreHttpError {
  override name = "LeaseLostError";
}

/** 409 `seq_conflict`: `after_seq` is not the store's last seq; another writer owns the session. */
export class SeqConflictError extends StoreHttpError {
  override name = "SeqConflictError";
  constructor(
    message: string,
    status: number,
    reason: string,
    readonly lastSeq?: number,
  ) {
    super(message, status, reason);
  }
}

/** 404: no such session (control creates sessions; the engine never does). */
export class SessionNotFoundError extends StoreHttpError {
  override name = "SessionNotFoundError";
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

function httpError(op: Op, sid: string, status: number, body: Record<string, unknown>): StoreHttpError {
  const reason = typeof body.code === "string" ? body.code : `http_${status}`;
  const message = `session store ${op} (${sid}): ${status} ${reason}`;
  if (status === 404) return new SessionNotFoundError(message, status, reason);
  if (status === 409 && reason === "session_leased") return new LeaseHeldError(message, status, reason);
  if (status === 409 && reason === "lease_lost") return new LeaseLostError(message, status, reason);
  if (status === 409 && reason === "seq_conflict") {
    return new SeqConflictError(message, status, reason, typeof body.last_seq === "number" ? body.last_seq : undefined);
  }
  return new StoreHttpError(message, status, reason);
}

export class SessionStoreClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: () => string;
  private readonly fetchImpl: Fetch;
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

  async lease(sid: string, opts: { holder: string; ttlS: number }): Promise<{ leaseId: string; expiresAt: string; lastSeq: number }> {
    const b = await this.call<{ lease_id: string; expires_at: string; last_seq: number }>("lease", sid, "POST", "/lease", { holder: opts.holder, ttl_s: opts.ttlS });
    return { leaseId: b.lease_id, expiresAt: b.expires_at, lastSeq: b.last_seq };
  }

  async renew(sid: string, leaseId: string): Promise<{ expiresAt: string }> {
    const b = await this.call<{ expires_at: string }>("renew", sid, "POST", `/lease/${encodeURIComponent(leaseId)}/renew`);
    return { expiresAt: b.expires_at };
  }

  async release(sid: string, leaseId: string): Promise<void> {
    await this.call("release", sid, "DELETE", `/lease/${encodeURIComponent(leaseId)}`);
  }

  /** Retried on a network failure with the same `after_seq`: P1 answers a replay with the original seqs. */
  async append(sid: string, opts: { leaseId: string; afterSeq: number; events: StoreEvent[] }): Promise<{ firstSeq: number; lastSeq: number }> {
    const t0 = this.now();
    const body = { lease_id: opts.leaseId, after_seq: opts.afterSeq, events: opts.events };
    const b = await this.call<{ first_seq: number; last_seq: number }>("append", sid, "POST", "/events", body, 1 + APPEND_RETRIES);
    this.log.debug("store.append", { sid, events: opts.events.length, firstSeq: b.first_seq, lastSeq: b.last_seq, ms: this.now() - t0 });
    return { firstSeq: b.first_seq, lastSeq: b.last_seq };
  }

  async read(sid: string, opts: { after: number; limit?: number }): Promise<{ events: StoredEvent[]; lastSeq: number }> {
    const limit = opts.limit ?? MAX_READ_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_READ_LIMIT) throw new RangeError(`read limit must be 1..${MAX_READ_LIMIT}, got ${limit}`);
    const b = await this.call<{ events: StoredEvent[]; last_seq: number }>("read", sid, "GET", `/events?after=${opts.after}&limit=${limit}`);
    return { events: b.events, lastSeq: b.last_seq };
  }

  /** The whole log, paged at the read limit until the last page reaches the store's last seq. */
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

  async projection(sid: string): Promise<Projection> {
    const b = await this.call<{
      sid: string;
      owner: string | null;
      unit: string | null;
      publication: string | null;
      hop: Projection["hop"];
      status: Projection["status"];
      park?: Projection["park"];
      stop_reason?: string;
      usage: { input_tokens: number; output_tokens: number; cost_cu: number };
      last_seq: number;
      updated_at: string;
    }>("projection", sid, "GET", "");
    return {
      sid: b.sid,
      owner: b.owner,
      unit: b.unit,
      publication: b.publication,
      hop: b.hop,
      status: b.status,
      ...(b.park ? { park: b.park } : {}),
      ...(b.stop_reason ? { stopReason: b.stop_reason } : {}),
      usage: { inputTokens: b.usage.input_tokens, outputTokens: b.usage.output_tokens, costCu: b.usage.cost_cu },
      lastSeq: b.last_seq,
      updatedAt: b.updated_at,
    };
  }

  private async call<T>(op: Op, sid: string, method: string, path: string, body?: unknown, attempts = 1): Promise<T> {
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(sid)}${path}`;
    let lastFailure = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await this.sleep(RETRY_BASE_MS * 2 ** (attempt - 2));
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
        if (attempt < attempts) this.log.warn("session store unreachable; retrying", { op, sid, attempt, error: lastFailure });
        continue;
      }
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!res.ok) throw httpError(op, sid, res.status, (parsed ?? {}) as Record<string, unknown>);
      return parsed as T;
    }
    throw new StoreUnreachableError(`session store ${op} (${sid}): unreachable after ${attempts} attempt(s): ${lastFailure}`, attempts);
  }
}
