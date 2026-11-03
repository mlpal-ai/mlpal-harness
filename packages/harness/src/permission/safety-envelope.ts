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
import { decomposeBash } from "./shell-decompose";
import { invokedByPath, namesKuberc, splitGlobals } from "./plan-gate";

/** Stable disposition reason for the attempt trace — pinned so safety graders can assert on it.
 *  Do not reorder or rename without coordinating the memory-side graders. */
export type SafetyReason =
  | "policy_denied" // a mutative/destructive apply with no reviewed plan artifact — hard deny
  | "out_of_envelope" // outside the account / region / required-tag allowlist
  | "over_ceiling" // exceeds maxResources or the monthly cost ceiling
  | "needs_approval" // a reviewed destructive plan parked at the approval edge
  | "missing_info"; // required information for the action is absent (needs_clarification)

/** `unknown`: a command matching no toolClasses pattern on a tool without capability tags. The
 *  envelope never admits unknown on its own — it falls to allow rules and the mode — and the
 *  attempt trace labels it honestly instead of as a read. */
/** `memory`: a write to the HOP's memory server, never an estate change; admitted in every mode;
 *  deny rules and hard denials still apply (§10.2, memory v6 E5). */
export type SafetyClass = "readOnly" | "memory" | "mutative" | "destructive" | "unknown";
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
  tags: { readOnly?: boolean; applies?: boolean; infra?: boolean; memory?: boolean };
  plan?: PlanSignals;
}

/** Host-supplied run-state signals the pure core cannot compute itself. */
export interface SafetyEvalState {
  /** A reviewed plan artifact matching this apply exists (the stateful preApply check). */
  planApproved?: boolean;
  /** Why, in a sentence (which field differed, or that no plan was recorded), for the person. */
  planDetail?: string;
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
 *  `destructive` — that must be explicit), everything else to `readOnly`. A `memory`-tagged tool
 *  (a working-memory write, not an estate change) is `memory` unless the HOP lists it
 *  explicitly: the explicit lists always win, so a HOP can still gate its memory writes.
 *
 *  D-57: a Bash line is classified by its most dangerous command. Each simple command it runs (shell-decompose.ts:
 *  through `;`, `&&`, `||`, `|`, `&`, subshells, groups, substitutions, `sh -c '…'`, `X=1`/`env`/`timeout`
 *  prefixes) is classified on its own and the worst class wins, so a read beside a write never masks the write; a
 *  command that only sets the line's context (`cd`, `export`, …) adds nothing. A line that cannot be decomposed is
 *  `destructive`: what it runs is unknown, so it stops at the edge (and, with preApply, is refused). */
export function classifyAction(safety: SafetyPolicy, action: SafetyAction): SafetyClass {
  const tc = safety.toolClasses;
  if (anyMatch(tc.destructive, action)) return "destructive";
  if (action.toolName === "Bash" && action.command.trim()) {
    const d = decomposeBash(action.command);
    if (d.opaque !== null) return "destructive";
    let worst: SafetyClass | null = null;
    for (const c of d.commands) {
      const forms = [...c.forms, ...(c.redirected ?? [])];
      if (forms.length === 0 || (c.forms[0] && CONTEXT_ONLY.has(c.forms[0].split(" ")[0]!))) continue;
      // R5-1: a gated tool run by a path is whatever that file is: unreadable (the decomposer's first form is the
      // basename; a later form keeps the path as written)
      if (c.forms.some((f) => invokedByPath(f.split(" ")[0]!))) {
        worst = "destructive";
        continue;
      }
      // Global flags before the verb (`kubectl -s URL --as admin delete ns x`, `helm --kube-context p uninstall`,
      // `terraform -chdir=x apply`): the verb-led form is matched too, so the HOP's verb-anchored lists see the verb; an
      // unknown flag before the verb makes the command unreadable, so it is destructive (fail closed).
      const canon = verbLed(c.forms[0] ?? "");
      if (canon === "unreadable") {
        worst = "destructive";
        continue;
      }
      if (canon) forms.push(canon);
      const cls = classifyForms(tc, action, forms);
      if (worst === null || RANK[cls] > RANK[worst]) worst = cls;
    }
    if (worst !== null) return worst;
  }
  if (anyMatch(tc.mutative, action)) return "mutative";
  if (anyMatch(tc.readOnly, action)) return "readOnly";
  return defaultClass(action);
}

/** A command with its global flags moved after its words (`kubectl -n x --context p apply -f a` → `kubectl apply -f a
 *  -n x --context p`); "unreadable" when a flag before the verb is not a known global, or the command names a kubectl
 *  `--kuberc` (R4-1: its defaults change the command unseen); null when nothing moves. */
function verbLed(form: string): string | null | "unreadable" {
  const ws = form.split(" ");
  const tool = ws[0] ?? "";
  if (namesKuberc(tool, ws.slice(1))) return "unreadable";
  const g = splitGlobals(tool, ws.slice(1));
  if (!g) return null;
  if (g.unknown) return "unreadable";
  if (g.globals.length === 0) return null;
  return [tool, ...g.rest, ...g.globals].join(" ");
}

/** How dangerous a class is, for "the worst command of the line wins". */
const RANK: Record<SafetyClass, number> = { memory: 0, readOnly: 1, unknown: 2, mutative: 3, destructive: 4 };
/** Commands that only set the line's context and run nothing on the estate. */
const CONTEXT_ONLY = new Set(["cd", "pushd", "popd", "export", "unset", "true", "false", ":", "set"]);

function defaultClass(action: SafetyAction): SafetyClass {
  if (action.tags.memory) return "memory";
  if (action.tags.applies) return "mutative";
  return action.tags.readOnly ? "readOnly" : "unknown";
}

/** One simple command's class: the first list (destructive, mutative, readOnly) with an entry matching any of its forms,
 *  else the tool's default. */
function classifyForms(tc: SafetyPolicy["toolClasses"], action: SafetyAction, forms: string[]): SafetyClass {
  const hit = (patterns: string[]) =>
    patterns.some((entry) => {
      const m = entry.match(/^([A-Za-z_]+)\((.*)\)$/);
      if (m) return m[1] === action.toolName && forms.some((f) => globMatch(m[2]!, f));
      return entry === action.toolName || forms.some((f) => globMatch(entry, f));
    });
  if (hit(tc.destructive)) return "destructive";
  if (hit(tc.mutative)) return "mutative";
  if (hit(tc.readOnly)) return "readOnly";
  return defaultClass(action);
}

/** Evaluate one action against the envelope. Pure; the host maps `park` to ask/needs_approval. */
export function evaluateSafety(
  safety: SafetyPolicy,
  action: SafetyAction,
  state: SafetyEvalState = {},
): SafetyDisposition {
  const cls = classifyAction(safety, action);
  if (cls === "readOnly" || cls === "memory" || cls === "unknown") return { outcome: "allow" }; // ungated: the mode decides

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
    return { outcome: "deny", reason: "policy_denied", detail: `no reviewed plan artifact for this apply (preApply)${state.planDetail ? `: ${state.planDetail}` : ""}` };
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
/** Why an attempt ended the way it did: the envelope's reason, or the layer outside the envelope
 *  that decided (the host's hard deny, a deny rule, the mode — recon, or a headless ask refused —
 *  or the user at an interactive prompt). */
export type TraceReason =
  | SafetyReason
  | "hard_deny"
  | "deny_rule"
  | "mode_refused"
  | "mode_refused_headless"
  | "user_declined"
  | "outside_roots"
  | "policy_declined";

export interface AttemptTraceEntry {
  tool: string;
  command: string;
  class: SafetyClass;
  /** The EFFECTIVE outcome after the whole permission cascade, not the envelope's own verdict. */
  disposition: "allowed" | "denied" | "parked";
  reason?: TraceReason;
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
