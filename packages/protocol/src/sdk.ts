import type { Author } from "./author";
import type { ToolResultBlocks } from "./content";
import type { Message, StopReason } from "./message";
import type { Usage } from "./usage";

/**
 * The engine↔frontend seam. The agentic loop yields a stream of EngineEvents;
 * every frontend (TUI, web, VS Code) and every observing peer agent consumes the
 * same stream. Semantic events (SDKMessage) are persisted to the conversation
 * store; StreamDeltas are ephemeral (live rendering only). See docs/05 §8.
 */

export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  sessionId: string;
  agentId: string;
  model: string;
  cwd: string;
  ts: string;
}

export interface UserEvent {
  type: "user";
  message: Message;
  author: Author;
  ts: string;
}

export interface AssistantEvent {
  type: "assistant";
  message: Message; // complete assistant message (text + tool_use blocks)
  usage: Usage;
  stopReason: StopReason | null;
  model: string;
  ts: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolUseId: string;
  toolName: string;
  /** Display/summary string (always present). */
  content: string;
  /** Rich tool_result content (images/documents) sent to the model, if any. */
  blocks?: ToolResultBlocks;
  /** Unified-diff patch for edit tools (Write/Edit), for rich rendering in frontends.
   *  Render-only — never shipped into the model's context. */
  diff?: string;
  isError: boolean;
  ts: string;
}

export interface ResultEvent {
  type: "result";
  /** `needs_approval` (HOP §10): the run parked at the safety approval edge and stopped, waiting
   *  for a human — distinct from a user-initiated `cancelled`. */
  subtype: "success" | "error" | "max_turns" | "cancelled" | "needs_approval";
  numTurns: number;
  usage: Usage;
  ts: string;
  /** Present on subtype `needs_approval`: the pending action + its safety reason code, for the
   *  host's hop-run-result-v1 artifact. */
  pendingApproval?: { command: string; reason: string };
}

export interface ErrorEvent {
  type: "error";
  message: string;
  ts: string;
}

/**
 * A persisted compaction boundary. Everything in the session up to this entry's parent
 * is replaced, on reload, by `summary` (a single synthetic user turn); entries after it
 * replay verbatim. This bounds the context a resumed/long session reloads instead of
 * replaying the whole DAG. `auto` = threshold-triggered in the loop; `manual` = /compact.
 */
export interface CompactEvent {
  type: "compact";
  summary: string;
  trigger: "auto" | "manual";
  /** Messages the summary stands in for, at compaction time (for reporting only). */
  replacedMessages: number;
  ts: string;
}

/** Persisted + rendered. */
export type SDKMessage =
  | SystemInitEvent
  | UserEvent
  | AssistantEvent
  | ToolResultEvent
  | ResultEvent
  | ErrorEvent
  | CompactEvent;

export interface TextDelta {
  type: "text_delta";
  text: string;
}
export interface ThinkingDelta {
  type: "thinking_delta";
  text: string;
}
export interface ToolUseStart {
  type: "tool_use_start";
  id: string;
  name: string;
}
/**
 * The in-flight turn was interrupted by a transient connection drop (e.g. the laptop slept) and is
 * being re-streamed from scratch. Any partial text/thinking rendered for this turn is now stale and
 * must be discarded before the fresh deltas arrive. Conversation state is untouched (the turn hadn't
 * committed), so this only concerns live rendering. Emitted at most once per resume.
 */
export interface ResetDelta {
  type: "reset";
}

/** Ephemeral streaming — rendered live, never persisted. */
export type StreamDelta = TextDelta | ThinkingDelta | ToolUseStart | ResetDelta;

export type EngineEvent = SDKMessage | StreamDelta;

const PERSISTED_TYPES = new Set<EngineEvent["type"]>([
  "system",
  "user",
  "assistant",
  "tool_result",
  "compact",
]);

/** Runtime category: should this event be written to the conversation store?
 *  Note: `result` is a turn summary (an SDKMessage) that is NOT persisted. */
export function isPersisted(e: EngineEvent): boolean {
  return PERSISTED_TYPES.has(e.type);
}

/** A node in the conversation DAG (parentUuid chain). */
export interface ConversationEntry {
  uuid: string;
  parentUuid: string | null;
  ts: string;
  payload: SDKMessage;
}
