/**
 * HOP telemetry contract (D11.2) — the content-free run-outcome envelope the harness emits
 * for the HOP optimizer's Capture stage. The optimizer distills these into typed observations
 * (waste / budget / routing / regression facts) and evals dispose; nothing here carries free
 * text, so fleet aggregation has nothing to leak.
 *
 * This shape is the wire contract, agreed field-for-field with the memory ingest plugin
 * (mlpal-memory-graph `harness_telemetry` normalize_run_outcome). Its keys serialize verbatim,
 * so they are the ingest's snake_case names, NOT harness-internal camelCase — `buildRunOutcome`
 * is the single translation from run-loop state to the wire shape.
 *
 * D11.2 over D11.1 (a version bump, not an in-place mutation — memory version-discriminates on
 * `contract` and keeps accepting D11.1 rows under their own stamp):
 *   + failure_class   the failure-taxonomy label on non-success (null iff success). Regression-
 *                     fact distillation keys off it; D11.1 had only the 4-bucket run_result.
 *   + tier            the served tier, explicit (not encoded in the model id) — routing facts
 *                     group by it directly.
 *   ~ wall_ms         replaces wall_s; second-granularity truncated a wall-time frontier metric.
 *   ~ checks{}        replaces the two loose bools (self_check_fired / anti_churn_fired) with a
 *                     per-mechanism {ran, caught} map — waste facts ("check V fired N times,
 *                     caught 0") are their whole basis, and the observe/agent mechanisms had no
 *                     representation before.
 */

/** Terminal run status. Mirrors the loop's result subtypes and the ingest's RUN_RESULTS set. */
export type RunResult = "success" | "error" | "max_turns" | "cancelled";

/**
 * Failure-taxonomy label (failure_class_vocab@v1). Frozen SET; the v1 emitter populates only the
 * subset it can derive at the loop layer (step_budget_stall, user_cancelled, gateway_error, other)
 * and classifies everything else it cannot yet distinguish as "other" — never the nearest bucket,
 * because unclassified volume is itself a distillation signal. The remaining values are contract-
 * reserved for finer emitters (a test runner that sees a timeout, a diff check that sees an empty
 * patch), not yet emitted by the run loop.
 */
export type FailureClass =
  | "empty_patch"
  | "step_budget_stall"
  | "test_timeout"
  | "tool_error"
  | "gateway_error"
  | "verifier_reject"
  | "user_cancelled"
  | "other";

export const FAILURE_CLASS_VOCAB = "failure_class_vocab@v1";

/** Adversarial agent-verifier verdict; null when no agent verifier ran this run. */
export type VerifierVerdict = "PASS" | "FAIL" | "PARTIAL";

/** postFeedback delegation outcome, when one was reported for this run. */
export type FeedbackOutcome = "accepted" | "retried" | "escalated" | "failed";

/** Wire discriminator memory reads to route an envelope to the right contract version. */
export const TELEMETRY_CONTRACT_VERSION = "d11.2" as const;

/**
 * Per-mechanism verification signal. The seam has four mechanisms (observe = command verifier,
 * selfCheck, antiChurn, agent); "which ran, which caught" must be derivable per mechanism for the
 * waste-fact distillation, so each carries its own outcome rather than a single conflated bool.
 */
export interface ChecksBlock {
  self_check: { fired: boolean };
  anti_churn: { fired: boolean };
  /** ran: a verification command executed; passed: it ran and its output was not env-broken. */
  observe: { ran: boolean; passed: boolean };
  agent: { verdict: VerifierVerdict | null };
}

/** The content-free run-outcome payload — an explicit allowlist, nothing else crosses. */
export interface RunOutcomePayload {
  hop: { name: string; version: string };
  /** Workspace/repo identity; also the episode scope. */
  repo: string;
  model: string;
  tier?: string;
  task_type: string;
  run_result: RunResult;
  /** null iff run_result === "success"; a FAILURE_CLASS_VOCAB value otherwise. */
  failure_class: FailureClass | null;
  feedback_outcome?: FeedbackOutcome;
  checks: ChecksBlock;
  tokens: {
    input: number;
    output: number;
    cache_read_input: number;
    cache_creation_input: number;
  };
  wall_ms: number;
  turns: number;
}

/** A run-outcome telemetry event (action_type "run.completed"). Serializes verbatim to the wire. */
export interface RunOutcomeEvent {
  contract: typeof TELEMETRY_CONTRACT_VERSION;
  action_type: "run.completed";
  scope_id: string;
  occurred_at?: string;
  source_ref?: string;
  event_id?: string;
  payload: RunOutcomePayload;
}

/**
 * A tuning-ledger event (HOP version lineage / eval scores) — the OTHER half of the contract,
 * emitted by the optimizer's promote/eval steps, NOT by the run loop. Defined here so the engine
 * and the tuner share one type. Mirrors the ingest's normalize_ledger_entry allowlist.
 */
export interface TuningLedgerEntry {
  contract: typeof TELEMETRY_CONTRACT_VERSION;
  action_type: "hop.version_published" | "hop.eval_scored";
  occurred_at?: string;
  event_id?: string;
  payload: {
    hop: { name: string };
    from_version?: string;
    to_version?: string;
    diff_paths?: string[];
    eval?: {
      suite_digest: string;
      score: number;
      pass_bar: number;
      runs: number;
      eval_run_id: string;
    };
    decision?: "adopted" | "rejected";
    proposed_by?: string;
  };
}

/** Fire-and-forget sink the host wires in; MUST never throw or block the caller (like postFeedback). */
export type TelemetrySink = (event: RunOutcomeEvent) => void;

/** True for a GatewayError without importing it (avoids a contract→gateway dependency cycle). */
function isGatewayError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { name?: unknown }).name === "GatewayError"
  );
}

/**
 * Map a terminal outcome to a failure-taxonomy label. null iff success. Only the labels the loop
 * layer can honestly distinguish are returned; anything the loop cannot tell apart is "other",
 * never a guessed nearest bucket. `thrown` is the in-flight error on the run_result === "error"
 * path (a thrown GatewayError => gateway_error; anything else => other).
 */
export function classifyFailure(runResult: RunResult, thrown?: unknown): FailureClass | null {
  switch (runResult) {
    case "success":
      return null;
    case "max_turns":
      return "step_budget_stall";
    case "cancelled":
      return "user_cancelled";
    case "error":
      return isGatewayError(thrown) ? "gateway_error" : "other";
  }
}

export interface RunOutcomeInput {
  hop: { name: string; version: string };
  repo: string;
  model: string;
  tier?: string;
  taskType: string;
  runResult: RunResult;
  failureClass: FailureClass | null;
  feedbackOutcome?: FeedbackOutcome;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  wallMs: number;
  turns: number;
  checks: {
    selfCheckFired: boolean;
    antiChurnFired: boolean;
    observeRan: boolean;
    observePassed: boolean;
    agentVerdict: VerifierVerdict | null;
  };
  occurredAt?: string;
  sourceRef?: string;
  eventId?: string;
}

/** Assemble the wire event from run-loop state. The single camelCase→snake_case translation. */
export function buildRunOutcome(i: RunOutcomeInput): RunOutcomeEvent {
  return {
    contract: TELEMETRY_CONTRACT_VERSION,
    action_type: "run.completed",
    scope_id: i.repo,
    ...(i.occurredAt ? { occurred_at: i.occurredAt } : {}),
    ...(i.sourceRef ? { source_ref: i.sourceRef } : {}),
    ...(i.eventId ? { event_id: i.eventId } : {}),
    payload: {
      hop: { name: i.hop.name, version: i.hop.version },
      repo: i.repo,
      model: i.model,
      ...(i.tier ? { tier: i.tier } : {}),
      task_type: i.taskType,
      run_result: i.runResult,
      failure_class: i.failureClass,
      ...(i.feedbackOutcome ? { feedback_outcome: i.feedbackOutcome } : {}),
      checks: {
        self_check: { fired: i.checks.selfCheckFired },
        anti_churn: { fired: i.checks.antiChurnFired },
        observe: { ran: i.checks.observeRan, passed: i.checks.observePassed },
        agent: { verdict: i.checks.agentVerdict },
      },
      tokens: {
        input: i.tokens.input,
        output: i.tokens.output,
        cache_read_input: i.tokens.cacheRead,
        cache_creation_input: i.tokens.cacheCreation,
      },
      wall_ms: i.wallMs,
      turns: i.turns,
    },
  };
}
