/**
 * HOPs — Harness Optimization Profiles: the declarative, versioned artifact that
 * configures the agent LOOP, not just its edges. A plugin adds capability (tools,
 * instructions); a HOP tunes the loop itself: routing, verification, permissions,
 * context policy, budgets, subagent topology — plus capabilities, an eval contract, and
 * a telemetry contract. The HOP is the unit of optimization: every knob the tuner may
 * move is declared `tunable` with a range; fields the author locks are `locked` and any
 * override of them is a hard error, never silently ignored.
 *
 * Spec id: `mlpal/hop-v1`. ("HOP" is the industry-facing name; internal type names keep
 * the generic noun "profile" — a HOP is a profile of the harness.)
 *
 * v1 HOPs are pure data. Domain heuristics that are code (verify-command detection) are
 * named builtin sources a HOP selects (`builtin:coding`), not loadable code.
 */

import type { Tier } from "../catalog/catalog";

export const PROFILE_SPEC_ID = "mlpal/hop-v1";

/** Where a profile was discovered — trust derives from this, never from the file. */
export type ProfileSource = "builtin" | "user" | "project" | "path";

/**
 * Loop policy consumed directly by AgentSession: the domain heuristics that were
 * hardcoded in the loop before profiles existed. `verifyCommandRe: null` means the
 * domain has no command-verification vocabulary (self-check's "did a check run?"
 * signal is then never observed).
 */
export interface LoopPolicy {
  /** Telemetry dimension stamped on postFeedback outcomes (was hardcoded "coding"). */
  taskType: string;
  /** Commands that count as the agent having verified its work. */
  verifyCommandRe: RegExp | null;
  /** Output signatures meaning a check couldn't actually run (doesn't count as verification). */
  envBrokenRe: RegExp | null;
  /** Edits to one file before the anti-churn breaker fires. */
  churnThreshold: number;
  selfCheckNudge: (editsMade: number, verifyHint?: string) => string;
  antiChurnNudge: (path: string, edits: number) => string;
  /** System prompt for the compaction summarizer side-call. */
  summarizerSystem: string;
  /** System prompt for the large-tool-output condenser side-call. */
  condenserSystem: string;
  /** System prompt for the difficulty classifier side-call (`top` = highest rung). */
  classifierSystem: (top: number) => string;
}

/** Verification policy — one surface for what used to be four separate mechanisms. */
export interface VerificationPolicy {
  /** Named source for VERIFY_CMD_RE/ENV_BROKEN_RE + project check detection.
   *  "builtin:coding" | "builtin:none". */
  observe: string;
  selfCheck: { enabled: boolean; minEdits: number };
  antiChurn: { enabled: boolean; threshold: number };
  /** Adversarial agent verifier (Stop gate). */
  agent: {
    enabled: boolean;
    /** Tier for the verifier model (resolved via tierModelOrNearest). */
    tier: Tier;
    /** Skip verification below this many changed lines (git diff --numstat); the `changed-lines` gate. */
    riskGateMinChangedLines: number;
    /** v1.1 — which risk gate skips the verifier. `changed-lines` (default): the git-diff threshold
     *  above, meaningful for a coding deliverable. `actions`: skip when the finishing turn made no
     *  write-capable or infra-tagged tool call (a read-only or conversational turn has nothing to
     *  verify); a turn that acted is always verified, so fail-closed semantics hold where they matter. */
    riskGate: "changed-lines" | "actions";
    /** open: PARTIAL/unparseable/error allows completion (default; prevents runaway
     *  loops). closed: anything but an explicit PASS blocks — for regulated domains. */
    failMode: "open" | "closed";
  };
}

/** One eval suite: how this profile's quality is scored. Referenced, immutable-by-digest
 *  once published; v1 runs suites locally via `yodex profile eval`. */
export interface EvalSuite {
  name: string;
  description?: string;
  /** Working directory (relative to the profile dir) holding task dirs. */
  tasks: string;
  /** Shell command run per task dir; exit 0 = pass. */
  scorer: string;
  /** Runs per task (flake detection). */
  runs: number;
  /** Fraction of task-runs that must pass. */
  passBar: number;
  /**
   * Optimizer role (HOP tuning). golden = mandatory-pass, frozen correctness invariant that may
   * never regress; frontier = the scored metric being tuned (its scorer computes the number);
   * probe = cheap deterministic smoke that kills broken candidates first. Unset = an
   * informational suite that neither gates promotion nor is the tuning target.
   */
  role?: EvalRole;
  /**
   * Whether this suite may GATE promotion (block it). The deterministic-gates-only rule: an
   * LLM-judged suite MUST set gates:false (advisory, informs but never gates). Defaults by role
   * at load — golden/probe gate, frontier and role-less suites do not.
   */
  gates?: boolean;
}

export type EvalRole = "golden" | "frontier" | "probe";

/** How and when a HOP is tuned (the optimizer's control plane). Complements `tunable` (what the
 *  tuner may move) and `locked` (what it may never): tuning declares the cadence and the
 *  promotion gate. Cadence is derived by the author from telemetry volume, environment drift,
 *  blast radius, and eval cost — high-traffic read-only HOPs tune daily and auto-promote on green
 *  evals; payment/infra HOPs tune slowly, canary long, and keep humans on promote. */
export interface TuningPolicy {
  /** Scheduled cadence (the clock); `per-<N>-runs` is the parametric floor for low-traffic HOPs.
   *  Event conditions live in `triggers`, never here — `on-incident` is a trigger, not a cadence. */
  cadence: "daily" | "weekly" | "monthly" | `per-${number}-runs`;
  /** Backstop: a review cycle fires when this much time has passed since the last promotion,
   *  regardless of cadence/minRunsSinceLast (`4w`, `14d`). Optional; exempt from all-or-nothing. */
  maxAge?: string;
  /** Statistical-power floor: a proposal needs at least this many new runs since the last tune. */
  minRunsSinceLast: number;
  /** Fraction of live runs the new version is rolled out to before full promotion. */
  canaryFraction: number;
  /** Minimum canary runs before promote/rollback is decided. */
  canaryMinRuns: number;
  /** auto = promote on green evals (earned per-HOP, read-only/low-blast only); human = a person
   *  merges the promotion PR. Lock `tuning.promote` in a parent to force human on all children. */
  promote: "auto" | "human";
  /** Names an eval suite with role:frontier whose scorer computes the tuned number. */
  frontierMetric: string;
  /** The preregistered win bar on the frontier metric, e.g. "-5% at p<.05". */
  promotionMargin: string;
  /** Names an eval suite with role:golden — the mandatory-pass, digest-pinned gate. */
  goldenSuite: string;
  /** v1.1 — event-driven re-tune triggers beside the scheduled cadence. A trigger fires a
   *  cycle, never a promotion (the same evidence gate still applies). */
  triggers?: TuningTrigger[];
}

export type TuningTrigger = "on-model-release" | "on-api-change" | "on-incident";

/** A tunable knob's allowed range: a numeric interval `[min, max]`, or an enum-set of allowed
 *  string values `[a, b, …]`. The enum form (v1.1) lets a categorical knob like `model.main`
 *  be tuned between tiers — a numeric range could not express that. */
export type TunableRange = [number, number] | string[];

/** True for the numeric `[min, max]` form (both elements numbers); false for the enum-set form. */
export function isNumericRange(r: TunableRange): r is [number, number] {
  return r.length === 2 && typeof r[0] === "number" && typeof r[1] === "number";
}

/** A model reference: a tier alias (`cheap|mid|frontier|max`, resolved via the catalog) or a
 *  pinned model id (`claude-opus-5`). */
export type ModelRef = string;

/** A tier definition (§8): a concrete primary model plus an ordered fallback chain consulted only
 *  on serving failure (unavailable/overloaded), never on quality. */
export interface TierDef {
  primary: ModelRef;
  fallbacks: ModelRef[];
}

/** v1.1 — the loop's model policy, so model choice is a HOP field a tuner can move (declarable
 *  `tunable` with an enum-set range), not a runtime accident. Absent => host default model. */
export interface ModelPolicy {
  /** Main loop model: a tier name defined in `tiers` (or the subscribed baseline), or a pinned id. */
  main: ModelRef;
  /** Per-role subagent model tiers; composes with routing.subagents (the strategy). A cheap
   *  subagent never authorizes or executes a mutation. */
  subagents: { readOnly?: ModelRef; verify?: ModelRef };
  /** Guidance: the loop may invoke any catalog model via the gateway on demand. Default true;
   *  the user's /model and session overrides always outrank the artifact. */
  allowInvokeAny: boolean;
  /** Inline tier definitions (name → {primary, fallbacks}) — model selection lives in the artifact,
   *  changed only by eval-gated diffs. Composes over a `subscribe` baseline (inline overrides per
   *  name). The loader records this resolved table so `hop {name, version}` implies an exact set. */
  tiers?: Record<string, TierDef>;
  /** Optional pinned gateway-profile baseline "<profile>@<version>" (pin+notify, never live). The
   *  baseline's tiers are resolved by the host at runtime (offline the loader only sees inline tiers). */
  subscribe?: string;
}

/** v1.1 — external prerequisites the host checks at preflight (not registered tools — those are
 *  `tools.include`). A HOP declares; the host detects/connects and reports gaps loudly. */
export interface RequiresPolicy {
  /** `detect` is a shell string or a `builtin:<domain>` detector; `timeoutMs` overrides the
   *  host's per-command preflight timeout. */
  binaries: { name: string; detect: string; setup?: string; timeoutMs?: number }[];
  mcp: { name: string }[];
}

/** v1.1 — the apply-safety envelope. LOCKED whenever present (§10). Configures policy inputs;
 *  the host-owned catastrophic denials stay host-owned and cannot be widened by it. */
export interface SafetyPolicy {
  /** Per-action class; the harness carries these as capability tags so the gate keys off the
   *  action class, not a tool name. */
  toolClasses: { readOnly: string[]; mutative: string[]; destructive: string[] };
  /** An apply is admitted only if it matches a reviewed plan artifact whose hash covers these
   *  components; enforcing this is stateful (consults the run's own dry-run record). */
  preApply: { requirePlanArtifact: boolean; hash: string[] };
  /** Hard ceiling on how much a single apply may touch. */
  blastRadius: {
    maxResources?: number;
    accounts?: string[];
    regions?: string[];
    requireTag?: string;
  };
  /** The edge: which classes stop and ask (resolving to a structured needs_approval in headless). */
  approval: {
    destructive: "always" | "never";
    outOfScope: "always" | "never";
    costCeilingUsdMonth?: number;
  };
  /** Distinct read/write identities; the loop never self-grants the writer role. */
  identities: { read?: string; write?: string; neverSelfGrant: boolean };
}

/** The composed, validated profile — what the loader hands the host. */
export interface Profile {
  spec: typeof PROFILE_SPEC_ID;
  name: string;
  version: string;
  description: string;
  source: ProfileSource;
  /** Absolute dir for path/user/project profiles; null for builtins. */
  dir: string | null;
  /** Parent chain (root first), for provenance display. */
  extendsChain: string[];

  prompts: {
    /** Base identity/system prompt (the operating contract). */
    system: string;
    /** System prompt for the adversarial verification sub-agent. */
    verifierAgent: string;
    /** User-turn framing handed to the verifier. Receives the original task text and the
     *  run's DELIVERABLE — the final assistant report. Profiles whose deliverable is the
     *  workspace (coding: the diff is on disk) may ignore it; profiles whose deliverable
     *  is the text itself (reviewer) MUST embed it, or the verifier audits a filesystem
     *  that cannot contain what it is checking. (Found by our own H2 experiment: the
     *  fail-closed gate refused every delivery with "no review exists on disk".) */
    verifierTask: (task: string, deliverable?: string) => string;
  };
  loop: LoopPolicy;
  verification: VerificationPolicy;
  catalog: {
    /** Catalog curation profile: GET /v1/catalog?profile=<this>. */
    profile: string;
  };
  routing: {
    /** Sub-agent routing: "catalog" | "budget:<strategy>" | "inherit". */
    subagents: "catalog" | "inherit" | `budget:${string}`;
    classifyStart: boolean;
    escalation: { ladder: "catalog" | "off"; patience: number };
  };
  permissions: {
    /** Applied only when the user has not set a mode themselves. */
    defaultMode: "recon" | "manual" | "cruise" | "autopilot";
    allow: string[];
    deny: string[];
  };
  tools: {
    /** Allowlist over builtin + host registries. Empty = all registered tools. */
    include: string[];
  };
  budgets: {
    maxTurns: number;
  };
  telemetry: {
    taskType: string;
  };
  evals: EvalSuite[];
  /** How and when this HOP is tuned + the promotion gate. Absent = an un-tuned HOP (valid). */
  tuning?: TuningPolicy;
  /** v1.1 — the loop's model policy. Absent => host default model. */
  model?: ModelPolicy;
  /** v1.1 — external prerequisites checked at preflight. Absent => none. */
  requires?: RequiresPolicy;
  /** v1.1 — the apply-safety envelope. Absent => no envelope (permissions still apply).
   *  Auto-locked when present (see load). */
  safety?: SafetyPolicy;
  /** v1.1 — working-memory identity. `workspace` names the notes workspace the HOP reads (the
   *  host's default is the working directory's basename; project settings may override). */
  memory?: { workspace?: string };

  /** Setting paths (dot notation) overrides and the tuner may NOT touch. */
  locked: string[];
  /** The declared optimization surface: paths the tuner may move, with bounds (numeric or enum). */
  tunable: { path: string; range: TunableRange }[];
  /** Non-fatal load-time notices the host should surface (e.g. an unpinned model set, or a
   *  fallback of unknown tier). Errors throw; these inform. Absent => none. */
  warnings?: string[];
}
