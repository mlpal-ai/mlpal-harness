import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ConversationEntry, PeerMessage, SDKMessage } from "@mlpal/harness-protocol";
import type {
  AgentRecord,
  ConversationStore,
  LogChannel,
  LogStore,
  Mailbox,
  MemoryStore,
  Registry,
  SessionRecord,
  Store,
} from "./types";

function nowIso(): string {
  return new Date().toISOString();
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
  constructor(private readonly dir: string) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  async append(
    sessionId: string,
    payload: SDKMessage,
    parentUuid: string | null,
  ): Promise<ConversationEntry> {
    const entry: ConversationEntry = {
      uuid: crypto.randomUUID(),
      parentUuid,
      ts: nowIso(),
      payload,
    };
    await appendJsonl(this.file(sessionId), entry);
    return entry;
  }

  async read(sessionId: string): Promise<ConversationEntry[]> {
    return readJsonl<ConversationEntry>(this.file(sessionId));
  }

  async head(sessionId: string): Promise<string | null> {
    const entries = await this.read(sessionId);
    return entries.length ? entries[entries.length - 1]!.uuid : null;
  }
}

class LocalLogs implements LogStore {
  constructor(private readonly dir: string) {}

  private file(sessionId: string, channel: LogChannel): string {
    return join(this.dir, `${sessionId}.${channel}.jsonl`);
  }

  async write(
    sessionId: string,
    channel: LogChannel,
    record: Record<string, unknown>,
  ): Promise<void> {
    await appendJsonl(this.file(sessionId, channel), { ts: nowIso(), ...record });
  }

  async read(
    sessionId: string,
    channel: LogChannel,
  ): Promise<Record<string, unknown>[]> {
    return readJsonl<Record<string, unknown>>(this.file(sessionId, channel));
  }
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
  constructor(private readonly dir: string) {}

  private get agentsFile(): string {
    return join(this.dir, "agents.json");
  }
  private get sessionsFile(): string {
    return join(this.dir, "sessions.json");
  }

  async putAgent(a: AgentRecord): Promise<void> {
    const map = await readJson<Record<string, AgentRecord>>(this.agentsFile, {});
    map[a.agentId] = a;
    await writeJson(this.agentsFile, map);
  }

  async putSession(s: SessionRecord): Promise<void> {
    const map = await readJson<Record<string, SessionRecord>>(this.sessionsFile, {});
    map[s.sessionId] = s;
    await writeJson(this.sessionsFile, map);
  }

  async patchSession(sessionId: string, patch: Partial<SessionRecord>): Promise<void> {
    const map = await readJson<Record<string, SessionRecord>>(this.sessionsFile, {});
    const cur = map[sessionId];
    if (!cur) return;
    map[sessionId] = { ...cur, ...patch, updatedAt: nowIso() };
    await writeJson(this.sessionsFile, map);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const map = await readJson<Record<string, SessionRecord>>(this.sessionsFile, {});
    return map[sessionId] ?? null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return Object.values(await readJson<Record<string, SessionRecord>>(this.sessionsFile, {}));
  }

  async listAgents(): Promise<AgentRecord[]> {
    return Object.values(await readJson<Record<string, AgentRecord>>(this.agentsFile, {}));
  }
}

class LocalMailbox implements Mailbox {
  constructor(private readonly dir: string) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  async post(sessionId: string, message: PeerMessage): Promise<void> {
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

  constructor(readonly root: string) {
    this.conversation = new LocalConversation(join(root, "conversation"));
    this.logs = new LocalLogs(join(root, "logs"));
    this.memory = new LocalMemory(join(root, "memory"));
    this.registry = new LocalRegistry(join(root, "registry"));
    this.mailbox = new LocalMailbox(join(root, "mailbox"));
  }

  artifactPath(sessionId: string, name: string): string {
    return join(this.root, "artifacts", sessionId, name);
  }
}
