import type { ModelRefusal } from "@mlpal/harness-protocol";
import { isTier } from "../catalog/catalog";
import type { Profile } from "./types";

/**
 * HOP model policy (spec HOP-MODEL-POLICY, 2026-10-23): a HOP declares which models it may use in
 * the gateway's allow/deny glob form; the gateway enforces it per call on the HOP key; the engine
 * reads the gateway's filtered listing and refuses before a call with one typed code. This module
 * is the engine's local copy of the glob semantics (deny wins; absent, `[]` or `["*"]` allow all),
 * used for the loader's pin check and for naming the HOP in a refusal.
 */
export interface HopModelPolicy {
  allow: string[];
  deny: string[];
}

export const MODEL_ACCESS_DENIED = "model_access_denied" satisfies ModelRefusal["code"];
export const BUDGET_EXCEEDED = "budget_exceeded" satisfies ModelRefusal["code"];

/** fnmatch-style glob as the gateway matches model ids: `*` any run, `?` one char, `[abc]` a class. */
export function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close < 0) out += "\\[";
      else {
        const body = glob.slice(i + 1, close).replace(/^!/, "^");
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else out += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

/** A policy with nothing to enforce: absent, empty, or an allow-all with no deny. */
export function policyIsOpen(policy: HopModelPolicy | undefined): boolean {
  if (!policy) return true;
  const allowAll = policy.allow.length === 0 || policy.allow.every((g) => g === "*");
  return allowAll && policy.deny.length === 0;
}

/** True when `model` may run under `policy`: a deny match refuses; else an empty or `*` allow, or an allow match. */
export function policyAllows(policy: HopModelPolicy | undefined, model: string): boolean {
  if (!policy) return true;
  if (policy.deny.some((g) => globToRegExp(g).test(model))) return false;
  if (policy.allow.length === 0) return true;
  return policy.allow.some((g) => globToRegExp(g).test(model));
}

/** The literal model ids a composed HOP pins (tier aliases excluded: they resolve at run time).
 *  What the publisher posts as `models` and what the loader checks against the HOP's own policy. */
export function pinnedModels(profile: Pick<Profile, "model" | "verification">): string[] {
  const out = new Set<string>();
  const m = profile.model;
  const add = (ref: string | undefined) => {
    if (ref && !isTier(ref) && !(m?.tiers && ref in m.tiers) && ref !== "inherit") out.add(ref);
  };
  if (m) {
    add(m.main);
    add(m.subagents.readOnly);
    add(m.subagents.verify);
    for (const t of Object.values(m.tiers ?? {})) {
      add(t.primary);
      for (const f of t.fallbacks) add(f);
    }
  }
  return [...out];
}

/** The pins a HOP's own policy denies, for the loader's error and the publisher's 422. */
export function pinsOutsidePolicy(profile: Pick<Profile, "model" | "verification" | "modelPolicy">): string[] {
  const policy = profile.modelPolicy;
  if (policyIsOpen(policy)) return [];
  return pinnedModels(profile).filter((id) => !policyAllows(policy, id));
}

/** The one refusal every chooser raises, worded for the person (rule 7). */
export function modelRefusal(model: string, hop: string, reason: ModelRefusal["reason"]): ModelRefusal {
  // Rule 7: every refusal names the model and the HOP; the parenthesis says what narrowed it.
  const message =
    reason === "hop_policy"
      ? `HOP ${hop} does not allow ${model} here`
      : reason === "key_policy"
        ? `HOP ${hop} cannot use ${model} here (the key's own policy narrows it)`
        : reason === "gateway"
          ? `HOP ${hop} cannot use ${model} here (the gateway refused it)`
          : `HOP ${hop} cannot use ${model} here (not served by this gateway)`;
  return { code: MODEL_ACCESS_DENIED, model, hop, reason, message };
}

/** The gateway refused a call because a budget cap of the key is spent (protocol 0.22.1). */
export function budgetRefusal(model: string, hop: string): ModelRefusal {
  return { code: BUDGET_EXCEEDED, model, hop, reason: "gateway", message: `HOP ${hop} cannot call ${model} now (the gateway refused it: a budget cap is spent)` };
}

/** Raised by a chooser before a call; hosts turn it into the typed event the UI reads. */
export class ModelAccessError extends Error {
  constructor(readonly refusal: ModelRefusal) {
    super(refusal.message);
    this.name = "ModelAccessError";
  }
}
