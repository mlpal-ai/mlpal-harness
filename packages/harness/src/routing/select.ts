import type { Catalog, TierInfo } from "../catalog/catalog";

/**
 * Subtask model selection over the gateway's authoritative routing ladder.
 *
 * The gateway owns "which model is the current cheap/mid/hard one" — the curated `tiers` block is
 * guaranteed current-generation, cost-ordered (`routing_ladder`, cheapest → most capable), provider-
 * scoped (OpenAI/Anthropic/Google), with `caps` + real `context` on every tier and alternate. So the
 * client does one thin, offline, deterministic thing: map a subtask's estimated complexity onto the
 * ladder, then hard-filter on caps + context — falling to an available alternate in the tier, or
 * stepping UP the ladder, when the tier's model can't do it. No reconstructing "latest + cost" here;
 * that heuristic went stale and is now the gateway's job (see docs / feedback loop).
 */

export interface SelectSpec {
  /** Hard capability filter — the chosen model must offer every one of these (e.g. "vision"). */
  needCaps?: string[];
  /** Minimum real input window the subtask needs, in tokens. */
  minContextInput?: number;
  /** Estimated complexity, mapped onto the routing ladder (clamped to its length). Default 1. */
  complexity?: number;
}

/** A model in a tier (primary or an available alternate), with its filterable attributes. */
interface Candidate {
  model: string;
  caps?: string[];
  context?: { input: number; output: number | null };
}

/** Missing `context.input` is "unknown", not "too small" — don't hard-filter it out. */
function contextOk(c: Candidate, minCtx: number): boolean {
  const input = c.context?.input;
  return input == null || input >= minCtx;
}

/** First candidate in a tier (primary, then available alternates) meeting caps + context. */
function pickFromTier(tier: TierInfo, needCaps: string[], minCtx: number): string | null {
  const candidates: Candidate[] = [
    // A small box can serve no candidate for this tier (model: null) — alternates may still apply.
    ...(tier.model ? [{ model: tier.model, caps: tier.caps, context: tier.context }] : []),
    ...tier.alternates.filter((a) => a.available).map((a) => ({ model: a.model, caps: a.caps, context: a.context })),
  ];
  for (const c of candidates) {
    if (needCaps.every((cap) => (c.caps ?? []).includes(cap)) && contextOk(c, minCtx)) return c.model;
  }
  return null;
}

/**
 * Pick a model tag for a subtask, or null when the catalog carries no `routing_ladder` (old schema /
 * offline) so the caller can fall back to its own tier routing.
 */
export function selectModel(catalog: Catalog, spec: SelectSpec): string | null {
  const ladder = catalog.routing_ladder;
  if (!ladder?.length || !catalog.tiers) return null;

  const needCaps = spec.needCaps ?? [];
  const minCtx = spec.minContextInput ?? 0;
  const start = Math.max(0, Math.min(ladder.length - 1, Math.round(spec.complexity ?? 1)));

  // From the complexity-chosen rung, step UP the ladder (toward more capable) until caps/context fit.
  for (let i = start; i < ladder.length; i++) {
    const tier = catalog.tiers[ladder[i] as keyof typeof catalog.tiers];
    if (!tier) continue;
    const pick = pickFromTier(tier, needCaps, minCtx);
    if (pick) return pick;
  }
  return null; // nothing up the ladder meets the hard filter → caller falls back
}
