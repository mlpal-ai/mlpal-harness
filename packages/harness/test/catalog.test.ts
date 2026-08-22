import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FALLBACK_CATALOG, type Catalog, budgetTiers, isTier, isValidCatalog, loadCatalog, tierFallbacks, tierModel, tierModelOrNearest } from "../src/catalog/catalog";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "yodex-catalog-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const sample: Catalog = {
  schema: 1,
  profile: "coding",
  updated: "2026-07-14",
  tiers: {
    max: { model: "claude-fable-5", provider: "anthropic", rel_cost: 100, good_for: "x", caps: ["tools"], served_alternate: false, alternates: [] },
    frontier: { model: "gpt-5.6-sol", provider: "openai", rel_cost: 56, good_for: "x", caps: ["tools"], served_alternate: false, alternates: [] },
    mid: { model: "gpt-5.6-terra", provider: "openai", rel_cost: 28, good_for: "x", caps: ["tools"], served_alternate: false, alternates: [] },
    cheap: { model: "gpt-5.6-luna", provider: "openai", rel_cost: 11, good_for: "x", caps: ["tools"], served_alternate: false, alternates: [] },
  },
};

const res = (status: number, body: unknown, etag?: string): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === "etag" ? etag ?? null : null) },
    json: async () => body,
  }) as unknown as Response;

const base = { baseUrl: "https://models.mlpal.ai", apiKey: "k", now: () => 1000 };

describe("catalog client", () => {
  test("isTier and tierModel", () => {
    expect(isTier("cheap")).toBe(true);
    expect(isTier("gpt-5.6-luna")).toBe(false);
    expect(tierModel(sample, "cheap")).toBe("gpt-5.6-luna");
    expect(tierModel(sample, "max")).toBe("claude-fable-5");
  });

  test("fetches and caches from network (200)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return res(200, sample, '"abc"');
    }) as unknown as typeof fetch;
    const r = await loadCatalog({ ...base, home, fetchImpl });
    expect(r.source).toBe("network");
    expect(r.catalog.tiers.cheap.model).toBe("gpt-5.6-luna");
    expect(calls).toBe(1);
  });

  test("every load revalidates — no TTL fast-path (catalog reflects live availability)", async () => {
    const netFetch = (async () => res(200, sample, '"abc"')) as unknown as typeof fetch;
    await loadCatalog({ ...base, home, fetchImpl: netFetch }); // seed cache at t=1000
    let calls = 0;
    const guard = (async () => {
      calls++;
      return res(304, {});
    }) as unknown as typeof fetch;
    const r = await loadCatalog({ ...base, home, fetchImpl: guard, now: () => 1000 + 60_000 });
    expect(calls).toBe(1); // seconds-old cache still revalidates (cheap 304)
    expect(r.source).toBe("cache");
  });

  test("revalidates with ETag: 304 keeps the cached catalog", async () => {
    const seed = (async () => res(200, sample, '"abc"')) as unknown as typeof fetch;
    await loadCatalog({ ...base, home, fetchImpl: seed });
    let sentIfNoneMatch: string | undefined;
    const revalidate = (async (_url: string, init: RequestInit) => {
      sentIfNoneMatch = (init.headers as Record<string, string>)["If-None-Match"];
      return res(304, {});
    }) as unknown as typeof fetch;
    const r = await loadCatalog({ ...base, home, fetchImpl: revalidate });
    expect(sentIfNoneMatch).toBe('"abc"');
    expect(r.source).toBe("cache");
    expect(r.catalog.tiers.mid.model).toBe("gpt-5.6-terra");
  });

  test("network error with no cache falls back to baked catalog", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const r = await loadCatalog({ ...base, home, fetchImpl: boom });
    expect(r.source).toBe("fallback");
    expect(r.catalog).toEqual(FALLBACK_CATALOG);
    expect(isValidCatalog(r.catalog)).toBe(true);
  });

  test("malformed response is rejected (falls back)", async () => {
    const bad = (async () => res(200, { schema: 1, tiers: { cheap: {} } })) as unknown as typeof fetch;
    const r = await loadCatalog({ ...base, home, fetchImpl: bad });
    expect(r.source).toBe("fallback");
  });

  test("tierFallbacks returns same-tier available siblings, minus self", () => {
    // cheap tier primary is gpt-5.6-luna; alternates gemini-3.5-flash + claude-haiku
    expect(tierFallbacks(FALLBACK_CATALOG, "gpt-5.6-luna")).toEqual(["gemini-3.5-flash", "claude-haiku-4-5-20251001"]);
    // asking about an alternate returns the primary + the other alternate
    expect(tierFallbacks(FALLBACK_CATALOG, "gemini-3.5-flash")).toEqual(["gpt-5.6-luna", "claude-haiku-4-5-20251001"]);
    // max tier: primary fable-5, alternate opus-4-8
    expect(tierFallbacks(FALLBACK_CATALOG, "claude-fable-5")).toEqual(["claude-opus-4-8"]);
    // unknown model => no ladder
    expect(tierFallbacks(FALLBACK_CATALOG, "some-unknown-model")).toEqual([]);
  });

  test("budgetTiers ladders are cheap->strong and within each strategy's range", () => {
    expect(budgetTiers("economy")).toEqual(["cheap", "mid"]);
    expect(budgetTiers("balanced")).toEqual(["cheap", "mid", "frontier"]);
    expect(budgetTiers("quality")).toEqual(["mid", "frontier", "max"]);
    // every rung is a real tier, ordered cheapest-first
    for (const s of ["economy", "balanced", "quality"] as const) {
      for (const t of budgetTiers(s)) expect(isTier(t)).toBe(true);
    }
  });

  test("isValidCatalog: four tiers present; null models tolerated; all-null rejected", () => {
    expect(isValidCatalog(sample)).toBe(true);
    expect(isValidCatalog({ tiers: { max: { model: "x" } } })).toBe(false);
    expect(isValidCatalog(null)).toBe(false);
    // A small self-hosted box: some tiers have no served candidate.
    const partial = structuredClone(sample);
    partial.tiers.max.model = null;
    partial.tiers.frontier.model = null;
    expect(isValidCatalog(partial)).toBe(true);
    // No tier serves anything → useless for routing → invalid (fallback wins).
    const empty = structuredClone(sample);
    for (const t of ["max", "frontier", "mid", "cheap"] as const) empty.tiers[t].model = null;
    expect(isValidCatalog(empty)).toBe(false);
  });

  test("null-model tiers: nearest-rung resolution and fallback laddering skip them", () => {
    const c = structuredClone(sample);
    c.routing_ladder = ["cheap", "mid", "frontier", "max"];
    c.tiers.frontier.model = null;
    c.tiers.frontier.alternates = [{ model: "alt-served", provider: "x", rel_cost: 1, available: true }];
    // Own tier first: a served alternate covers a null primary.
    expect(tierModelOrNearest(c, "frontier")).toBe("alt-served");
    // No candidates at all in the tier → step UP the ladder, then down.
    c.tiers.frontier.alternates = [];
    expect(tierModel(c, "frontier")).toBeNull();
    expect(tierModelOrNearest(c, "frontier")).toBe("claude-fable-5"); // up to max
    c.tiers.max.model = null;
    expect(tierModelOrNearest(c, "frontier")).toBe("gpt-5.6-terra"); // down to mid
    // tierFallbacks never emits null.
    c.tiers.mid.alternates = [{ model: "m2", provider: "x", rel_cost: 1, available: true }];
    expect(tierFallbacks(c, "m2")).toEqual(["gpt-5.6-terra"]);
  });
});
