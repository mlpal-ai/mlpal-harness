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
    /** Skip verification below this many changed lines (git diff --numstat). */
    riskGateMinChangedLines: number;
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
    /** User-turn framing handed to the verifier (receives the original task text). */
    verifierTask: (task: string) => string;
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

  /** Setting paths (dot notation) overrides and the tuner may NOT touch. */
  locked: string[];
  /** The declared optimization surface: paths the tuner may move, with bounds. */
  tunable: { path: string; range: [number, number] }[];
}
