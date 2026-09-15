/**
 * Session-start memory projection (memory v6, E2): the memory service renders the working memory
 * a run should start with — the caller's preferences, the HOP's inject topics' current state, then
 * learnings by scope until a token budget — as ONE markdown block, ordered and trimmed
 * server-side. The host renders it where the local newest-first topic injection used to go
 * (same prompt-cache breakpoint) when the graph backend is on, and falls back to the local topics
 * when the service is unreachable. Fetching is bounded and NEVER throws: a failure is a value the
 * host can log and fall back on, distinguishable from an empty projection.
 */

export interface ProjectionRequest {
  /** Service base URL (`http://host:port`, no trailing slash needed). */
  endpoint: string;
  /** The session's workspace facet (the HOP's memory.workspace or the host's default). */
  workspace: string;
  /** The HOP name (not `name@version`): the service keys per-HOP preferences by it. */
  hop: string;
  /** Topic ids of the HOP's memory.topics entries with `inject: true`. */
  inject: string[];
  /** 200..50000 per the service; the host's session-start default is 1500. */
  tokenBudget: number;
  /** Auth: the bearer token in prod; locally the dev headers (+ the HOP tenant). */
  headers: Record<string, string>;
  timeoutMs?: number;
  /** Injectable for tests; defaults to fetch. */
  fetchImpl?: typeof fetch;
}

export interface MemoryProjection {
  markdown: string;
  estimatedTokens: number;
  factCount: number;
  truncated: boolean;
}

export type ProjectionOutcome = { ok: true; projection: MemoryProjection } | { ok: false; error: string };

export const PROJECTION_BUDGET_MIN = 200;
export const PROJECTION_BUDGET_MAX = 50_000;
export const PROJECTION_SESSION_START_BUDGET = 1500;

export function projectionUrl(req: Pick<ProjectionRequest, "endpoint" | "workspace" | "hop" | "inject" | "tokenBudget">): string {
  const budget = Math.min(PROJECTION_BUDGET_MAX, Math.max(PROJECTION_BUDGET_MIN, Math.trunc(req.tokenBudget)));
  const q = new URLSearchParams({ workspace: req.workspace, hop: req.hop, token_budget: String(budget) });
  // The service treats an absent and an empty `inject` the same; omit it when there is nothing.
  if (req.inject.length > 0) q.set("inject", req.inject.join(","));
  return `${req.endpoint.replace(/\/$/, "")}/api/v1/memory/projection?${q.toString()}`;
}

export async function fetchMemoryProjection(req: ProjectionRequest): Promise<ProjectionOutcome> {
  const url = projectionUrl(req);
  const doFetch = req.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, { headers: req.headers, signal: AbortSignal.timeout(req.timeoutMs ?? 3000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as Partial<Record<"markdown" | "estimated_tokens" | "fact_count" | "truncated", unknown>>;
    if (typeof body.markdown !== "string" || typeof body.fact_count !== "number") {
      return { ok: false, error: "unexpected response shape (no markdown/fact_count)" };
    }
    return {
      ok: true,
      projection: {
        markdown: body.markdown,
        estimatedTokens: typeof body.estimated_tokens === "number" ? body.estimated_tokens : 0,
        factCount: body.fact_count,
        truncated: body.truncated === true,
      },
    };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** The system-prompt section for a projection. Empty when the service had nothing to say, so a
 *  run with no memory carries no memory section (same as the local injection). The service's own
 *  top heading is dropped: the section supplies the framing the local injection has. */
export function projectionSection(p: MemoryProjection): string {
  const body = p.markdown.replace(/^\s*#\s+Memory\s*\n/, "").trim();
  if (p.factCount === 0 || body === "") return "";
  return (
    "\n\n# Derived memories\nWhat the memory service knows for this workspace and HOP: your preferences, the current state of the topics this HOP follows, then learnings by scope (each suffixed with its trust tier when scored). Point-in-time — verify against current code before relying on file/line specifics. Update state with the memory tools when it changes.\n\n" +
    body +
    (p.truncated ? "\n\n(older learnings omitted to fit the memory budget)" : "")
  );
}
