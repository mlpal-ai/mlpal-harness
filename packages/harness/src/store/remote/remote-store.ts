/**
 * The `remote` backend of the engine's Store (seam P2): one session, one lease, one writer.
 * The session's P1 log is read once at open; after that every view answers from memory, which
 * holds exactly what was read plus what this engine queued (single writer: what is queued is what
 * the store will hold). Writes go through one AppendBatcher; a fatal append ends the session for
 * this engine, and every later write throws it.
 *
 * On the wire: a conversation entry is kind = `payload.type`, data = the entry; a log record is
 * kind `log`, data `{channel, record}`; a registry write is kind `record`, data = the record or
 * the patch (folded as merges, as the store folds them); anything else is the host's own kind.
 */
import { join } from "node:path";
import type { ConversationEntry, PeerMessage, SDKMessage } from "@mlpal/harness-protocol";
import type { Logger } from "../../obs/logger";
import { silentLogger } from "../../obs/logger";
import type { AgentRecord, ConversationStore, LogChannel, LogStore, Mailbox, MemoryStore, Registry, SessionRecord, Store } from "../types";
import { AppendBatcher } from "./batcher";
import type { SessionStoreClient, StoredEvent } from "./client";
import type { LeaseKeeper } from "./lease";

/** The kinds that are conversation entries when their data has a `uuid`. */
export const ENTRY_KINDS: ReadonlySet<string> = new Set(["system", "user", "assistant", "tool_result", "result", "error", "subagent", "rewind", "compact"]);

export class SessionMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly got: string,
  ) {
    super(`session_mismatch: this store serves session ${expected}, not ${got}`);
    this.name = "SessionMismatchError";
  }
}

export class MailboxUnavailableError extends Error {
  constructor() {
    super("cross-session mail is not available in remote store mode (phase 2)");
    this.name = "MailboxUnavailableError";
  }
}

export interface RemoteStoreOptions {
  client: Pick<SessionStoreClient, "readAll" | "append">;
  sid: string;
  /** Held (acquired or adopted) by the host before the first write; released by close(). */
  lease: LeaseKeeper;
  memory: MemoryStore;
  artifactsDir: string;
  batchMaxEvents?: number;
  batchMaxBytes?: number;
  now?: () => number;
  logger?: Logger;
  /** Called once when the writer stops; the host ends the session for this engine (exit 76). */
  onFatal?: (err: Error) => void;
}

export class RemoteStore implements Store {
  readonly root: string;
  readonly conversation: ConversationStore;
  readonly logs: LogStore;
  readonly memory: MemoryStore;
  readonly registry: Registry;
  readonly mailbox: Mailbox;

  private readonly sid: string;
  private readonly now: () => number;
  private readonly log: Logger;
  private batcher: AppendBatcher | null = null;
  private readonly entries: ConversationEntry[] = [];
  private readonly logRecords = new Map<LogChannel, Record<string, unknown>[]>();
  private record: SessionRecord | null = null;
  private readonly agents = new Map<string, AgentRecord>();
  private readonly stored: StoredEvent[] = [];
  private openedAtSeq = 0;

  constructor(private readonly opts: RemoteStoreOptions) {
    this.sid = opts.sid;
    this.root = opts.artifactsDir;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
    this.memory = opts.memory;

    const self = this;
    this.conversation = {
      async append(sessionId: string, payload: SDKMessage, parentUuid: string | null) {
        self.check(sessionId);
        self.writable();
        const entry: ConversationEntry = { uuid: crypto.randomUUID(), parentUuid, ts: self.iso(), payload };
        self.entries.push(entry);
        self.write(payload.type, entry);
        return entry;
      },
      async read(sessionId: string) {
        self.check(sessionId);
        return [...self.entries];
      },
      async head(sessionId: string) {
        self.check(sessionId);
        return self.entries.at(-1)?.uuid ?? null;
      },
      async tail(sessionId: string, cursor: number) {
        self.check(sessionId);
        return { entries: self.entries.slice(cursor), cursor: self.entries.length };
      },
    };
    this.logs = {
      async write(sessionId: string, channel: LogChannel, record: Record<string, unknown>) {
        self.check(sessionId);
        self.writable();
        const stamped = { ts: self.iso(), ...record };
        self.channel(channel).push(stamped);
        self.write("log", { channel, record: stamped });
      },
      async read(sessionId: string, channel: LogChannel) {
        self.check(sessionId);
        return [...self.channel(channel)];
      },
      async tail(sessionId: string, channel: LogChannel, cursor: number) {
        self.check(sessionId);
        const all = self.channel(channel);
        return { records: all.slice(cursor), cursor: all.length };
      },
    };
    this.registry = {
      async putAgent(a: AgentRecord) {
        self.agents.set(a.agentId, a);
      },
      async listAgents() {
        return [...self.agents.values()];
      },
      async putSession(s: SessionRecord) {
        self.check(s.sessionId);
        self.writable();
        self.foldRecord(s);
        self.write("record", s);
      },
      async patchSession(sessionId: string, patch: Partial<SessionRecord>) {
        self.check(sessionId);
        self.writable();
        if (!self.record) return;
        const data = { ...patch, updatedAt: self.iso() };
        self.foldRecord(data);
        self.write("record", data);
      },
      async getSession(sessionId: string) {
        self.check(sessionId);
        return self.record ? { ...self.record } : null;
      },
      async listSessions() {
        return self.record ? [{ ...self.record }] : [];
      },
    };
    this.mailbox = {
      async post(_sessionId: string, _message: PeerMessage) {
        throw new MailboxUnavailableError();
      },
      async drain(sessionId: string) {
        self.check(sessionId);
        return [];
      },
      async peek(sessionId: string) {
        self.check(sessionId);
        return [];
      },
    };
  }

  /** Reads the session's whole log into memory and starts the writer after its last seq. */
  async open(): Promise<void> {
    const { events, lastSeq } = await this.opts.client.readAll(this.sid);
    for (const e of events) this.fold(e);
    this.stored.push(...events);
    this.openedAtSeq = lastSeq;
    this.batcher = new AppendBatcher({
      client: this.opts.client,
      sid: this.sid,
      leaseId: () => this.opts.lease.leaseId,
      afterSeq: lastSeq,
      batchMaxEvents: this.opts.batchMaxEvents,
      batchMaxBytes: this.opts.batchMaxBytes,
      now: this.now,
      onAck: (acked) => this.stored.push(...acked),
      onFatal: (err) => {
        this.log.error("session store writer stopped; the session ends for this engine", { sid: this.sid, error: err.message });
        this.opts.onFatal?.(err);
      },
    });
  }

  /** Every event read at open and acknowledged since, in seq order. */
  events(): readonly StoredEvent[] {
    return this.stored;
  }

  /** The last seq the store holds for this session, as far as this engine knows. */
  get lastSeq(): number {
    return this.batcher?.lastSeq ?? this.openedAtSeq;
  }

  /** Appends one host event (`tool_started`, `question_parked`, …); resolves to its seq once stored. */
  appendEvent(kind: string, data: unknown): Promise<number> {
    return this.writer().append(kind, data);
  }

  artifactPath(sessionId: string, name: string): string {
    this.check(sessionId);
    return join(this.opts.artifactsDir, sessionId, name);
  }

  async flush(): Promise<void> {
    await this.batcher?.flush();
  }

  /** Flushes, then gives the lease back; a failed release is logged (the lease lapses on its own). */
  async close(): Promise<void> {
    try {
      await this.flush();
    } finally {
      await this.opts.lease.release().catch((e) => this.log.warn("session store lease release failed", { sid: this.sid, error: String((e as Error)?.message ?? e) }));
    }
  }

  private fold(e: StoredEvent): void {
    const data = e.data as Record<string, unknown> | null;
    if (ENTRY_KINDS.has(e.kind) && typeof data?.uuid === "string") this.entries.push(data as unknown as ConversationEntry);
    else if (e.kind === "log" && data) this.channel(data.channel as LogChannel).push(data.record as Record<string, unknown>);
    else if (e.kind === "record" && data) this.foldRecord(data as Partial<SessionRecord>);
  }

  private foldRecord(data: Partial<SessionRecord>): void {
    this.record = { ...this.record, ...data } as SessionRecord;
  }

  private channel(channel: LogChannel): Record<string, unknown>[] {
    let records = this.logRecords.get(channel);
    if (!records) {
      records = [];
      this.logRecords.set(channel, records);
    }
    return records;
  }

  private check(sessionId: string): void {
    if (sessionId !== this.sid) throw new SessionMismatchError(this.sid, sessionId);
  }

  private writer(): AppendBatcher {
    if (!this.batcher) throw new Error("RemoteStore.open() must complete before the first write");
    return this.batcher;
  }

  private writable(): void {
    const fatal = this.writer().fatal;
    if (fatal) throw fatal;
  }

  /** Queues without waiting: a failure stops the writer and reaches the host through onFatal. */
  private write(kind: string, data: unknown): void {
    this.writer()
      .append(kind, data)
      .catch(() => {});
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}
