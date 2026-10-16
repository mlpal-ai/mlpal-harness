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
    message: Message;
    usage: Usage;
    stopReason: StopReason | null;
    model: string;
    /** Reasoning effort the gateway ran this call at ("requested->applied"; applied may be
     *  "unsupported" for a model with no lever). Present only when the run set an effort. */
    effort?: {
        requested: string;
        applied: string;
    };
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
    /** On `error`: a human-readable cause when the loop knows one (a hook rejected the prompt). */
    reason?: string;
    numTurns: number;
    usage: Usage;
    ts: string;
    /** Present on subtype `needs_approval`: the pending action + its safety reason code, for the
     *  host's hop-run-result-v1 artifact. */
    pendingApproval?: {
        command: string;
        reason: string;
    };
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
/** A rewind boundary: replay drops every entry after `toUuid` (null = everything) that was
 *  persisted before this record, so a session continues from an earlier turn while the store
 *  keeps the full history. Written by the host's /rewind together with the file restore. */
export interface RewindEvent {
    type: "rewind";
    toUuid: string | null;
    /** The checkpoint turn number rewound to (1-based), for display. */
    turn: number;
    ts: string;
}
export interface CompactEvent {
    type: "compact";
    summary: string;
    trigger: "auto" | "manual";
    /** Messages the summary stands in for, at compaction time (for reporting only). */
    replacedMessages: number;
    ts: string;
}
/** Persisted + rendered. */
export type SDKMessage = SystemInitEvent | UserEvent | AssistantEvent | RewindEvent | ToolResultEvent | ResultEvent | ErrorEvent | CompactEvent;
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
/** Runtime category: should this event be written to the conversation store?
 *  Note: `result` is a turn summary (an SDKMessage) that is NOT persisted. */
export declare function isPersisted(e: EngineEvent): boolean;
/** A node in the conversation DAG (parentUuid chain). */
export interface ConversationEntry {
    uuid: string;
    parentUuid: string | null;
    ts: string;
    payload: SDKMessage;
}
