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
  /** The permission mode of the session's last served run, so a run that resumes it (a parked
   *  answer, an approval) keeps that mode, also after the host restarts. Absent before a run. */
  mode?: string;
  /** How the session came to exist: absent = a human started it; "routine:<name>" = a
   *  scheduler firing. `yodex -c` prefers human sessions — routine-spawned ones must not
   *  hijack "continue my conversation". */
  origin?: string;
  /** The principal that opened the session under a hosted serve (protocol 0.21 `owner`); absent =
   *  a local person's session. Written once, at creation. */
  owner?: string;
  /** OS pid of the process that owns this session, when it is a live local presence.
   *  Lets peers distinguish a genuinely live session from the ghost record a killed
   *  process leaves behind (freshness alone has a 120s blind spot). */
  pid?: number;
  /** A sub-agent: the session and the `Agent` tool_use that spawned it. Absent on a top-level
   *  session. Listings hide children unless asked. */
  parent?: { sessionId: string; toolUseId: string };
  head: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** When the person archived the session (ISO 8601): hidden from default listings, kept whole. Absent = not archived. */
  archivedAt?: string;
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
  /** Writes the record. The remote backend folds it as a merge onto the record it holds, as the
   *  session store folds `record` events; it is only ever called before a session has a record. */
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

/** What a consuming append consumes (P1 1.2): the inbox item, and how the batch opens. */
export interface InboxConsume {
  requestId: string;
  outcome: "turn" | "answer" | "rejected";
}

/** One inbox item as the head read answers it (P1 1.2). */
export interface InboxItem {
  requestId: string;
  kind: "turn" | "answer";
  /** For an answer: the ask (park) id it answers. */
  answers?: string;
  inboxSeq: number;
  message: Record<string, unknown>;
  contextSha256: string;
  acceptedAtMs: number;
  attempts: number;
}

/** A session id a backend may turn into file names: letters, digits, `_` and `-`, 1–128 of them. Anything else
 *  (a path separator, a dot, an empty id) is refused before any file is touched. */
export const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeSessionId(sessionId: string): boolean {
  return SAFE_SESSION_ID.test(sessionId);
}

/** A session id that `isSafeSessionId` refuses. */
export class UnsafeSessionIdError extends Error {
  override name = "UnsafeSessionIdError";
  constructor(sessionId: string) {
    super(`not a session id: ${JSON.stringify(sessionId.slice(0, 40))}`);
  }
}

/** A write to a deleted session (its id is marked dead): refused, nothing written, so nothing a wake, a resume or another
 *  process runs can bring the session back. */
export class SessionDeletedError extends Error {
  override name = "SessionDeletedError";
  constructor(readonly sessionId: string) {
    super(`session ${sessionId.slice(0, 8)} was deleted`);
  }
}

/**
 * Archive and delete (protocol 0.26.4, capability `session_archive`). A backend that offers it sets
 * `Store.lifecycle`; the file backend does. Every method takes a safe id only (`UnsafeSessionIdError`).
 */
export interface SessionLifecycle {
  /** Set (an ISO time) or clear (null) the record's `archivedAt`. `updatedAt` is kept, so archiving does not
   *  reorder a listing. False when there is no such session (never existed, or deleted). */
  setArchived(sessionId: string, archivedAt: string | null): Promise<boolean>;
  /** Delete the session for good: it is marked dead first (a listing and `getSession` never show it again, even if
   *  its files come back), then its record, conversation, logs, mail and artifacts are removed. Idempotent. Only the
   *  session itself: the caller deletes its sub-agents. */
  deleteSession(sessionId: string): Promise<void>;
  /** The ids marked dead, for a caller that removes its own per-session files (or a sync that must not restore them). */
  deletedIds(): Promise<ReadonlySet<string>>;
  /** This id is marked dead, by this process or any other (read from disk; a positive answer is cached). Every write
   *  the store takes for a dead id (record, conversation, mail, logs) throws `SessionDeletedError`. */
  isDeleted(sessionId: string): boolean;
  /** Hold the session's live lock while a run, resume or approval goes on; call the result to let go. Nested holds in
   *  one process count. The lock names this host and pid, so it outlives no process. */
  holdLive(sessionId: string): () => void;
  /** A process on this host holds the session's live lock and is alive: it runs the session now, however long its
   *  current step takes. */
  isLive(sessionId: string): boolean;
  /** Remove again whatever files of a dead session exist (a restore of an older copy brought them back). Returns the
   *  ids that had any. */
  sweepDeleted(): Promise<string[]>;
}

export interface Store {
  readonly root: string;
  /** Archive and delete; absent on a backend that cannot (the remote session store). */
  readonly lifecycle?: SessionLifecycle;
  readonly conversation: ConversationStore;
  readonly logs: LogStore;
  readonly memory: MemoryStore;
  readonly registry: Registry;
  readonly mailbox: Mailbox;
  artifactPath(sessionId: string, name: string): string;
  /** Write every buffered line to disk, so another process reading the files sees them. A server
   *  calls it before telling a client a turn is over. Optional: a synchronous backend has nothing to flush. */
  flush?(): Promise<void>;
  /** Flush any buffered writes; the host calls it on exit. Optional: a synchronous backend has nothing to flush. */
  close?(): Promise<void>;
  /** An event that is not a conversation entry (the loop's `tool_started` marker). It resolves once the
   *  event is durable where the backend can resume: the remote backend on the store's acknowledgement
   *  (to its seq); the file backend when it is queued, since file mode never resumes. Optional: without
   *  it the loop records no markers, and a resume treats every unfinished tool as never started. The
   *  file backend keeps markers in the events log, so `YODEX_LOG=off` turns them off in file mode. */
  appendEvent?(sessionId: string, kind: string, data: Record<string, unknown>): Promise<unknown>;
  /** The data of the session's events of `kind`, in the order they were appended. */
  readEvents?(sessionId: string, kind: string): Promise<Record<string, unknown>[]>;
  /** The session's events of any of `kinds`, each with its seq, in seq order: what binds an answer to the park the log
   *  raised most recently with its id (a decision recorded before that raise answered an earlier ask). */
  readEventsAt?(sessionId: string, kinds: readonly string[]): Promise<Array<{ seq: number; kind: string; data: Record<string, unknown> }>>;
  /** P1 1.2 (remote backend, an inbox engine): a consuming append. `events` go out as one batch of their own with
   *  `consumes`, after everything queued before them, and resolve with their seqs once acknowledged. A stop or a
   *  supersession that took the item meanwhile rejects with InboxItemNotPendingError, nothing written. */
  consume?(sessionId: string, consumes: InboxConsume, events: Array<{ kind: string; data: unknown }>): Promise<number[]>;
  /** P1 1.2: the next inbox item (or, with `answers`, the pending answer to that ask); null when there is none. */
  inboxHead?(sessionId: string, answers?: string): Promise<InboxItem | null>;
}
