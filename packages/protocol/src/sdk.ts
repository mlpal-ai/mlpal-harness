import type { Author } from "./author.js";
import type { ToolResultBlocks } from "./content.js";
import type { Message, StopReason } from "./message.js";
import type { Usage } from "./usage.js";

/**
 * The engine↔frontend seam. The agentic loop yields a stream of EngineEvents;
 * every frontend (TUI, web, VS Code) and every observing peer agent consumes the
 * same stream. Semantic events (SDKMessage) are persisted to the conversation
 * store; StreamDeltas are ephemeral (live rendering only). See docs/05 §8.
 */

/** Persisted events carry the conversation entry's uuid (yodex/2): a frontend keys a turn by it,
 *  session_history replays it, and a rewind names it. Absent on a stream from an older engine. */
export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  uuid?: string;
  sessionId: string;
  agentId: string;
  model: string;
  cwd: string;
  ts: string;
}

export interface UserEvent {
  type: "user";
  uuid?: string;
  message: Message;
  author: Author;
  ts: string;
}

export interface AssistantEvent {
  type: "assistant";
  uuid?: string;
  message: Message; // complete assistant message (text + tool_use blocks)
  usage: Usage;
  stopReason: StopReason | null;
  model: string;
  /** Reasoning effort the gateway ran this call at ("requested->applied"; applied may be
   *  "unsupported" for a model with no lever). Present only when the run set an effort. */
  effort?: { requested: string; applied: string };
  ts: string;
}

export interface ToolResultEvent {
  type: "tool_result";
  uuid?: string;
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
  /** Persisted since 0.16.0: the entry's uuid on the stream and in session_history. */
  uuid?: string;
  /** `needs_approval` (HOP §10): the run parked at the safety approval edge and stopped, waiting
   *  for a human — distinct from a user-initiated `cancelled`. */
  subtype: "success" | "error" | "max_turns" | "cancelled" | "needs_approval";
  /** On `error`: a human-readable cause when the loop knows one (a hook rejected the prompt). */
  reason?: string;
  numTurns: number;
  usage: Usage;
  ts: string;
  /** Present on subtype `needs_approval`: the pending action + its safety reason code, for the
   *  host's hop-run-result-v1 artifact. */
  pendingApproval?: { command: string; reason: string };
}

export interface ErrorEvent {
  type: "error";
  uuid?: string;
  message: string;
  ts: string;
}
/**
 * A sub-agent's lifecycle on its PARENT's stream (yodex/2, capability "subagents"). `start` and
 * `end` are persisted in the parent's conversation so a replay can find the child by
 * `childSessionId` and load its own session; `progress` is ephemeral. `toolUseId` is the parent's
 * `Agent` tool_use that spawned the child, so a frontend can nest the child under that step.
 */
export interface SubagentEvent {
  type: "subagent";
  uuid?: string;
  kind: "start" | "progress" | "end";
  toolUseId: string;
  childSessionId: string;
  /** The Agent call's 3-5 word label. */
  description: string;
  /** The model the child was routed to, once known. */
  model?: string;
  /** Detached (`run_in_background`): `end` may arrive after the parent's run, at the start of
   *  its next run or, on a server, as an idle event. */
  background: boolean;
  /** `progress`: one line of what the child is doing right now. */
  status?: string;
  /** `end`: how the child finished. */
  outcome?: "success" | "error" | "cancelled";
  ts: string;
}
/**
 * One of a child's own events, carried on the parent's stream while the child runs. Ephemeral:
 * the child persists it in its own session; the parent's transcript keeps only `subagent`.
 */
export interface SubagentStreamEvent {
  type: "subagent_event";
  childSessionId: string;
  event: EngineEvent;
}

/**
 * A persisted compaction boundary. Everything in the session up to this entry's parent
 * is replaced, on reload, by `summary` (a single synthetic user turn); entries after it
 * replay verbatim. This bounds the context a resumed/long session reloads instead of
 * replaying the whole DAG. `auto` = threshold-triggered in the loop; `manual` = /compact.
 */
/** A rewind boundary: replay drops every entry after `toUuid` (null = everything) that was
 *  persisted before this record, so a session continues from an earlier turn while the store
 *  keeps the full history. Written by the host's /rewind together with the file restore. */
export interface RewindEvent {
  type: "rewind";
  /** The entry's uuid, as on every persisted event (replayed and on the watcher frame). */
  uuid?: string;
  toUuid: string | null;
  /** The checkpoint turn number rewound to (1-based), for display. */
  turn: number;
  ts: string;
}

export interface CompactEvent {
  type: "compact";
  uuid?: string;
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
  | RewindEvent
  | ToolResultEvent
  | ResultEvent
  | ErrorEvent
  | CompactEvent
  | SubagentEvent;

export interface TextDelta {
  type: "text_delta";
  text: string;
}
export interface ThinkingDelta {
  type: "thinking_delta";
  text: string;
}
/** `id` is the tool_use id: the same value the later `tool_result.toolUseId` carries, so a
 *  frontend can time a step from this delta to its result. */
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

export type EngineEvent = SDKMessage | StreamDelta | SubagentStreamEvent;

const PERSISTED_TYPES = new Set<EngineEvent["type"]>([
  "system",
  "user",
  "assistant",
  "tool_result",
  "compact",
  "rewind",
  "subagent",
  "result",
  "error",
]);

/** Runtime category: should this event be written to the conversation store? Since protocol
 *  0.16.0 a run's `result` and a host-reported `error` are persisted too, so a replay carries
 *  run boundaries and usage; a `subagent` progress line is not. */
export function isPersisted(e: EngineEvent): boolean {
  if (e.type === "subagent") return e.kind !== "progress";
  return PERSISTED_TYPES.has(e.type);
}

/** A node in the conversation DAG (parentUuid chain). */
export interface ConversationEntry {
  uuid: string;
  parentUuid: string | null;
  ts: string;
  payload: SDKMessage;
}
