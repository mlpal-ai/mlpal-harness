/**
 * Lifecycle hooks — the programmable extension points around the agent loop, and the
 * substrate for the autonomy/verifier loop (a Stop hook can block "done" and force a
 * correction). Typed I/O so hooks are a real contract, not stringly-typed callbacks.
 * See docs/05 §6.
 */

export type HookEvent =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionStart"
  | "SessionEnd"
  | "PreCompact"
  | "SubagentStop";

export interface HookContext {
  sessionId: string;
  agentId: string;
  cwd: string;
  /** telemetry v1: the run (turn) in progress, when a hook fires inside one. */
  runId?: string;
}

export interface UserPromptSubmitInput {
  event: "UserPromptSubmit";
  prompt: string;
}
export interface PreToolUseInput {
  event: "PreToolUse";
  toolName: string;
  input: Record<string, unknown>;
}
export interface PostToolUseInput {
  event: "PostToolUse";
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}
export interface StopInput {
  event: "Stop";
  numTurns: number;
}
/** Fires once when a session first runs. `source` distinguishes a fresh start from a
 *  resumed one. May return `injectContext` to seed the session (e.g. project status). */
export interface SessionStartInput {
  event: "SessionStart";
  source: "startup" | "resume";
}
/** Fires when the host tears a session down (e.g. REPL exit). Observational. */
export interface SessionEndInput {
  event: "SessionEnd";
  reason: "exit" | "clear" | "error";
}
/** Fires when the loop is about to summarise older turns (over budget). Observational — the
 *  full transcript is still in the store for a hook to snapshot, and `transcript` is the
 *  verbatim window about to be replaced by the summary, rendered as text, so a host can
 *  checkpoint it to memory before it is gone (memory v13 DESIGN §3: "before compaction,
 *  always"). `window` counts compactions within the session, for an idempotent event id. */
export interface PreCompactInput {
  event: "PreCompact";
  trigger: "auto" | "manual";
  messageCount: number;
  transcript?: string;
  window?: number;
}
/** Fires after a Task subagent finishes, carrying its final result. Observational. */
export interface SubagentStopInput {
  event: "SubagentStop";
  agentType?: string;
  result: string;
}

export type HookInput =
  | UserPromptSubmitInput
  | PreToolUseInput
  | PostToolUseInput
  | StopInput
  | SessionStartInput
  | SessionEndInput
  | PreCompactInput
  | SubagentStopInput;

export interface HookResult {
  /** Deny the action (PreToolUse), reject the prompt (UserPromptSubmit), or force
   *  continuation (Stop). */
  block?: boolean;
  reason?: string;
  /** PreToolUse: replace the tool input. */
  updatedInput?: Record<string, unknown>;
  /** UserPromptSubmit: replace the prompt. */
  updatedPrompt?: string;
  /** Extra context to feed the model (e.g. PostToolUse observations). */
  injectContext?: string;
  /** Stop (agent verifier): the raw verdict, surfaced even when it does not block, so the run
   *  loop can stamp it on telemetry (checks.agent.verdict). Absent for non-verifier hooks. */
  verdict?: "PASS" | "FAIL" | "PARTIAL";
}

export interface Hook {
  readonly id: string;
  readonly events: readonly HookEvent[];
  run(input: HookInput, ctx: HookContext): Promise<HookResult>;
}
