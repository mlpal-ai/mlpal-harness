import type { SessionRecord, Store } from "../store/types";
import type { Usage } from "@mlpal/harness-protocol";

/**
 * Usage and activity statistics from the store's ledgers: the per-call model log (tokens, cache,
 * duration, the gateway's compute units), the exec log (tools, diff sizes) and the session
 * registry (wall time). Pure aggregation — a host renders it as /usage. Cost is the gateway's
 * meter (1 CU = $10) whenever a call carried it; nothing here estimates from a rate card.
 */
export const USD_PER_CU = 10;
/** The gateway's default prompt-cache TTL; an idle gap past it is the commonest miss cause. */
export const CACHE_TTL_MS = 5 * 60_000;

export interface ModelCall {
  ts: string;
  model: string;
  usage: Usage;
  ms?: number;
  computeUnits?: number;
  stopReason?: string;
  /** Tool definitions sent with the call; a change between calls invalidates the cached prefix. */
  tools?: number;
}

export interface CacheMiss {
  index: number;
  ts: string;
  model: string;
  cause: "model switch" | "idle past the cache TTL" | "tool set changed" | "prompt prefix changed";
  /** Tokens re-cached by this call (its cache_creation), i.e. what the miss cost. */
  recached: number;
}

export interface CacheDiagnostics {
  /** cache_read / (input + cache_read + cache_creation) over the session. */
  hitRatio: number;
  reads: number;
  writes: number;
  misses: CacheMiss[];
  /** The last call read from cache => the next one will too (until the TTL). */
  warm: boolean;
}

export interface ModelBreakdown {
  calls: number;
  usage: Usage;
  ms: number;
  computeUnits?: number;
}

export interface SessionUsage {
  sessionId: string;
  calls: number;
  usage: Usage;
  apiMs: number;
  wallMs?: number;
  computeUnits?: number;
  usd?: number;
  models: Record<string, ModelBreakdown>;
  cache: CacheDiagnostics;
  code: { added: number; removed: number; edits: number };
  tools: Record<string, number>;
}

export interface DayActivity {
  day: string; // YYYY-MM-DD local
  tokens: number;
  sessions: number;
  byModel: Record<string, number>;
}

export interface ActivityStats {
  sessions: number;
  activeDays: number;
  spanDays: number;
  totals: Usage;
  computeUnits?: number;
  days: DayActivity[];
  perModel: Record<string, ModelBreakdown & { share: number }>;
  favoriteModel?: string;
  mostActiveDay?: DayActivity;
  longestSession?: { sessionId: string; ms: number };
  streak: { current: number; longest: number };
}

const empty = (): Usage => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const add = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + (b.input_tokens ?? 0),
  output_tokens: a.output_tokens + (b.output_tokens ?? 0),
  cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
});
export const promptTokens = (u: Usage): number => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
export const allTokens = (u: Usage): number => promptTokens(u) + (u.output_tokens ?? 0);

/** +/- line counts of a unified diff (headers excluded). */
export function diffStat(unified: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of unified.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function asCall(r: Record<string, unknown>): ModelCall | null {
  const usage = r.usage as Usage | undefined;
  if (!usage || typeof r.model !== "string") return null;
  return {
    ts: String(r.ts ?? ""),
    model: r.model,
    usage,
    ms: typeof r.ms === "number" ? r.ms : undefined,
    computeUnits: typeof r.computeUnits === "number" ? r.computeUnits : undefined,
    stopReason: typeof r.stopReason === "string" ? r.stopReason : undefined,
    tools: typeof r.tools === "number" ? r.tools : undefined,
  };
}

/** Why a call did not read from cache. The first call is a cold start, not a miss; a call whose
 *  prompt is small never counted. */
export function cacheDiagnostics(calls: ModelCall[], ttlMs = CACHE_TTL_MS): CacheDiagnostics {
  let reads = 0;
  let writes = 0;
  let prompt = 0;
  const misses: CacheMiss[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    const cr = c.usage.cache_read_input_tokens ?? 0;
    const cw = c.usage.cache_creation_input_tokens ?? 0;
    reads += cr;
    writes += cw;
    prompt += promptTokens(c.usage);
    if (i === 0 || promptTokens(c.usage) < 2_000 || cr > 0) continue;
    const prev = calls[i - 1]!;
    const gap = Date.parse(c.ts) - Date.parse(prev.ts);
    const cause: CacheMiss["cause"] =
      c.model !== prev.model
        ? "model switch"
        : Number.isFinite(gap) && gap > ttlMs
          ? "idle past the cache TTL"
          : c.tools !== undefined && prev.tools !== undefined && c.tools !== prev.tools
            ? "tool set changed"
            : "prompt prefix changed";
    misses.push({ index: i, ts: c.ts, model: c.model, cause, recached: cw });
  }
  const last = calls[calls.length - 1];
  return { hitRatio: prompt ? reads / prompt : 0, reads, writes, misses, warm: Boolean(last && (last.usage.cache_read_input_tokens ?? 0) > 0) };
}

export async function sessionUsage(store: Store, sessionId: string): Promise<SessionUsage> {
  const calls = (await store.logs.read(sessionId, "model")).map(asCall).filter((c): c is ModelCall => c !== null);
  const models: Record<string, ModelBreakdown> = {};
  let usage = empty();
  let apiMs = 0;
  let cu: number | undefined;
  for (const c of calls) {
    const m = (models[c.model] ??= { calls: 0, usage: empty(), ms: 0 });
    m.calls++;
    m.usage = add(m.usage, c.usage);
    m.ms += c.ms ?? 0;
    if (c.computeUnits !== undefined) m.computeUnits = (m.computeUnits ?? 0) + c.computeUnits;
    usage = add(usage, c.usage);
    apiMs += c.ms ?? 0;
    if (c.computeUnits !== undefined) cu = (cu ?? 0) + c.computeUnits;
  }
  const exec = await store.logs.read(sessionId, "exec");
  const code = { added: 0, removed: 0, edits: 0 };
  const tools: Record<string, number> = {};
  for (const r of exec) {
    if (typeof r.tool === "string") tools[r.tool] = (tools[r.tool] ?? 0) + 1;
    const d = r.diff as { added?: number; removed?: number } | undefined;
    if (d) {
      code.added += d.added ?? 0;
      code.removed += d.removed ?? 0;
      code.edits++;
    }
  }
  const rec = await store.registry.getSession(sessionId).catch(() => null);
  const wallMs = rec ? Math.max(0, Date.parse(rec.updatedAt) - Date.parse(rec.createdAt)) : undefined;
  return {
    sessionId,
    calls: calls.length,
    usage,
    apiMs,
    ...(wallMs !== undefined && Number.isFinite(wallMs) ? { wallMs } : {}),
    ...(cu === undefined ? {} : { computeUnits: cu, usd: cu * USD_PER_CU }),
    models,
    cache: cacheDiagnostics(calls),
    code,
    tools,
  };
}

const dayOf = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Activity across sessions (optionally the last `days`), read from every session's model log.
 *  Sessions with no model calls do not count as activity. */
export async function activityStats(store: Store, opts: { days?: number; now?: Date } = {}): Promise<ActivityStats> {
  const now = opts.now ?? new Date();
  const since = opts.days ? now.getTime() - opts.days * 86_400_000 : 0;
  const records = (await store.registry.listSessions()).filter((r) => Date.parse(r.updatedAt) >= since);
  const byDay = new Map<string, DayActivity>();
  const perModel: Record<string, ModelBreakdown> = {};
  let totals = empty();
  let cu: number | undefined;
  let sessions = 0;
  let longest: ActivityStats["longestSession"];
  const daySessions = new Map<string, Set<string>>();
  await Promise.all(
    records.map(async (rec: SessionRecord) => {
      const calls = (await store.logs.read(rec.sessionId, "model").catch(() => [])).map(asCall).filter((c): c is ModelCall => c !== null && Date.parse(c.ts) >= since);
      if (!calls.length) return;
      sessions++;
      const ms = Date.parse(rec.updatedAt) - Date.parse(rec.createdAt);
      if (Number.isFinite(ms) && (!longest || ms > longest.ms)) longest = { sessionId: rec.sessionId, ms };
      for (const c of calls) {
        const day = dayOf(c.ts);
        const d = byDay.get(day) ?? { day, tokens: 0, sessions: 0, byModel: {} };
        const tok = allTokens(c.usage);
        d.tokens += tok;
        d.byModel[c.model] = (d.byModel[c.model] ?? 0) + tok;
        byDay.set(day, d);
        (daySessions.get(day) ?? daySessions.set(day, new Set()).get(day)!).add(rec.sessionId);
        const m = (perModel[c.model] ??= { calls: 0, usage: empty(), ms: 0 });
        m.calls++;
        m.usage = add(m.usage, c.usage);
        m.ms += c.ms ?? 0;
        if (c.computeUnits !== undefined) {
          m.computeUnits = (m.computeUnits ?? 0) + c.computeUnits;
          cu = (cu ?? 0) + c.computeUnits;
        }
        totals = add(totals, c.usage);
      }
    }),
  );
  for (const [day, set] of daySessions) byDay.get(day)!.sessions = set.size;
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const grand = allTokens(totals) || 1;
  const perModelShare = Object.fromEntries(Object.entries(perModel).map(([m, b]) => [m, { ...b, share: allTokens(b.usage) / grand }]));
  const favorite = Object.entries(perModel).sort((a, b) => b[1].usage.output_tokens - a[1].usage.output_tokens)[0]?.[0];
  const mostActive = days.length ? days.reduce((a, b) => (b.tokens > a.tokens ? b : a)) : undefined;
  // Streaks over calendar days ending today (or yesterday, if today is untouched so far).
  const active = new Set(days.map((d) => d.day));
  let current = 0;
  const cursor = new Date(now);
  if (!active.has(dayOf(cursor.toISOString()))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(dayOf(cursor.toISOString()))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  let longestStreak = 0;
  let run = 0;
  let prevDay: Date | null = null;
  for (const d of days) {
    const cur = new Date(`${d.day}T12:00:00`);
    run = prevDay && cur.getTime() - prevDay.getTime() <= 86_400_000 * 1.5 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    prevDay = cur;
  }
  const first = days[0] ? new Date(`${days[0].day}T12:00:00`) : now;
  const spanDays = Math.max(1, Math.round((now.getTime() - first.getTime()) / 86_400_000) + 1);
  return {
    sessions,
    activeDays: days.length,
    spanDays,
    totals,
    ...(cu === undefined ? {} : { computeUnits: cu }),
    days,
    perModel: perModelShare,
    ...(favorite ? { favoriteModel: favorite } : {}),
    ...(mostActive ? { mostActiveDay: mostActive } : {}),
    ...(longest ? { longestSession: longest } : {}),
    streak: { current, longest: longestStreak },
  };
}
