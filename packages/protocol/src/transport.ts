import type { EngineEvent, SDKMessage } from "./sdk";

/**
 * The wire protocol between a yodex frontend (web, VS Code, remote CLI) and a running
 * engine over a transport (WebSocket). Every frontend speaks this; the engine streams
 * EngineEvents and round-trips permission decisions. See docs/05 §8.
 */

export interface SessionSummary {
  sessionId: string;
  agentId: string;
  status: string;
  model: string;
  updatedAt: string;
  /** First user message, trimmed — the human-readable title for a session picker. */
  title: string;
}

export type ClientMessage =
  | { type: "run"; requestId: string; sessionId?: string; prompt: string; model?: string; mode?: string }
  | { type: "send"; sessionId: string; text: string }
  | { type: "interrupt" }
  | { type: "list_sessions"; requestId?: string }
  | { type: "list_models"; requestId?: string }
  | { type: "list_skills"; requestId?: string }
  | { type: "load_session"; requestId?: string; sessionId: string }
  | { type: "permission_response"; id: string; decision: "allow" | "deny"; reason?: string };

export type ServerMessage =
  | { type: "ready"; protocol: string }
  | { type: "event"; sessionId: string; event: EngineEvent }
  | {
      type: "permission_request";
      id: string;
      sessionId: string;
      toolName: string;
      input: Record<string, unknown>;
    }
  | { type: "sessions"; requestId?: string; sessions: SessionSummary[] }
  | { type: "session_history"; requestId?: string; sessionId: string; messages: SDKMessage[] }
  | { type: "models"; requestId?: string; models: Array<{ tag: string; displayName: string }> }
  | { type: "skills"; requestId?: string; skills: Array<{ name: string; description: string }> }
  | { type: "done"; requestId: string; sessionId: string; subtype: string }
  | { type: "error"; message: string; requestId?: string };

export const PROTOCOL_VERSION = "yodex/1";
