import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostDir } from "../host";

/**
 * Curated model catalog, served by the assistants service at GET /v1/catalog?profile=<p>.
 * Yodex knows only stable TIERS (max/frontier/mid/cheap); the gateway maps each tier to whatever
 * the best current model is, so a new model launch is a gateway curation edit with zero yodex
 * releases. The endpoint is Cache-Control: no-cache + ETag — it reflects LIVE availability — so
 * every load revalidates (cheap 304 when unchanged); the local copy exists for offline, falling
 * back to a baked last-known-good catalog when there is no cache either, so routing never
 * hard-fails. On a small self-hosted box a tier's `model` may be null (no candidate served).
 */
export const TIERS = ["max", "frontier", "mid", "cheap"] as const;
export type Tier = (typeof TIERS)[number];

export function isTier(s: string): s is Tier {
  return (TIERS as readonly string[]).includes(s);
}

/** Real context window. `output` may be null in the registry — treat missing as unknown, don't filter. */
export interface TierContext {
  input: number;
  output: number | null;
}
export interface CatalogAlternate {
  model: string;
  provider: string;
  rel_cost: number;
  available: boolean;
  // Present from the routing-ladder update: so a client can hard-filter an alternate without a second call.
  caps?: string[];
  context?: TierContext;
}
export interface TierInfo {
  /** Null on a small self-hosted box when no candidate for this tier is served. */
  model: string | null;
  provider: string;
  rel_cost: number;
  good_for: string;
  caps: string[];
  context?: TierContext;
  served_alternate: boolean;
  alternates: CatalogAlternate[];
}
// ---- schema >= 3: per-model axes (independent; a null quality axis means "unmeasured", not bad) --
export interface ModelCost {
  input_cu_per_1m: number;
  output_cu_per_1m: number;
}
export interface ModelContext {
  input: number;
  output: number;
}
export interface ModelThroughput {
  class: "fast" | "medium" | "slow" | null;
  output_tokens_per_sec: number | null;
  ms_per_output_token: number | null;
  p50_total_ms?: number | null;
  p95_total_ms?: number | null;
  samples: number;
}
export interface ModelLineage {
  provider: string;
  generation: number;
  tier: string;
  tier_rank: number; // 1 = flagship within the provider
  latest_in_tier: boolean;
}
export interface Benchmark {
  score: number;
  source: string;
  as_of?: string;
}
export interface ModelCard {
  summary: string;
  benchmarks: Record<string, Benchmark> | null; // published capability per dimension, dated + sourced
}
export interface MeasuredScore {
  score: number;
  accept_rate?: number;
  escalation_rate?: number;
  samples: number;
}
export interface CatalogModel {
  provider: string;
  lineage: ModelLineage;
  context: ModelContext;
  caps: string[];
  cost: ModelCost;
  throughput: ModelThroughput;
  card: ModelCard | null;
  measured: Record<string, MeasuredScore> | null; // OUR delegation outcomes; orthogonal to card
}
export interface BenchmarkRank {
  model: string;
  score: number;
  source: string;
}

export interface Catalog {
  schema: number;
  profile: string;
  updated: string;
  tiers: Record<Tier, TierInfo>;
  /** The authoritative routing ladder, cheapest → most capable (e.g. ["cheap","mid","frontier","max"]).
   *  Map a subtask's complexity onto this ordinal; the gateway keeps the tier→model mapping current. */
  routing_ladder?: string[];
  // Present from schema 3 on; optional so the baked fallback and old caches still type-check.
  quality_dimensions?: string[];
  flagships?: Record<string, string>; // provider -> best tag (intra-provider only)
  benchmark_rankings?: Record<string, BenchmarkRank[]>; // dimension -> leaderboard
  models?: Record<string, CatalogModel>;
}

/** Baked last-known-good (prod catalog, coding profile). Used only when the gateway is
 *  unreachable AND there is no local cache — so first-run-offline still routes sensibly. */
export const FALLBACK_CATALOG: Catalog = {
  schema: 1,
  profile: "coding",
  updated: "2026-07-14",
  routing_ladder: ["cheap", "mid", "frontier", "max"],
  tiers: {
    max: { model: "claude-fable-5", provider: "anthropic", rel_cost: 100, good_for: "hardest reasoning, architecture, deep repo-level engineering", caps: ["tools", "vision", "pdf", "streaming"], served_alternate: false, alternates: [{ model: "claude-opus-4-8", provider: "anthropic", rel_cost: 50, available: true }] },
    frontier: { model: "gpt-5.6-sol", provider: "openai", rel_cost: 56, good_for: "production coding agents, terminal/tool-heavy work", caps: ["tools", "vision", "pdf", "streaming"], served_alternate: false, alternates: [{ model: "claude-opus-4-8", provider: "anthropic", rel_cost: 50, available: true }] },
    mid: { model: "gpt-5.6-terra", provider: "openai", rel_cost: 28, good_for: "most implementation, moderate reasoning, everyday agent work", caps: ["tools", "vision", "pdf", "streaming"], served_alternate: false, alternates: [{ model: "claude-sonnet-5", provider: "anthropic", rel_cost: 30, available: true }] },
    cheap: { model: "gpt-5.6-luna", provider: "openai", rel_cost: 11, good_for: "mechanical edits, extraction, search, summaries, classification", caps: ["tools", "vision", "pdf", "streaming"], served_alternate: false, alternates: [{ model: "gemini-3.5-flash", provider: "google", rel_cost: 4, available: true }, { model: "claude-haiku-4-5-20251001", provider: "anthropic", rel_cost: 10, available: true }] },
  },
};

interface CacheFile {
  etag: string | null;
  fetchedAt: number;
  catalog: Catalog;
}

/** Structural check: all four tiers present, each `model` a non-empty string or null (a small
 *  self-hosted box may serve no candidate for a tier), and at least one tier servable. */
export function isValidCatalog(x: unknown): x is Catalog {
  const c = x as Catalog;
  if (!c || !c.tiers) return false;
  const modelOk = (m: unknown) => m === null || (typeof m === "string" && m.length > 0);
  if (!TIERS.every((t) => c.tiers[t] && modelOk(c.tiers[t].model))) return false;
  return TIERS.some((t) => typeof c.tiers[t].model === "string");
}

export interface LoadCatalogOptions {
  baseUrl: string;
  apiKey: string;
  profile?: string;
  /** Home dir for the on-disk copy (~/.yodex/catalog-<profile>.json) — the ETag/offline
   *  substrate, never a freshness authority: the endpoint is no-cache and every load
   *  revalidates (cheap 304 when unchanged). */
  home: string;
  /** Network timeout for the fetch. Default 3s — startup must not hang on the catalog. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type CatalogSource = "network" | "cache" | "fallback";

function readCache(path: string): CacheFile | null {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    return isValidCatalog(c.catalog) ? c : null;
  } catch {
    return null;
  }
}

function writeCache(path: string, cf: CacheFile): void {
  try {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cf));
  } catch {
    // best-effort cache; a read-only home just means we re-fetch next time
  }
}

/**
 * Load the curated catalog: always revalidate via ETag (304 → cache, 200 → network) — the
 * endpoint reflects LIVE model availability, so a fixed-TTL fast-path would serve stale
 * served-sets; on any network/parse failure → cached copy, else baked fallback. Never throws.
 */
export async function loadCatalog(o: LoadCatalogOptions): Promise<{ catalog: Catalog; source: CatalogSource }> {
  const profile = o.profile ?? "coding";
  const now = o.now ?? Date.now;
  const doFetch = o.fetchImpl ?? fetch;
  // Keyed by gateway host as well as profile: different gateways serve different catalogs
  // (a self-hosted box vs prod), and a shared file would let one gateway's catalog answer an
  // OFFLINE run against the other. Prod keeps the historical unsuffixed name.
  const host = createHash("sha256").update(o.baseUrl.replace(/\/$/, "")).digest("hex").slice(0, 8);
  const suffix = o.baseUrl.replace(/\/$/, "") === "https://models.mlpal.ai" ? "" : `-${host}`;
  const cachePath = hostDir(o.home, `catalog-${profile}${suffix}.json`);
  const cached = readCache(cachePath);

  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${o.apiKey}` };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    const res = await doFetch(`${o.baseUrl}/v1/catalog?profile=${encodeURIComponent(profile)}`, {
      headers,
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
    });
    if (res.status === 304 && cached) {
      writeCache(cachePath, { ...cached, fetchedAt: now() });
      return { catalog: cached.catalog, source: "cache" };
    }
    if (res.ok) {
      const catalog = (await res.json()) as Catalog;
      if (isValidCatalog(catalog)) {
        writeCache(cachePath, { etag: res.headers.get("etag"), fetchedAt: now(), catalog });
        return { catalog, source: "network" };
      }
    }
  } catch {
    // network error / timeout / bad JSON — fall through to cache or baked fallback
  }
  if (cached) return { catalog: cached.catalog, source: "cache" };
  return { catalog: FALLBACK_CATALOG, source: "fallback" };
}

/** The model currently serving a tier — null when the deployment serves no candidate for it. */
export function tierModel(catalog: Catalog, tier: Tier): string | null {
  return catalog.tiers[tier].model;
}

/** The tier's model, or the nearest servable rung: served alternates in the tier first, then up
 *  the ladder (stronger — mirrors selectModel's step-up rule), then down. Null only when no tier
 *  serves anything, which isValidCatalog rejects — so in practice a catalog always resolves. */
export function tierModelOrNearest(catalog: Catalog, tier: Tier): string | null {
  const inTier = (t: Tier): string | null =>
    catalog.tiers[t].model ?? catalog.tiers[t].alternates.find((a) => a.available)?.model ?? null;
  const own = inTier(tier);
  if (own) return own;
  const ladder = (catalog.routing_ladder ?? [...TIERS].reverse()).filter(isTier);
  const at = ladder.indexOf(tier);
  for (let i = at + 1; i < ladder.length; i++) {
    const m = inTier(ladder[i]!);
    if (m) return m;
  }
  for (let i = at - 1; i >= 0; i--) {
    const m = inTier(ladder[i]!);
    if (m) return m;
  }
  return null;
}

export type BudgetStrategy = "economy" | "balanced" | "quality";

/**
 * The tier ladder (cheap -> strong) for a budget strategy. The loop starts on the cheapest rung
 * and climbs only as needed (proactively via the difficulty classifier, reactively on verifier
 * failure), so easy tasks are solved cheap and only hard tasks pay for a stronger model.
 */
export function budgetTiers(strategy: BudgetStrategy): Tier[] {
  switch (strategy) {
    case "economy":
      return ["cheap", "mid"];
    case "balanced":
      return ["cheap", "mid", "frontier"];
    case "quality":
      return ["mid", "frontier", "max"];
  }
}

/**
 * Runtime failover ladder for a model: the other *available* models in its tier (primary +
 * alternates), minus itself, in order. Empty for a model not in the catalog. Passed to the
 * gateway so a transient failure on the served model falls over to a same-tier sibling instead
 * of hard-failing — the multi-model-per-tier resilience the catalog exists to provide.
 */
export function tierFallbacks(catalog: Catalog, model: string): string[] {
  for (const t of TIERS) {
    const info = catalog.tiers[t];
    const inTier = info.model === model || info.alternates.some((a) => a.model === model);
    if (inTier) {
      const ordered = [info.model, ...info.alternates.filter((a) => a.available).map((a) => a.model)];
      return [...new Set(ordered)].filter((m): m is string => m !== null && m !== model);
    }
  }
  return [];
}
