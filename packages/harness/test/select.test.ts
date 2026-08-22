import { describe, expect, test } from "bun:test";
import type { Catalog, TierInfo } from "../src/catalog/catalog";
import { selectModel } from "../src/routing/select";

// A catalog shaped like the gateway's routing-ladder response.
function tier(model: string, caps: string[], input: number | null, alternates: TierInfo["alternates"] = []): TierInfo {
  return {
    model,
    provider: "x",
    rel_cost: 1,
    good_for: "",
    caps,
    context: input == null ? undefined : { input, output: 128000 },
    served_alternate: false,
    alternates,
  };
}

const ALL = ["tools", "vision", "pdf", "streaming"];
const CAT: Catalog = {
  schema: 3,
  profile: "coding",
  updated: "2026-07-28",
  routing_ladder: ["cheap", "mid", "frontier", "max"],
  tiers: {
    cheap: tier("gpt-5.6-luna", ALL, 1_050_000, [
      { model: "gemini-3.5-flash", provider: "google", rel_cost: 4, available: true, caps: ALL, context: { input: 1_048_576, output: 65536 } },
    ]),
    mid: tier("gpt-5.6-terra", ALL, 1_050_000),
    frontier: tier("claude-opus-5", ALL, 1_000_000, [
      { model: "gpt-5.6-sol", provider: "openai", rel_cost: 56, available: true, caps: ALL, context: { input: 1_050_000, output: 128000 } },
    ]),
    max: tier("claude-fable-5", ALL, 1_000_000),
  } as Catalog["tiers"],
};

describe("selectModel with null-model tiers (small self-hosted box)", () => {
  test("a null tier primary is skipped; served alternates still count; else step up", () => {
    const c = structuredClone(CAT);
    c.tiers.mid = { ...c.tiers.mid, model: null };
    // mid's primary unserved, no alternates → complexity 1 steps up to frontier.
    expect(selectModel(c, { complexity: 1 })).toBe("claude-opus-5");
    // A served alternate in the null tier is still eligible.
    c.tiers.mid = { ...c.tiers.mid, alternates: [{ model: "local-served", provider: "x", rel_cost: 1, available: true, caps: ALL }] };
    expect(selectModel(c, { complexity: 1 })).toBe("local-served");
  });
});

describe("selectModel over the routing ladder", () => {
  test("maps complexity onto the ladder (0→cheap … 3→max)", () => {
    expect(selectModel(CAT, { complexity: 0 })).toBe("gpt-5.6-luna");
    expect(selectModel(CAT, { complexity: 1 })).toBe("gpt-5.6-terra");
    expect(selectModel(CAT, { complexity: 2 })).toBe("claude-opus-5");
    expect(selectModel(CAT, { complexity: 3 })).toBe("claude-fable-5");
  });

  test("clamps out-of-range complexity to the ladder ends", () => {
    expect(selectModel(CAT, { complexity: -1 })).toBe("gpt-5.6-luna");
    expect(selectModel(CAT, { complexity: 9 })).toBe("claude-fable-5");
    expect(selectModel(CAT, {})).toBe("gpt-5.6-terra"); // default complexity 1
  });

  test("defaults to the tier's primary model when caps/context are fine", () => {
    expect(selectModel(CAT, { complexity: 0, needCaps: ["vision"] })).toBe("gpt-5.6-luna");
  });

  test("falls to an available alternate when the primary lacks a needed cap", () => {
    const noVisionPrimary: Catalog = {
      ...CAT,
      tiers: {
        ...CAT.tiers,
        cheap: tier("text-only-primary", ["tools", "streaming"], 1_000_000, [
          { model: "gemini-3.5-flash", provider: "google", rel_cost: 4, available: true, caps: ALL, context: { input: 1_000_000, output: 65536 } },
        ]),
      } as Catalog["tiers"],
    };
    expect(selectModel(noVisionPrimary, { complexity: 0, needCaps: ["vision"] })).toBe("gemini-3.5-flash");
  });

  test("steps UP the ladder when no candidate in the tier meets the filter", () => {
    // cheap tier has a 200k model with no alternate that fits; a 500k need forces a step up.
    const smallCheap: Catalog = {
      ...CAT,
      tiers: { ...CAT.tiers, cheap: tier("small-cheap", ALL, 200_000) } as Catalog["tiers"],
    };
    expect(selectModel(smallCheap, { complexity: 0, minContextInput: 500_000 })).toBe("gpt-5.6-terra");
  });

  test("missing context.input is treated as unknown, not filtered out", () => {
    const noCtx: Catalog = {
      ...CAT,
      tiers: { ...CAT.tiers, cheap: tier("no-ctx-model", ALL, null) } as Catalog["tiers"],
    };
    expect(selectModel(noCtx, { complexity: 0, minContextInput: 999_999 })).toBe("no-ctx-model");
  });

  test("skips an unavailable alternate", () => {
    const cat: Catalog = {
      ...CAT,
      tiers: {
        ...CAT.tiers,
        cheap: tier("text-only-primary", ["tools"], 1_000_000, [
          { model: "down", provider: "x", rel_cost: 1, available: false, caps: ALL, context: { input: 1_000_000, output: 1 } },
          { model: "up", provider: "x", rel_cost: 1, available: true, caps: ALL, context: { input: 1_000_000, output: 1 } },
        ]),
      } as Catalog["tiers"],
    };
    expect(selectModel(cat, { complexity: 0, needCaps: ["vision"] })).toBe("up");
  });

  test("returns null without a routing_ladder (old schema / offline) so the caller falls back", () => {
    expect(selectModel({ ...CAT, routing_ladder: undefined }, { complexity: 0 })).toBeNull();
    expect(selectModel({ ...CAT, routing_ladder: [] }, { complexity: 0 })).toBeNull();
  });
});
