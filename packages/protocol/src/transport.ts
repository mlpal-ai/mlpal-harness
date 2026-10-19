import type { Author } from "./author.js";
import type { ContentBlock } from "./content.js";
import type { AskOutcome, AskQuestion } from "./questions.js";
import type { EngineEvent, SDKMessage } from "./sdk.js";
import type { Usage } from "./usage.js";

/**
 * The wire protocol between a yodex frontend (web, VS Code, the workspace UI, a remote CLI) and
 * a running engine over a transport (WebSocket). Every frontend speaks this; the engine streams
 * EngineEvents and round-trips permission, question and approval decisions. See docs/05 §8.
 *
 * yodex/2 is additive over yodex/1: every yodex/1 message keeps its shape, new fields are
 * optional, and `ready.capabilities` says which of the additions a server actually serves, so a
 * frontend gates on capabilities, never on the version string.
 */

export interface SessionSummary {
  sessionId: string;
  agentId: string;
  status: string;
  model: string;
  updatedAt: string;
  /** First user message, trimmed — the human-readable title for a session picker. */
  title: string;
  /** yodex/2 (capability "sessions_v2"): the person's /rename'd name. */
  name?: string;
  /** yodex/2: the HOP the session runs under (`name@version`). */
  hop?: string;
  /** yodex/2: absolute working directory, and the same relative to the server's workspace root
   *  ("." at the root). */
  cwd?: string;
  relCwd?: string;
  /** yodex/2: first segment of relCwd, or the workspace name at the root — for grouping. */
  projectName?: string;
  /** yodex/2: the last assistant reply, trimmed. */
  lastMessagePreview?: string;
  /** yodex/2: a question is parked for this session (`yodex questions` or the UI can answer). */
  pendingQuestion?: boolean;
  /** yodex/2: a run is streaming on this session right now. */
  live?: boolean;
  /** yodex/2 (capability "subagents"): this session is a sub-agent spawned by `sessionId`'s
   *  `Agent` call `toolUseId`. Listed only when `list_sessions.includeChildren` is set. */
  parent?: { sessionId: string; toolUseId: string };
}

/** What a server can do beyond yodex/1. Absent from `ready` on a yodex/1 server. */
export type ServerCapability =
  | "questions" // question_request / question_response round-trips, parked questions on load_session
  | "approval" // done.pendingApproval + approval_response resumes a run parked at the safety edge
  | "attachments" // run.blocks (image/document content blocks) alongside the prompt
  | "sessions_v2" // the optional SessionSummary fields; list_sessions covers the whole workspace
  | "hop_per_run" // run.hop may name a HOP other than the server's own
  | "commands" // list_commands
  | "files" // list_files
  | "subagents" // `subagent` events, child frames tagged `childSessionId`, stop_subagent, list_sessions.includeChildren
  | "mail"; // `mail` frames for an idle session's peer messages; `send` answers with send_result

export interface PendingApproval {
  command: string;
  reason: string;
}

export type ClientMessage =
  | {
      type: "run";
      requestId: string;
      sessionId?: string;
      prompt: string;
      model?: string;
      mode?: string;
      /** yodex/2: attachments sent with the prompt (capability "attachments"). */
      blocks?: ContentBlock[];
      /** yodex/2: the HOP for this run. Without "hop_per_run" it must be the server's own, or the
       *  server answers with an error naming its HOP. */
      hop?: string;
      /** yodex/2: working directory for this run, under the server's workspace root. */
      cwd?: string;
    }
  /** Steer a session. yodex/2 (capability "mail"): `requestId` is echoed on the send_result. */
  | { type: "send"; requestId?: string; sessionId: string; text: string }
  | { type: "interrupt" }
  /** yodex/2: sub-agent sessions are hidden unless `includeChildren` (capability "subagents"). */
  | { type: "list_sessions"; requestId?: string; includeChildren?: boolean }
  | { type: "list_models"; requestId?: string }
  | { type: "list_skills"; requestId?: string }
  | { type: "load_session"; requestId?: string; sessionId: string }
  | { type: "permission_response"; id: string; decision: "allow" | "deny"; reason?: string }
  /** yodex/2: the answer to a question_request, or to a parked question named by load_session. */
  | { type: "question_response"; id: string; outcome: AskOutcome }
  /** yodex/2: resume a session whose last run ended `needs_approval`, with the decision. */
  | { type: "approval_response"; sessionId: string; decision: "allow" | "deny"; reason?: string }
  /** yodex/2 (capability "subagents"): stop one running sub-agent; its `subagent end` event
   *  reports `cancelled`. The parent run continues. */
  | { type: "stop_subagent"; childSessionId: string };

export type ServerMessage =
  | { type: "ready"; protocol: string; capabilities?: ServerCapability[]; hop?: string; cwd?: string }
  /** `childSessionId` (capability "subagents"): `event` belongs to that sub-agent of `sessionId`
   *  and rides the parent's connection while the child runs. */
  | { type: "event"; sessionId: string; childSessionId?: string; event: EngineEvent }
  | {
      type: "permission_request";
      id: string;
      sessionId: string;
      toolName: string;
      input: Record<string, unknown>;
      /** yodex/2: why the policy asked (a mode rule, or a HOP safety reason code). */
      reason?: string;
      safetyReason?: string;
    }
  /** yodex/2: the engine asks the person structured questions mid-run. */
  | { type: "question_request"; id: string; sessionId: string; questions: AskQuestion[] }
  | { type: "sessions"; requestId?: string; sessions: SessionSummary[] }
  | {
      type: "session_history";
      requestId?: string;
      sessionId: string;
      messages: SDKMessage[];
      /** yodex/2: a question parked for this session, answerable with question_response. */
      pendingQuestion?: { id: string; questions: AskQuestion[] };
      /** yodex/2: the last run ended at the safety edge; approval_response resumes it. */
      pendingApproval?: PendingApproval;
      /** yodex/2: a run is streaming on this session on another connection. */
      live?: boolean;
    }
  | { type: "models"; requestId?: string; models: Array<{ tag: string; displayName: string }> }
  /** yodex/2 (capability "mail"): how a `send` was delivered. `sent` = a run is live on the
   *  session and folds the text in at its next boundary; `queued` = the session is idle and the
   *  text waits in its event inbox for the next run. */
  | { type: "send_result"; requestId?: string; sessionId: string; status: "sent" | "queued" }
  /** yodex/2 (capability "mail"): a peer message that reached an idle session the client is
   *  watching. The model sees it at the session's next run; a run in progress sees its mail
   *  itself, as a `user` event authored by the peer. */
  | { type: "mail"; sessionId: string; from: Author; text: string; correlationId?: string; ts: string }
  | { type: "skills"; requestId?: string; skills: Array<{ name: string; description: string }> }
  | {
      type: "done";
      requestId: string;
      sessionId: string;
      subtype: string;
      /** yodex/2: the run's usage, and the parked action when subtype is needs_approval. */
      usage?: Usage;
      pendingApproval?: PendingApproval;
    }
  | { type: "error"; message: string; requestId?: string };

export const PROTOCOL_VERSION = "yodex/2";
