import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConversationEntry, PeerMessage, SDKMessage } from "@mlpal/harness-protocol";
import type { Logger } from "../obs/logger";
import { AppendQueue } from "./append-queue";
import { externalizeBlobs, hasBlobRefs, rehydrateBlobs } from "./blobs";
import type {
  AgentRecord,
  ConversationStore,
  LogChannel,
  LogStore,
  Mailbox,
  MemoryStore,
  Registry,
  SessionLifecycle,
  SessionRecord,
  Store,
} from "./types";
import { isSafeSessionId, SessionDeletedError, UnsafeSessionIdError } from "./types";

/** The ids marked dead (`registry/deleted/<id>`). A positive answer is cached (a marker is never removed); a negative
 *  one is read again each time, so a delete by another process is seen by the next write. */
class DeadIds {
  private readonly known = new Set<string>();
  constructor(readonly dir: string) {}

  has(sessionId: string): boolean {
    if (this.known.has(sessionId)) return true;
    if (!isSafeSessionId(sessionId) || !existsSync(join(this.dir, sessionId))) return false;
    this.known.add(sessionId);
    return true;
  }

  add(sessionId: string): void {
    this.known.add(sessionId);
  }

  /** Throws SessionDeletedError for a dead id: the one check every write of the file store makes. */
  guard(sessionId: string): void {
    if (this.has(sessionId)) throw new SessionDeletedError(sessionId);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Strictly increasing within the process: two patches issued back to back used to be serialized
 *  on one chain and so ordered by time; per-record chains run them concurrently, and "the newest
 *  same-named session wins" must still mean the one patched last. */
let lastPatchMs = 0;
function monotonicNowIso(): string {
  const ms = Math.max(Date.now(), lastPatchMs + 1);
  lastPatchMs = ms;
  return new Date(ms).toISOString();
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function appendJsonl(file: string, obj: unknown): Promise<void> {
  await ensureDir(dirname(file));
  await appendFile(file, `${JSON.stringify(obj)}\n`, "utf8");
}

async function readJsonl<T>(file: string): Promise<T[]> {
  if (!existsSync(file)) return [];
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

/** The last complete line of a file without reading the whole file: the tail is read in growing
 *  chunks until a newline precedes the final line. A conversation's head is one id at the end
 *  of a file that can be megabytes (inline attachments), and it was parsed in full at every run
 *  start. */
export async function lastLine(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  const size = (await stat(file)).size;
  if (size === 0) return null;
  const fh = await open(file, "r");
  try {
    let chunk = 64 * 1024;
    for (;;) {
      const start = Math.max(0, size - chunk);
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const text = buf.toString("utf8").replace(/\n+$/, "");
      const cut = text.lastIndexOf("\n");
      // A newline inside the chunk, or the chunk is the whole file: the last line is complete.
      if (cut >= 0 || start === 0) return (cut >= 0 ? text.slice(cut + 1) : text) || null;
      chunk *= 4;
    }
  } finally {
    await fh.close();
  }
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** Atomic write: serialize to a temp file then rename, so a concurrent reader never
 *  sees a torn JSON file (matters once multiple agents share the registry). */
async function writeJson(file: string, obj: unknown): Promise<void> {
  await ensureDir(dirname(file));
  const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
  await rename(tmp, file);
}

class LocalConversation implements ConversationStore {
  /** The last entry's id per session, so a run start never parses the file for it. */
  private readonly heads = new Map<string, string | null>();

  constructor(
    private readonly dir: string,
    private readonly queue: AppendQueue,
    private readonly dead: DeadIds,
  ) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }
  private blobFile(sessionId: string, ref: string): string {
    return join(this.dir, `${sessionId}.blobs`, ref);
  }

  async append(
    sessionId: string,
    payload: SDKMessage,
    parentUuid: string | null,
  ): Promise<ConversationEntry> {
    this.dead.guard(sessionId);
    const entry: ConversationEntry = {
      uuid: crypto.randomUUID(),
      parentUuid,
      ts: nowIso(),
      payload,
    };
    // Large attachments go beside the file as blobs; the line keeps a reference (see blobs.ts).
    const ext = externalizeBlobs(payload);
    for (const b of ext.blobs) this.queue.pushFile(this.blobFile(sessionId, b.ref), b.data);
    this.queue.push(this.file(sessionId), JSON.stringify(ext.blobs.length ? { ...entry, payload: ext.payload } : entry));
    this.heads.set(sessionId, entry.uuid);
    return entry;
  }

  async read(sessionId: string): Promise<ConversationEntry[]> {
    await this.queue.flush();
    const entries = await readJsonl<ConversationEntry>(this.file(sessionId));
    const readBlob = async (ref: string): Promise<Uint8Array | null> => {
      const f = this.blobFile(sessionId, ref);
      return existsSync(f) ? new Uint8Array(await readFile(f)) : null;
    };
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (hasBlobRefs(e.payload)) entries[i] = { ...e, payload: await rehydrateBlobs(e.payload, readBlob) };
    }
    return entries;
  }

  async tail(sessionId: string, cursor: number): Promise<{ entries: ConversationEntry[]; cursor: number }> {
    await this.queue.flush();
    const t = await tailJsonl<ConversationEntry>(this.file(sessionId), cursor, () => null);
    return { entries: t.items, cursor: t.cursor };
  }

  async head(sessionId: string): Promise<string | null> {
    const cached = this.heads.get(sessionId);
    if (cached !== undefined) return cached;
    await this.queue.flush();
    const line = await lastLine(this.file(sessionId));
    let head: string | null = null;
    if (line) {
      try {
        head = (JSON.parse(line) as ConversationEntry).uuid ?? null;
      } catch {
        head = null; // a torn final line (crash mid-write): the next append starts a new chain segment
      }
    }
    this.heads.set(sessionId, head);
    return head;
  }
}

class LocalLogs implements LogStore {
  constructor(
    private readonly dir: string,
    private readonly queue: AppendQueue,
    private readonly dead: DeadIds,
    /** `off`: nothing is written or read (YODEX_LOG=off). The conversation is unaffected. */
    private readonly mode: "on" | "off" = "on",
  ) {}

  private file(sessionId: string, channel: LogChannel): string {
    return join(this.dir, `${sessionId}.${channel}.jsonl`);
  }

  async write(
    sessionId: string,
    channel: LogChannel,
    record: Record<string, unknown>,
  ): Promise<void> {
    if (this.mode === "off") return;
    this.dead.guard(sessionId);
    this.queue.push(this.file(sessionId, channel), JSON.stringify({ ts: nowIso(), ...record }));
  }

  async read(
    sessionId: string,
    channel: LogChannel,
  ): Promise<Record<string, unknown>[]> {
    if (this.mode === "off") return [];
    await this.queue.flush();
    return readJsonl<Record<string, unknown>>(this.file(sessionId, channel));
  }

  /** The cursor is a byte offset; only complete lines are returned, so a line still being
   *  written (or torn by a crash) is left for the next call. */
  async tail(sessionId: string, channel: LogChannel, cursor: number): Promise<{ records: Record<string, unknown>[]; cursor: number }> {
    if (this.mode === "off") return { records: [], cursor };
    await this.queue.flush();
    const t = await tailJsonl<Record<string, unknown>>(this.file(sessionId, channel), cursor, (line) => ({ kind: "store.unparseable", bytes: line.length }));
    return { records: t.items, cursor: t.cursor };
  }
}

/** New complete lines of a JSON-lines file from a byte offset, parsed; a torn final line waits. */
export async function tailJsonl<T>(file: string, cursor: number, onBad: (line: string) => T | null): Promise<{ items: T[]; cursor: number }> {
  if (!existsSync(file)) return { items: [], cursor };
  const size = (await stat(file)).size;
  if (size <= cursor) return { items: [], cursor };
  const fh = await open(file, "r");
  let text: string;
  try {
    const buf = Buffer.alloc(size - cursor);
    await fh.read(buf, 0, buf.length, cursor);
    text = buf.toString("utf8");
  } finally {
    await fh.close();
  }
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return { items: [], cursor };
  const complete = text.slice(0, lastNl);
  const items: T[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line) as T);
    } catch {
      const bad = onBad(line);
      if (bad !== null) items.push(bad);
    }
  }
  return { items, cursor: cursor + Buffer.byteLength(complete, "utf8") + 1 };
}

class LocalMemory implements MemoryStore {
  constructor(private readonly dir: string) {}

  async readIndex(): Promise<string> {
    const file = join(this.dir, "MEMORY.md");
    return existsSync(file) ? readFile(file, "utf8") : "";
  }

  async writeTopic(name: string, content: string): Promise<void> {
    await ensureDir(this.dir);
    await writeFile(join(this.dir, `${name}.md`), content, "utf8");
  }

  async readTopic(name: string): Promise<string | null> {
    const file = join(this.dir, `${name}.md`);
    return existsSync(file) ? readFile(file, "utf8") : null;
  }

  async listTopics(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    const files = await readdir(this.dir);
    return files
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .map((f) => f.slice(0, -3));
  }
}

class LocalRegistry implements Registry {
  readonly dead: DeadIds;
  constructor(private readonly dir: string) {
    this.dead = new DeadIds(join(dir, "deleted"));
  }

  // Serialize read-modify-write per record: without it, concurrent async writers in one process
  // (a listen() heartbeat every 1.5s, sub-agent session patches, the main loop's status updates)
  // interleave read→read→write→write and the loser's patch vanishes. Cross-process contention
  // between separate yodex instances is still last-write-wins — the atomic rename prevents
  // corruption, not a lost patch; true multi-process needs advisory file locking, deferred.
  private readonly chains = new Map<string, Promise<unknown>>();
  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  private get agentsFile(): string {
    return join(this.dir, "agents.json");
  }
  /** One file per session. The old single map (`sessions.json`) was read, parsed and rewritten
   *  in full for every status flip of every session: 1.6 MB twice per turn on a machine with
   *  3,000 sessions. It is split into per-session files on first use and kept as `.migrated`. */
  private get sessionsDir(): string {
    return join(this.dir, "sessions");
  }
  private sessionFile(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }
  private migrated: Promise<void> | null = null;
  private migrate(): Promise<void> {
    if (!this.migrated) {
      this.migrated = (async () => {
        const legacy = join(this.dir, "sessions.json");
        if (!existsSync(legacy)) return;
        const map = await readJson<Record<string, SessionRecord>>(legacy, {});
        await ensureDir(this.sessionsDir);
        for (const rec of Object.values(map)) {
          if (!existsSync(this.sessionFile(rec.sessionId))) await writeJson(this.sessionFile(rec.sessionId), rec);
        }
        await rename(legacy, `${legacy}.migrated`);
      })();
    }
    return this.migrated;
  }

  async putAgent(a: AgentRecord): Promise<void> {
    return this.serialize("agents", async () => {
      const map = await readJson<Record<string, AgentRecord>>(this.agentsFile, {});
      map[a.agentId] = a;
      await writeJson(this.agentsFile, map);
    });
  }

  async putSession(s: SessionRecord): Promise<void> {
    this.dead.guard(s.sessionId);
    await this.migrate();
    this.listing = null;
    return this.serialize(s.sessionId, () => writeJson(this.sessionFile(s.sessionId), s));
  }

  async patchSession(sessionId: string, patch: Partial<SessionRecord>): Promise<void> {
    this.dead.guard(sessionId);
    await this.migrate();
    this.listing = null;
    return this.serialize(sessionId, async () => {
      const cur = await readJson<SessionRecord | null>(this.sessionFile(sessionId), null);
      if (!cur) return;
      await writeJson(this.sessionFile(sessionId), { ...cur, ...patch, updatedAt: monotonicNowIso() });
    });
  }

  /** A listing is thousands of small reads (about 130 ms for 3,000 sessions); callers in one
   *  command often list more than once, so the result is kept for a second and dropped on any
   *  write from this process. Another process's writes show up within the second. */
  private listing: { at: number; records: SessionRecord[] } | null = null;
  private static readonly LISTING_TTL_MS = 1000;

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    await this.migrate();
    if (this.dead.has(sessionId)) return null;
    return readJson<SessionRecord | null>(this.sessionFile(sessionId), null);
  }

  async listSessions(): Promise<SessionRecord[]> {
    await this.migrate();
    if (this.listing && Date.now() - this.listing.at < LocalRegistry.LISTING_TTL_MS) return this.listing.records;
    if (!existsSync(this.sessionsDir)) return [];
    const dead = await this.deletedIds();
    const files = (await readdir(this.sessionsDir)).filter((f) => f.endsWith(".json") && !dead.has(f.slice(0, -".json".length)));
    const out: SessionRecord[] = [];
    // Bounded parallelism: thousands of small files, never thousands of open handles.
    for (let i = 0; i < files.length; i += 256) {
      const recs = await Promise.all(
        files.slice(i, i + 256).map((f) => readJson<SessionRecord | null>(join(this.sessionsDir, f), null).catch(() => null)),
      );
      for (const r of recs) if (r) out.push(r);
    }
    this.listing = { at: Date.now(), records: out };
    return out;
  }

  async listAgents(): Promise<AgentRecord[]> {
    return Object.values(await readJson<Record<string, AgentRecord>>(this.agentsFile, {}));
  }

  /** One empty file per deleted session id, named by it: a marker, never removed, so the id stays dead whatever a
   *  sync restores (the workspace daemon reads the same directory to purge the session's synced copy). */
  get deletedDir(): string {
    return this.dead.dir;
  }

  async deletedIds(): Promise<Set<string>> {
    if (!existsSync(this.deletedDir)) return new Set();
    return new Set((await readdir(this.deletedDir)).filter(isSafeSessionId));
  }

  async markDeleted(sessionId: string): Promise<void> {
    await ensureDir(this.deletedDir);
    await writeFile(join(this.deletedDir, sessionId), "");
    this.dead.add(sessionId);
    this.listing = null;
  }

  async setArchived(sessionId: string, archivedAt: string | null): Promise<boolean> {
    await this.migrate();
    this.listing = null;
    return this.serialize(sessionId, async () => {
      const cur = await this.getSession(sessionId);
      if (!cur) return false;
      const { archivedAt: _was, ...rest } = cur;
      await writeJson(this.sessionFile(sessionId), archivedAt === null ? rest : { ...rest, archivedAt });
      return true;
    });
  }

  /** The record's file goes; the marker (markDeleted) is what keeps the id dead. */
  async removeRecord(sessionId: string): Promise<void> {
    this.listing = null;
    await this.serialize(sessionId, () => rm(this.sessionFile(sessionId), { force: true }));
  }
}

class LocalMailbox implements Mailbox {
  constructor(
    private readonly dir: string,
    private readonly dead: DeadIds,
  ) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  async post(sessionId: string, message: PeerMessage): Promise<void> {
    this.dead.guard(sessionId);
    await appendJsonl(this.file(sessionId), message);
  }

  async drain(sessionId: string): Promise<PeerMessage[]> {
    const f = this.file(sessionId);
    if (!existsSync(f)) return [];
    // Atomically claim the mailbox by renaming, so messages posted during the read
    // aren't lost (they land in a fresh file).
    const claimed = `${f}.${crypto.randomUUID().slice(0, 8)}.claim`;
    try {
      await rename(f, claimed);
    } catch {
      return [];
    }
    const msgs = await readJsonl<PeerMessage>(claimed);
    await rm(claimed).catch(() => undefined);
    return msgs;
  }

  async peek(sessionId: string): Promise<PeerMessage[]> {
    return readJsonl<PeerMessage>(this.file(sessionId));
  }
}

/**
 * Filesystem-backed store for CLI mode. The hosted backend implements the same
 * Store interface against db/storage services without touching the engine.
 */
export class LocalStore implements Store {
  readonly conversation: ConversationStore;
  readonly logs: LogStore;
  readonly memory: MemoryStore;
  readonly registry: Registry;
  readonly mailbox: Mailbox;
  readonly lifecycle: SessionLifecycle;
  private readonly sessions: LocalRegistry;
  /** The background writer behind conversation and logs: appends never wait on the disk. */
  readonly queue: AppendQueue;

  /** One writer per root per process: a second LocalStore on the same root (a reader, a test, a
   *  subagent) shares the queue, so its reads flush the same pending writes. */
  private static readonly queues = new Map<string, AppendQueue>();

  constructor(
    readonly root: string,
    opts: { logger?: Logger; flushMs?: number; logs?: "on" | "off" } = {},
  ) {
    let queue = LocalStore.queues.get(root);
    if (!queue) {
      queue = new AppendQueue({ logger: opts.logger, flushMs: opts.flushMs });
      LocalStore.queues.set(root, queue);
    }
    this.queue = queue;
    this.sessions = new LocalRegistry(join(root, "registry"));
    this.registry = this.sessions;
    const dead = this.sessions.dead;
    this.conversation = new LocalConversation(join(root, "conversation"), this.queue, dead);
    this.logs = new LocalLogs(join(root, "logs"), this.queue, dead, opts.logs ?? "on");
    this.memory = new LocalMemory(join(root, "memory"));
    this.mailbox = new LocalMailbox(join(root, "mailbox"), dead);
    const live = LiveLocks.at(join(root, "live"));
    this.lifecycle = {
      setArchived: async (sessionId, archivedAt) => this.sessions.setArchived(safe(sessionId), archivedAt),
      deleteSession: async (sessionId) => {
        safe(sessionId);
        // Buffered appends land first, so none recreates a file after it is removed.
        await this.queue.flush();
        await this.sessions.markDeleted(sessionId);
        await this.removeSessionFiles(new Set([sessionId]));
      },
      deletedIds: () => this.sessions.deletedIds(),
      isDeleted: (sessionId) => dead.has(sessionId),
      holdLive: (sessionId) => live.hold(safe(sessionId)),
      isLive: (sessionId) => isSafeSessionId(sessionId) && live.held(sessionId),
      sweepDeleted: async () => {
        const marked = await this.sessions.deletedIds();
        if (!marked.size) return [];
        await this.queue.flush();
        return [...(await this.removeSessionFiles(marked))];
      },
    };
  }

  /** Every file of these (safe) sessions, by the exact names the backend gives them (SESSION_ENTRIES): the record, the
   *  conversation and its blobs, the log channels, the mailbox and artifacts/<id>/. Returns the ids that had any. */
  private async removeSessionFiles(ids: ReadonlySet<string>): Promise<Set<string>> {
    const found = new Set<string>();
    for (const id of ids) {
      if (existsSync(join(this.root, "registry", "sessions", `${id}.json`))) found.add(id);
      await this.sessions.removeRecord(id);
    }
    for (const [sub, names] of SESSION_ENTRIES) {
      const dir = join(this.root, sub);
      if (!existsSync(dir)) continue;
      for (const name of await readdir(dir)) {
        const id = sessionOfEntry(name, names);
        if (id === undefined || !ids.has(id)) continue;
        found.add(id);
        await rm(join(dir, name), { recursive: true, force: true });
      }
    }
    return found;
  }

  artifactPath(sessionId: string, name: string): string {
    return join(this.root, "artifacts", sessionId, name);
  }

  /** Write everything pending to disk. A reader of the store's own files (read, head) flushes for
   *  itself; a reader in another process cannot, so the writer flushes before it says "done". */
  async flush(): Promise<void> {
    await this.queue.flush();
  }

  /** The host calls this on every exit path. */
  async close(): Promise<void> {
    await this.flush();
  }

  /** In the `events` log channel as `{kind, ...data}`, the shape the host's own events have there. */
  async appendEvent(sessionId: string, kind: string, data: Record<string, unknown>): Promise<void> {
    await this.logs.write(sessionId, "events", { kind, ...data });
  }

  async readEvents(sessionId: string, kind: string): Promise<Record<string, unknown>[]> {
    const records = await this.logs.read(sessionId, "events");
    return records.filter((r) => r.kind === kind).map(({ kind: _, ...data }) => data);
  }
}

function safe(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) throw new UnsafeSessionIdError(sessionId);
  return sessionId;
}

/** What the file backend keeps per session, by directory: the exact entry names, so a session whose id has a dot
 *  (`abc.x`, made before ids were checked) is never taken for session `abc`'s. */
const SESSION_ENTRIES: ReadonlyArray<readonly [string, ReadonlyArray<RegExp>]> = [
  ["conversation", [/^(.+)\.jsonl$/, /^(.+)\.blobs$/]],
  ["logs", [/^(.+)\.(?:exec|model|events)\.jsonl$/]],
  ["mailbox", [/^(.+)\.jsonl$/]],
  ["artifacts", [/^(.+)$/]],
  [join("registry", "sessions"), [/^(.+)\.json$/, /^(.+)\.json\.[0-9a-f]{8}\.tmp$/]],
];

function sessionOfEntry(name: string, patterns: ReadonlyArray<RegExp>): string | undefined {
  for (const re of patterns) {
    const id = re.exec(name)?.[1];
    if (id !== undefined && isSafeSessionId(id)) return id;
  }
  return undefined;
}

/** Live locks (`<root>/live/<id>`, holding `<host>:<pid>`): a run in any process on this host says it runs the session
 *  for as long as it does, which a record's freshness cannot (a tool call can outlast it). Not under a synced
 *  directory, and a lock whose host or pid is gone reads as free, so no restart or restore leaves a session stuck. */
class LiveLocks {
  /** One per directory per process, as the append queue: every LocalStore on a root shares the hold counts. */
  private static readonly byDir = new Map<string, LiveLocks>();
  static at(dir: string): LiveLocks {
    let locks = LiveLocks.byDir.get(dir);
    if (!locks) LiveLocks.byDir.set(dir, (locks = new LiveLocks(dir)));
    return locks;
  }

  private readonly counts = new Map<string, number>();
  private readonly me = `${hostname()}:${process.pid}`;
  private constructor(private readonly dir: string) {}

  hold(sessionId: string): () => void {
    const n = this.counts.get(sessionId) ?? 0;
    this.counts.set(sessionId, n + 1);
    if (n === 0) {
      try {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(join(this.dir, sessionId), this.me);
      } catch {
        // A lock that cannot be written leaves the record's status as the only sign of the run, as before.
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(sessionId) ?? 1) - 1;
      if (left > 0) return void this.counts.set(sessionId, left);
      this.counts.delete(sessionId);
      try {
        if (readFileSync(join(this.dir, sessionId), "utf8") === this.me) rmSync(join(this.dir, sessionId), { force: true });
      } catch {
        // already gone
      }
    };
  }

  held(sessionId: string): boolean {
    if (this.counts.has(sessionId)) return true;
    let owner: string;
    try {
      owner = readFileSync(join(this.dir, sessionId), "utf8");
    } catch {
      return false;
    }
    const cut = owner.lastIndexOf(":");
    const pid = Number(owner.slice(cut + 1));
    if (owner.slice(0, cut) !== hostname() || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
