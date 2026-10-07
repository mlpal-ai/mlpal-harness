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
  | "SubagentStop"
  // gap refresh rows 6–7: the events people wire their own systems to
  | "PermissionRequest"
  | "Notification"
  | "PostCompact"
  | "SubagentStart"
  | "StopFailure"
  | "ConfigChange"
  | "WorktreeCreate"
  | "TeammateIdle";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "SubagentStop",
  "PermissionRequest",
  "Notification",
  "PostCompact",
  "SubagentStart",
  "StopFailure",
  "ConfigChange",
  "WorktreeCreate",
  "TeammateIdle",
];

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

/** Fires when the permission cascade would ASK the person. A hook may answer instead
 *  (`decision: allow | deny` with a reason); without an answer the ask proceeds as before. */
export interface PermissionRequestInput {
  event: "PermissionRequest";
  toolName: string;
  input: Record<string, unknown>;
  /** The cascade's reason for asking, and the §10 safety reason when the envelope raised it. */
  reason?: string;
  safetyReason?: string;
}
/** Something a person would want to hear about, from the loop's own view: a run parked on an
 *  approval or a question, the turn limit, a cancellation. Observational. */
export interface NotificationInput {
  event: "Notification";
  kind: "needs_approval" | "question_parked" | "max_turns" | "cancelled" | "error";
  message: string;
}
/** Fires after a compaction landed: how many messages the summary replaced and its size. */
export interface PostCompactInput {
  event: "PostCompact";
  trigger: "auto" | "manual";
  replaced: number;
  summaryChars: number;
}
/** Fires when a Task sub-agent starts, before its first model call. */
export interface SubagentStartInput {
  event: "SubagentStart";
  description: string;
  agentType?: string;
  background: boolean;
}
/** Fires when a Stop hook (the verifier) blocked "done" and the loop continues. */
export interface StopFailureInput {
  event: "StopFailure";
  reason: string;
  verdict?: "PASS" | "FAIL" | "PARTIAL";
  continuations: number;
}
/** Host-fired when a setting that shapes the run changes mid-session (model, effort, mode). */
export interface ConfigChangeInput {
  event: "ConfigChange";
  setting: string;
  from?: string;
  to?: string;
}
/** Host-fired when a git worktree is created for an isolated agent. */
export interface WorktreeCreateInput {
  event: "WorktreeCreate";
  path: string;
  branch: string;
}
/** Fires when a listening worker finds nothing to do and goes idle (once per idle stretch). */
export interface TeammateIdleInput {
  event: "TeammateIdle";
  idleMs: number;
}

export type HookInput =
  | PermissionRequestInput
  | NotificationInput
  | PostCompactInput
  | SubagentStartInput
  | StopFailureInput
  | ConfigChangeInput
  | WorktreeCreateInput
  | TeammateIdleInput
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
  /** PermissionRequest: answer in the person's place. */
  decision?: "allow" | "deny";
}

/** A declarative filter on the event input (the `when` of a configured hook): every named field
 *  must match. `command` and `prompt` are regular expressions over the matching input field. */
export interface HookWhen {
  toolName?: string | string[];
  command?: string;
  prompt?: string;
  isError?: boolean;
  kind?: string | string[];
  agentType?: string | string[];
}

export interface Hook {
  readonly id: string;
  readonly events: readonly HookEvent[];
  run(input: HookInput, ctx: HookContext): Promise<HookResult>;
}
