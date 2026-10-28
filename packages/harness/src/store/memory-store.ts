/**
 * The engine's client for the P5 memory store (contracts/P5-memory-store.md 1.3): the routes the engine's memory rung
 * uses under the grant's base (`{MEMORY_URL}/api/v1`) — checkpoint (writes stage under the run), search and
 * projection (the run's staging overlaid on the promoted store, shared stores as granted), and promotion at the
 * turn's end. The bearer is the engine's memory token, read per request; a 401 re-reads it once. Every non-2xx is an
 * error class by `detail.code` (FastAPI's envelope); no call retries anything else (the rung degrades instead).
 */
import type { Logger } from "../obs/logger";
import { silentLogger } from "../obs/logger";
import type { MemoryProjection } from "../memory/projection";
import { PROJECTION_BUDGET_MAX, PROJECTION_BUDGET_MIN } from "../memory/projection";
import type { StoreFetch } from "./remote/client";

// ── the grant (RunContext `memory`, P5 §a) ───────────────────────────────────────────────────

export interface MemoryGrant {
  /** The store's full base, mount included (`{MEMORY_URL}/api/v1`): routes are appended to it as they are. */
  url: string;
  /** The root unit id. */
  org: string;
  /** `hop:<publication>/<customer>`: the store this run reads and promotes into. */
  store: string;
  /** Other stores this run may read (or, `read_write`, also write). */
  shared: Array<{ scopeId: string; access: "read" | "read_write" }>;
  promotion: "auto" | "review";
  limits: { maxNodes: number; maxBytes: number; maxWriteBytes: number };
}

/** A grant the engine cannot act on; `field` names the first bad one. */
export class MemoryGrantError extends Error {
  override name = "MemoryGrantError";
  constructor(readonly field: string) {
    super(`memory grant: invalid ${field}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The RunContext's `memory` as the wire carries it: `null` (no memory policy) or a MemoryGrant. Unknown fields
 *  are ignored, as RunContext's are; a field the engine needs and cannot use throws MemoryGrantError. */
export function parseMemoryGrant(raw: unknown): MemoryGrant | null {
  if (raw === null) return null;
  if (!isObj(raw)) throw new MemoryGrantError("memory");
  const { url, org, store, promotion } = raw;
  if (!nonEmpty(url) || !/^https?:\/\//.test(url)) throw new MemoryGrantError("url");
  if (!nonEmpty(org)) throw new MemoryGrantError("org");
  if (!nonEmpty(store)) throw new MemoryGrantError("store");
  if (promotion !== "auto" && promotion !== "review") throw new MemoryGrantError("promotion");
  const sharedRaw = raw.shared ?? [];
  if (!Array.isArray(sharedRaw)) throw new MemoryGrantError("shared");
  const shared = sharedRaw.map((s, i): MemoryGrant["shared"][number] => {
    if (!isObj(s) || !nonEmpty(s.scope_id)) throw new MemoryGrantError(`shared[${i}].scope_id`);
    if (s.access !== "read" && s.access !== "read_write") throw new MemoryGrantError(`shared[${i}].access`);
    return { scopeId: s.scope_id, access: s.access };
  });
  const limits = raw.limits;
  if (!isObj(limits)) throw new MemoryGrantError("limits");
  for (const k of ["max_nodes", "max_bytes", "max_write_bytes"] as const) if (!count(limits[k])) throw new MemoryGrantError(`limits.${k}`);
  return {
    url: url.replace(/\/+$/, ""),
    org,
    store,
    shared,
    promotion,
    limits: { maxNodes: limits.max_nodes as number, maxBytes: limits.max_bytes as number, maxWriteBytes: limits.max_write_bytes as number },
  };
}

// ── errors (P5 "Errors": `{"detail": {"code", "message", …fields}}`) ─────────────────────────────

export class MemoryStoreError extends Error {
  override name = "MemoryStoreError";
  constructor(
    message: string,
    /** 0 when the store never answered. */
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}
/** 401 `unauthenticated`, after the one re-read of the token. */
export class MemoryUnauthenticatedError extends MemoryStoreError {
  override name = "MemoryUnauthenticatedError";
}
/** 403 `scope_forbidden`: a store or run outside the token's grant. */
export class MemoryScopeForbiddenError extends MemoryStoreError {
  override name = "MemoryScopeForbiddenError";
}
/** 404 `unknown_store` | `unknown_run`. */
export class MemoryUnknownError extends MemoryStoreError {
  override name = "MemoryUnknownError";
}
/** 409 `version_conflict`: a claim's `expected_version` is not the key's; nothing of the checkpoint was written. */
export class MemoryVersionConflictError extends MemoryStoreError {
  override name = "MemoryVersionConflictError";
  constructor(
    message: string,
    status: number,
    code: string,
    readonly key: string,
    readonly currentVersion: number,
  ) {
    super(message, status, code);
  }
}
/** 413 `write_too_large {size, limit}`: one checkpoint's body over the grant's `max_write_bytes`. */
export class MemoryWriteTooLargeError extends MemoryStoreError {
  override name = "MemoryWriteTooLargeError";
  constructor(
    message: string,
    status: number,
    code: string,
    readonly size: number | undefined,
    readonly limit: number | undefined,
  ) {
    super(message, status, code);
  }
}
/** 413 `store_full {nodes|bytes, limit}`: the promotion would pass `max_nodes` or `max_bytes`; nothing was promoted. */
export class MemoryStoreFullError extends MemoryStoreError {
  override name = "MemoryStoreFullError";
  constructor(
    message: string,
    status: number,
    code: string,
    /** Which limit: the body names `nodes` or `bytes`. */
    readonly measure: "nodes" | "bytes" | undefined,
    readonly limit: number | undefined,
  ) {
    super(message, status, code);
  }
}
/** 422 `invalid_precondition {key}`: `expected_version` on a claim with no anchor (a learning). */
export class MemoryInvalidPreconditionError extends MemoryStoreError {
  override name = "MemoryInvalidPreconditionError";
  constructor(
    message: string,
    status: number,
    code: string,
    readonly key: string,
  ) {
    super(message, status, code);
  }
}
/** 503 `store_unavailable`, any other 5xx, a timeout or no answer (`unreachable`). */
export class MemoryUnavailableError extends MemoryStoreError {
  override name = "MemoryUnavailableError";
}

const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** A P5 refusal's `detail` object; a legacy string detail, pydantic's list or no body has none, and keeps its status as
 *  the code (`http_<status>`) and no fields. */
function errorFor(op: string, status: number, body: unknown): MemoryStoreError {
  const detail = isObj(body) && isObj(body.detail) && typeof body.detail.code === "string" ? body.detail : null;
  const code = detail ? (detail.code as string) : `http_${status}`;
  const message = `memory store ${op}: ${status} ${code}${detail && typeof detail.message === "string" ? ` (${detail.message})` : ""}`;
  if (status === 401) return new MemoryUnauthenticatedError(message, status, code);
  if (status === 403) return new MemoryScopeForbiddenError(message, status, code);
  if (status === 404) return new MemoryUnknownError(message, status, code);
  if (status >= 500) return new MemoryUnavailableError(message, status, code);
  if (!detail) return new MemoryStoreError(message, status, code);
  if (status === 409 && code === "version_conflict") return new MemoryVersionConflictError(message, status, code, String(detail.key ?? ""), num(detail.current_version) ?? 0);
  if (status === 413 && code === "store_full") return new MemoryStoreFullError(message, status, code, "nodes" in detail ? "nodes" : "bytes" in detail ? "bytes" : undefined, num(detail.limit));
  if (status === 413 && code === "write_too_large") return new MemoryWriteTooLargeError(message, status, code, num(detail.size), num(detail.limit));
  if (status === 422 && code === "invalid_precondition") return new MemoryInvalidPreconditionError(message, status, code, String(detail.key ?? ""));
  return new MemoryStoreError(message, status, code);
}

// ── requests and answers ──────────────────────────────────────────────────────────────────────

/** Who is calling, on every request: the store stamps writes from the token's claims; these headers are what
 *  the store's request log and a trace join on. */
export interface MemoryAttribution {
  sid: string;
  runId: string;
  /** `name@version`. */
  hop?: string;
  origin?: string;
}

/** memory-graph's CheckpointRequest; a claim may add `expected_version` (P5 §e). Sent as given. */
export interface MemoryCheckpointBody {
  event_id: string;
  workspace: string;
  claims?: Array<Record<string, unknown>>;
  note?: Record<string, string>;
  window?: { title?: string; content: string; uri?: string };
}

export interface MemoryCheckpointAnswer {
  event_id: string;
  claims: { accepted: number; duplicates: number; processed: number; rejected: Array<{ index: number; topic: string; key: string; reason: string }> };
  note_version?: number | null;
  note_applied?: boolean;
  window?: { event_id: string; status: string } | null;
}

export interface MemorySearchQuery {
  q: string;
  type?: string;
  limit?: number;
  asOf?: string;
}

export interface MemorySearchNode {
  id: string;
  type?: string;
  key?: string;
  summary?: string;
  scope_id?: string;
  [k: string]: unknown;
}

/** The store's search body, kept whole (it is the tool's answer to the model). */
export interface MemorySearchAnswer {
  nodes: MemorySearchNode[];
  [k: string]: unknown;
}

export interface MemoryProjectionQuery {
  workspace: string;
  hop: string;
  inject: string[];
  tokenBudget: number;
}

/** A staged key the store moved since it was staged (§e): left staged, never written over the newer value. */
export interface MemoryPromotionConflict {
  key: string;
  topic: string;
  seen_version: number;
  current_version: number;
  staged_event_id: string;
}

/** P5 §d, 200 in every state. `promoted` counts claims. */
export type MemoryPromotion =
  | { state: "promoted"; storeVersion: number; promoted: number; conflicts: MemoryPromotionConflict[] }
  | { state: "pending"; proposalId: string }
  | { state: "rejected"; proposalId: string | null }
  | { state: "empty"; storeVersion: number | null };

export interface MemoryStoreClientOptions {
  /** The grant's `url`, `…/v1`. */
  baseUrl: string;
  /** The engine's memory token, read per request (the token file is rewritten on refresh). */
  tokenProvider: () => string;
  fetch?: StoreFetch;
  /** Per-request bound (default 10 s). */
  timeoutMs?: number;
  logger?: Logger;
}

export class MemoryStoreClient {
  private readonly baseUrl: string;
  private readonly tokenProvider: () => string;
  private readonly fetchImpl: StoreFetch;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(opts: MemoryStoreClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokenProvider = opts.tokenProvider;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.log = opts.logger ?? silentLogger;
  }

  async checkpoint(body: MemoryCheckpointBody, att: MemoryAttribution): Promise<MemoryCheckpointAnswer> {
    const r = await this.request("checkpoint", "POST", "/memory/checkpoint", att, body);
    if (typeof r.event_id !== "string" || !isObj(r.claims)) throw invalid("checkpoint");
    return r as unknown as MemoryCheckpointAnswer;
  }

  async search(q: MemorySearchQuery, att: MemoryAttribution): Promise<MemorySearchAnswer> {
    const p = new URLSearchParams({ q: q.q });
    if (q.type) p.set("type", q.type);
    if (q.limit !== undefined) p.set("limit", String(q.limit));
    if (q.asOf) p.set("as_of", q.asOf);
    const r = await this.request("search", "GET", `/memory/search?${p}`, att);
    if (!Array.isArray(r.nodes)) throw invalid("search");
    return r as MemorySearchAnswer;
  }

  async projection(q: MemoryProjectionQuery, att: MemoryAttribution): Promise<MemoryProjection> {
    const budget = Math.min(PROJECTION_BUDGET_MAX, Math.max(PROJECTION_BUDGET_MIN, Math.trunc(q.tokenBudget)));
    const p = new URLSearchParams({ workspace: q.workspace, hop: q.hop, token_budget: String(budget) });
    if (q.inject.length > 0) p.set("inject", q.inject.join(","));
    const r = await this.request("projection", "GET", `/memory/projection?${p}`, att);
    if (typeof r.markdown !== "string" || typeof r.fact_count !== "number") throw invalid("projection");
    return { markdown: r.markdown, estimatedTokens: typeof r.estimated_tokens === "number" ? r.estimated_tokens : 0, factCount: r.fact_count, truncated: r.truncated === true };
  }

  /** P5 §d. Idempotent per run at the store: a repeat answers the first body. The store's name keeps its slash in
   *  the path (`/memory/stores/hop:5/acme/runs/…`: the route takes a path converter). */
  async promote(store: string, runId: string, att: MemoryAttribution): Promise<MemoryPromotion> {
    const storePath = store.split("/").map((s) => encodeURIComponent(s).replaceAll("%3A", ":")).join("/");
    const r = await this.request("promote", "POST", `/memory/stores/${storePath}/runs/${encodeURIComponent(runId)}/promote`, att, {});
    if (r.state === "empty") return { state: "empty", storeVersion: num(r.store_version) ?? null };
    if (r.state === "promoted" && typeof r.store_version === "number" && typeof r.promoted === "number" && Array.isArray(r.conflicts))
      return { state: "promoted", storeVersion: r.store_version, promoted: r.promoted, conflicts: r.conflicts as MemoryPromotionConflict[] };
    if (r.state === "pending" && typeof r.proposal_id === "string") return { state: "pending", proposalId: r.proposal_id };
    if (r.state === "rejected") return { state: "rejected", proposalId: typeof r.proposal_id === "string" ? r.proposal_id : null };
    throw invalid("promote");
  }

  private async request(op: string, method: "GET" | "POST", path: string, att: MemoryAttribution, body?: unknown): Promise<Record<string, unknown>> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let res = await this.send(op, method, path, att, payload);
    // The token file may have been rewritten since this request read it (a refresh): read it once more.
    if (res.status === 401) {
      this.log.info("memory.store.reauth", { op, sid: att.sid, run_id: att.runId });
      res = await this.send(op, method, path, att, payload);
    }
    const parsed: unknown = await res.json().catch(() => null);
    if (!res.ok) throw errorFor(op, res.status, parsed);
    if (!isObj(parsed)) throw invalid(op);
    return parsed;
  }

  private async send(op: string, method: "GET" | "POST", path: string, att: MemoryAttribution, payload: string | undefined): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.tokenProvider()}`,
      "x-session-id": att.sid,
      "x-run-id": att.runId,
      ...(att.hop ? { "x-hop": att.hop } : {}),
      ...(att.origin ? { "x-origin": att.origin } : {}),
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    };
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new MemoryUnavailableError(`memory store ${op}: unreachable (${String((e as Error)?.message ?? e)})`, 0, "unreachable");
    }
  }
}

const invalid = (op: string) => new MemoryStoreError(`memory store ${op}: an answer outside the contract`, 200, "invalid_response");
