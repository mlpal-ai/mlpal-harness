/**
 * The safety-envelope evaluator (HOP §10). A HOP with a `safety` block is autonomous inside a
 * declared envelope and must stop at the edge. This module is the PURE decision core: given the
 * envelope, a normalized action, and the run-state signals the host supplies (is there a reviewed
 * plan? is required information present?), it returns a disposition + a stable reason code. The
 * stateful bits (computing the plan hash, reading the dry-run record) live in the host; injecting
 * them keeps this fully unit-testable and product-neutral.
 *
 * `park` is the edge: the host maps it to an interactive `ask` or, headless, to a `needs_approval`
 * terminal outcome (§10.1). `deny` is a hard policy denial. `allow` proceeds inside the envelope.
 */
import type { SafetyPolicy } from "../profile/types";
import { globMatch } from "./engine";
import { splitShellCommands } from "./safety";

/** Stable disposition reason for the attempt trace — pinned so safety graders can assert on it.
 *  Do not reorder or rename without coordinating the memory-side graders. */
export type SafetyReason =
  | "policy_denied" // a mutative/destructive apply with no reviewed plan artifact — hard deny
  | "out_of_envelope" // outside the account / region / required-tag allowlist
  | "over_ceiling" // exceeds maxResources or the monthly cost ceiling
  | "needs_approval" // a reviewed destructive plan parked at the approval edge
  | "missing_info"; // required information for the action is absent (needs_clarification)

export type SafetyClass = "readOnly" | "mutative" | "destructive";
export type SafetyOutcome = "allow" | "deny" | "park";

export interface SafetyDisposition {
  outcome: SafetyOutcome;
  /** Present on deny/park; absent on allow. */
  reason?: SafetyReason;
  /** Human-readable detail for the deny/ask message and the attempt-trace log. */
  detail?: string;
}

/** The plan/estimate signals a preceding dry-run produced; absent until a plan exists. */
export interface PlanSignals {
  resourceCount?: number;
  accounts?: string[];
  regions?: string[];
  costUsdMonth?: number;
  /** Whether the plan carries the required ownership tag (safety.blastRadius.requireTag). */
  tagged?: boolean;
}

/** A normalized action under evaluation. */
export interface SafetyAction {
  toolName: string;
  /** The command / representative arg used for toolClass matching. */
  command: string;
  /** Static capability tags of the tool. */
  tags: { readOnly?: boolean; applies?: boolean; infra?: boolean };
  plan?: PlanSignals;
}

/** Host-supplied run-state signals the pure core cannot compute itself. */
export interface SafetyEvalState {
  /** A reviewed plan artifact matching this apply exists (the stateful preApply check). */
  planApproved?: boolean;
  /** Required information for the action is present. */
  hasRequiredInfo?: boolean;
}

/** Does any entry in a toolClass list match this action? Entries use the permissions rule grammar
 *  `Tool(pattern)` (sub-command aware for Bash) or a bare command/tool glob. */
function anyMatch(patterns: string[], action: SafetyAction): boolean {
  const subs = splitShellCommands(action.command);
  const cmdParts = subs.length > 0 ? subs : [action.command];
  return patterns.some((entry) => {
    const m = entry.match(/^([A-Za-z_]+)\((.*)\)$/);
    if (m) {
      if (m[1] !== action.toolName) return false;
      return cmdParts.some((s) => globMatch(m[2]!, s));
    }
    // bare entry: the tool name itself, or a command glob against any sub-command.
    return entry === action.toolName || cmdParts.some((s) => globMatch(entry, s));
  });
}

/** Classify an action against the envelope's toolClasses. Precedence destructive > mutative >
 *  readOnly; an unlisted action on an `applies`-tagged tool defaults to `mutative` (never
 *  `destructive` — that must be explicit), everything else to `readOnly`. */
export function classifyAction(safety: SafetyPolicy, action: SafetyAction): SafetyClass {
  const tc = safety.toolClasses;
  if (anyMatch(tc.destructive, action)) return "destructive";
  if (anyMatch(tc.mutative, action)) return "mutative";
  if (anyMatch(tc.readOnly, action)) return "readOnly";
  return action.tags.applies ? "mutative" : "readOnly";
}

/** Evaluate one action against the envelope. Pure; the host maps `park` to ask/needs_approval. */
export function evaluateSafety(
  safety: SafetyPolicy,
  action: SafetyAction,
  state: SafetyEvalState = {},
): SafetyDisposition {
  const cls = classifyAction(safety, action);
  if (cls === "readOnly") return { outcome: "allow" };

  if (state.hasRequiredInfo === false) {
    return { outcome: "park", reason: "missing_info", detail: "required information is missing" };
  }

  const br = safety.blastRadius;
  const plan = action.plan;
  if (plan) {
    if (safety.approval.outOfScope === "always") {
      if (br.accounts && plan.accounts && !plan.accounts.every((a) => br.accounts!.includes(a))) {
        return { outcome: "park", reason: "out_of_envelope", detail: "account not in allowlist" };
      }
      if (br.regions && plan.regions && !plan.regions.every((r) => br.regions!.includes(r))) {
        return { outcome: "park", reason: "out_of_envelope", detail: "region not in allowlist" };
      }
      if (br.requireTag && plan.tagged === false) {
        return { outcome: "park", reason: "out_of_envelope", detail: `missing required tag ${br.requireTag}` };
      }
    }
    if (br.maxResources !== undefined && plan.resourceCount !== undefined && plan.resourceCount > br.maxResources) {
      return { outcome: "park", reason: "over_ceiling", detail: `${plan.resourceCount} resources > ${br.maxResources}` };
    }
    const ceil = safety.approval.costCeilingUsdMonth;
    if (ceil !== undefined && plan.costUsdMonth !== undefined && plan.costUsdMonth > ceil) {
      return { outcome: "park", reason: "over_ceiling", detail: `$${plan.costUsdMonth}/mo > $${ceil}` };
    }
  }

  // A mutative/destructive apply requires a reviewed plan artifact (stateful preApply). No plan
  // on record => hard deny, never a silent apply of an unreviewed change.
  if (safety.preApply.requirePlanArtifact && state.planApproved === false) {
    return { outcome: "deny", reason: "policy_denied", detail: "no reviewed plan artifact for this apply (preApply)" };
  }

  // A reviewed destructive plan still stops at the approval edge.
  if (cls === "destructive" && safety.approval.destructive === "always") {
    return { outcome: "park", reason: "needs_approval", detail: "destructive action requires approval" };
  }

  return { outcome: "allow" };
}

/** One attempt-trace record (content-free): the host stamps `ts` and writes these to the run-dir
 *  trace the safety graders read. Field names are the grader contract — `class`/`disposition`
 *  rather than the internal `SafetyClass`/`outcome` labels. `reason` is the stable enum above. */
export interface AttemptTraceEntry {
  tool: string;
  command: string;
  class: SafetyClass;
  disposition: "allowed" | "denied" | "parked";
  reason?: SafetyReason;
  detail?: string;
}

const DISPOSITION: Record<SafetyOutcome, AttemptTraceEntry["disposition"]> = {
  allow: "allowed",
  deny: "denied",
  park: "parked",
};

/** Build the trace record for an action + its disposition (host adds a timestamp). */
export function toTraceEntry(
  safety: SafetyPolicy,
  action: SafetyAction,
  disp: SafetyDisposition,
): AttemptTraceEntry {
  return {
    tool: action.toolName,
    command: action.command,
    class: classifyAction(safety, action),
    disposition: DISPOSITION[disp.outcome],
    ...(disp.reason ? { reason: disp.reason } : {}),
    ...(disp.detail ? { detail: disp.detail } : {}),
  };
}
