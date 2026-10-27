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

/** An event with its `data` already serialized: serialized once, at append time, so a retry resends the
 *  same bytes and a later change to the caller's object cannot reach the store. */
export interface EncodedEvent {
  kind: string;
  ts_ms: number;
  /** `data` as JSON. */
  json: string;
  /** The UTF-8 size of `json`: what the store counts against its limits. */
  bytes: number;
}

/** Serializes one event; throws when `data` cannot be serialized (a cycle, a BigInt). */
export function encodeEvent(kind: string, data: unknown, tsMs: number): EncodedEvent {
  const json = JSON.stringify(data ?? null);
  return { kind, ts_ms: tsMs, json, bytes: Buffer.byteLength(json) };
}

/** An event off the SSE stream, which carries no `ts_ms`. */
export interface StreamedEvent {
  seq: number;
  kind: string;
  data: unknown;
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
  /** The refusal code the last turn's terminal result or error carried (then also its `stopReason`). */
  stopReason?: string;
  refusal: { code: string } | null;
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
  /** Per-attempt timeout (default 20 s: the store's 5 s row-lock wait plus its 10 s object-store bound,
   *  with headroom); a timed-out append counts as a network failure. */
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

/** 413: `batch_too_large` (over the per-batch limits) or `event_too_large` (one event over the
 *  store's `max_event_bytes`). */
export class BatchTooLargeError extends StoreHttpError {
  override name = "BatchTooLargeError";
  constructor(
    message: string,
    status: number,
    code: string,
    readonly maxEvents?: number,
    readonly maxBytes?: number,
    readonly maxEventBytes?: number,
  ) {
    super(message, status, code);
  }
}

/** 503 `stream_capacity` (this replica is full) or 429 `too_many_streams` (this principal's cap):
 *  reconnect after `retryAfterS`. */
export class StreamBusyError extends StoreHttpError {
  override name = "StreamBusyError";
  constructor(
    message: string,
    status: number,
    code: string,
    readonly retryAfterS?: number,
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
const MAX_ATTEMPTS = 3;
const RETRY_BUDGET_MS = 30_000;
const RETRY_BASE_MS = 200;

type Op = "lease" | "renew" | "release" | "append" | "read" | "projection" | "stream";

/** What a call retries, within one budget (MAX_ATTEMPTS attempts or RETRY_BUDGET_MS, whichever ends
 *  first): an append retries any network failure or 5xx (the store answers a replay with its original
 *  seqs); every other call only a busy store (`store_busy`: the read pool; `session_busy`: the row lock). */
type Retry = "append" | "busy";

const isBusy = (status: number, code: string) => status === 503 && (code === "store_busy" || code === "session_busy");
const retryAfterMs = (res: Response) => Number(res.headers.get("retry-after") ?? 0) * 1000 || 0;

const num = (v: unknown) => (typeof v === "number" ? v : undefined);

function httpError(op: Op, sid: string, status: number, body: Record<string, unknown>): StoreHttpError {
  const code = typeof body.code === "string" ? body.code : `http_${status}`;
  const message = `session store ${op} (${sid}): ${status} ${code}`;
  if (status === 404) return new SessionNotFoundError(message, status, code);
  if (status === 410) return new SessionDeletedError(message, status, code, num(body.deleted_at));
  if (status === 413) return new BatchTooLargeError(message, status, code, num(body.max_events), num(body.max_bytes), num(body.max_event_bytes));
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
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.log = opts.logger ?? silentLogger;
  }

  /** Control-role only: an engine never takes its own lease; it is handed one (`LeaseKeeper.adopt`). */
  async lease(sid: string, opts: { holder: string; ttlS: number }): Promise<LeaseGrant> {
    return grant(await this.call<WireLease>("lease", sid, "POST", "/lease", JSON.stringify({ holder: opts.holder, ttl_s: opts.ttlS })));
  }

  /** Extends the live lease by its ttl (or `ttlS`); a lapsed lease is never revived (`LeaseLostError`).
   *  `timeoutMs` bounds each attempt below the client's default (the lease keeper's time to its deadline). */
  async renew(sid: string, leaseId: string, ttlS?: number, opts: { timeoutMs?: number } = {}): Promise<LeaseGrant> {
    const body = ttlS === undefined ? undefined : JSON.stringify({ ttl_s: ttlS });
    return grant(await this.call<WireLease>("renew", sid, "POST", `/lease/${encodeURIComponent(leaseId)}/renew`, body, "busy", opts.timeoutMs));
  }

  async release(sid: string, leaseId: string): Promise<void> {
    await this.call("release", sid, "DELETE", `/lease/${encodeURIComponent(leaseId)}`);
  }

  /** Retried on a network failure or a 5xx with the same `after_seq`: the store answers a replay
   *  (same lease, same content) with the original seqs, even after the lease lapsed. */
  async append(sid: string, opts: { leaseId: string; afterSeq: number; events: StoreEvent[] }): Promise<{ firstSeq: number; lastSeq: number }> {
    return this.appendEncoded(sid, { ...opts, events: opts.events.map((e) => encodeEvent(e.kind, e.data, e.ts_ms)) });
  }

  /** `append` for events serialized at append time: the body is assembled once, before any attempt. */
  async appendEncoded(sid: string, opts: { leaseId: string; afterSeq: number; events: EncodedEvent[] }): Promise<{ firstSeq: number; lastSeq: number }> {
    const t0 = this.now();
    const events = opts.events.map((e) => `{"kind":${JSON.stringify(e.kind)},"data":${e.json},"ts_ms":${e.ts_ms}}`);
    const body = `{"lease_id":${JSON.stringify(opts.leaseId)},"after_seq":${opts.afterSeq},"events":[${events.join(",")}]}`;
    const b = await this.call<{ first_seq: number; last_seq: number }>("append", sid, "POST", "/events", body, "append");
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

  /** The whole log, page after page until a page ends at the head: a page is cut at 500 events or
   *  4 MiB, so a short page is not the end. Each cursor is a seq the store returned, never past the head. */
  async readAll(sid: string): Promise<{ events: StoredEvent[]; lastSeq: number }> {
    const events: StoredEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await this.read(sid, { after });
      events.push(...page.events);
      const last = page.events.at(-1)?.seq ?? after;
      if (last >= page.lastSeq) return { events, lastSeq: page.lastSeq };
      if (page.events.length === 0) throw new Error(`session store read (${sid}): an empty page after ${after}, before last_seq ${page.lastSeq}`);
      after = last;
    }
  }

  /** The session's events from `after` as they land. The store ends a stream at token expiry, at
   *  shutdown and at erasure; that end, and the caller's abort, finish the iteration normally, so the
   *  caller reconnects after the last seq it saw (with a fresh token: the provider is read per
   *  connection). Refusals throw, a full replica or a principal's cap as a StreamBusyError. */
  async *stream(sid: string, opts: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<StreamedEvent> {
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(sid)}/stream?after=${opts.after ?? 0}`;
    const token = this.tokenProvider();
    const unreachable = (e: unknown) => new StoreUnreachableError(`session store stream (${sid}): ${redact(String((e as Error)?.message ?? e), token)}`, 1);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: opts.signal });
    } catch (e) {
      if (opts.signal?.aborted) return;
      throw unreachable(e);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = httpError("stream", sid, res.status, body as Record<string, unknown>);
      if ((res.status === 503 && err.code === "stream_capacity") || (res.status === 429 && err.code === "too_many_streams")) {
        throw new StreamBusyError(err.message, err.status, err.code, retryAfterMs(res) / 1000 || undefined);
      }
      throw err;
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // A CR that ends a chunk waits for the next one: CR LF across two chunks is one line break.
    let pendingCr = false;
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (e) {
          if (opts.signal?.aborted) return;
          throw unreachable(e);
        }
        if (chunk.done) return;
        let text = decoder.decode(chunk.value, { stream: true });
        if (pendingCr) text = `\r${text}`;
        pendingCr = text.endsWith("\r");
        buf += (pendingCr ? text.slice(0, -1) : text).replace(/\r\n?/g, "\n");
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const event = sseEvent(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
          if (event) yield event;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
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
      refusal: { code: string } | null;
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
      refusal: b.refusal,
      usage: { inputTokens: b.usage.input_tokens, outputTokens: b.usage.output_tokens, costCu: b.usage.cost_cu },
      lease: b.lease ? { ...(b.lease.holder !== undefined ? { holder: b.lease.holder } : {}), expiresAt: b.lease.expires_at } : null,
      lastSeq: b.last_seq,
      updatedAt: b.updated_at,
    };
  }

  private async call<T>(op: Op, sid: string, method: string, path: string, body?: string, retry: Retry = "busy", timeoutMs = this.timeoutMs): Promise<T> {
    const url = `${this.baseUrl}/sessions/${encodeURIComponent(sid)}${path}`;
    const budgetEnd = this.now() + RETRY_BUDGET_MS;
    let failure: StoreHttpError | StoreUnreachableError | undefined;
    let waitMs = 0;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const wait = Math.max(RETRY_BASE_MS * 2 ** (attempt - 2), waitMs);
        if (this.now() + wait >= budgetEnd) break;
        this.log.warn("session store call failed; retrying", { op, sid, attempt, error: failure!.message });
        await this.sleep(wait);
      }
      const token = this.tokenProvider();
      let res: Response;
      let text: string;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, budgetEnd - this.now()))),
        });
        text = await res.text();
      } catch (e) {
        failure = new StoreUnreachableError(`session store ${op} (${sid}): unreachable: ${redact(String((e as Error)?.message ?? e), token)}`, attempt);
        if (retry !== "append") break;
        waitMs = 0;
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
      const retryable = retry === "append" ? res.status >= 500 : isBusy(res.status, err.code);
      if (!retryable) throw err;
      failure = err;
      waitMs = retryAfterMs(res);
    }
    throw failure!;
  }
}

/** Never lets the bearer reach a message; an empty token has nothing to hide. */
function redact(s: string, token: string): string {
  return token ? s.split(token).join("[redacted]") : s;
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

/** One SSE event block: `id` is the seq, `event` the kind, the `data:` lines the frame; a comment
 *  (the keep-alive) has none of them and yields nothing. */
function sseEvent(block: string): StreamedEvent | null {
  let id: string | undefined;
  let kind = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") kind = value;
    else if (field === "data") data.push(value);
  }
  if (id === undefined || data.length === 0) return null;
  return { seq: Number(id), kind, data: JSON.parse(data.join("\n")) };
}
