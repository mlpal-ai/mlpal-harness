import type { ConversationEntry, PeerMessage, SDKMessage } from "@mlpal/harness-protocol";

/**
 * The unified store: one root, bifurcated by concern. Conversation is the model's
 * context source (the DAG a peer agent reads); logs are operational truth (never fed
 * to the model); memory is distilled workspace-shared knowledge; registry is who
 * exists. Everything goes through these interfaces so the backend is pluggable
 * (local files for CLI, durable services for hosted). See docs/05 §5.
 */

export type LogChannel = "exec" | "model" | "events";

export interface SessionRecord {
  sessionId: string;
  agentId: string;
  /** Human-readable workspace label (e.g. the repo basename). */
  workspace: string;
  /** Absolute working directory — the precise key for filtering "this project's" sessions.
   *  Sessions live in ONE unified store (not per-directory); cwd is metadata,
   *  which also maps 1:1 onto the hosted multi-tenant DB schema. */
  cwd: string;
  /** `active` = currently in a run; `listening` = a persistent worker idle-waiting on its mailbox
   *  (still a valid live-routing target, unlike `idle`); `idle` = run finished, no listener. */
  status: "active" | "listening" | "idle" | "done" | "error";
  /** A person's name for the session (/rename): shown in listings and accepted wherever a session id is. */
  name?: string;
  /** The HOP the session runs under (`name@version`), from the host's telemetry stamp. */
  hop?: string;
  /** How the session came to exist: absent = a human started it; "routine:<name>" = a
   *  scheduler firing. `yodex -c` prefers human sessions — routine-spawned ones must not
   *  hijack "continue my conversation". */
  origin?: string;
  /** OS pid of the process that owns this session, when it is a live local presence.
   *  Lets peers distinguish a genuinely live session from the ghost record a killed
   *  process leaves behind (freshness alone has a 120s blind spot). */
  pid?: number;
  head: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRecord {
  agentId: string;
  displayName: string;
  modelProfile?: string;
  createdAt: string;
  lastSeen: string;
}

export interface ConversationStore {
  /** Append an entry to the DAG, parented to parentUuid (null for the first). */
  append(
    sessionId: string,
    payload: SDKMessage,
    parentUuid: string | null,
  ): Promise<ConversationEntry>;
  read(sessionId: string): Promise<ConversationEntry[]>;
  head(sessionId: string): Promise<string | null>;
  /** telemetry v1: entries appended since `cursor` (an opaque position, 0 to start), without
   *  rebuilding attachments (a blob stays a reference), for an indexer that reads text only. */
  tail?(sessionId: string, cursor: number): Promise<{ entries: ConversationEntry[]; cursor: number }>;
}

export interface LogStore {
  write(
    sessionId: string,
    channel: LogChannel,
    record: Record<string, unknown>,
  ): Promise<void>;
  read(sessionId: string, channel: LogChannel): Promise<Record<string, unknown>[]>;
  /** telemetry v1: the records written since `cursor` (an opaque position, 0 to start), and the
   *  position after them, so a live reader (the exporter, the dashboard) never re-reads a file.
   *  Optional: a backend without a cheap tail leaves it out and the reader does nothing. */
  tail?(sessionId: string, channel: LogChannel, cursor: number): Promise<{ records: Record<string, unknown>[]; cursor: number }>;
}

export interface MemoryStore {
  readIndex(): Promise<string>;
  writeTopic(name: string, content: string): Promise<void>;
  readTopic(name: string): Promise<string | null>;
  listTopics(): Promise<string[]>;
}

export interface Registry {
  putAgent(a: AgentRecord): Promise<void>;
  putSession(s: SessionRecord): Promise<void>;
  patchSession(sessionId: string, patch: Partial<SessionRecord>): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  listSessions(): Promise<SessionRecord[]>;
  listAgents(): Promise<AgentRecord[]>;
}

/**
 * Per-session mailbox for inter-agent collaboration: one agent posts a message
 * addressed to another's session; the recipient drains it and injects it as an
 * author-tagged turn. See docs/05 §7.
 */
export interface Mailbox {
  post(sessionId: string, message: PeerMessage): Promise<void>;
  /** Atomically claim and return all pending messages (clears the mailbox). */
  drain(sessionId: string): Promise<PeerMessage[]>;
  peek(sessionId: string): Promise<PeerMessage[]>;
}

export interface Store {
  readonly root: string;
  readonly conversation: ConversationStore;
  readonly logs: LogStore;
  readonly memory: MemoryStore;
  readonly registry: Registry;
  readonly mailbox: Mailbox;
  artifactPath(sessionId: string, name: string): string;
  /** Flush any buffered writes; the host calls it on exit. Optional: a synchronous backend has nothing to flush. */
  close?(): Promise<void>;
}
