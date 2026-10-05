import { resolveApiKey, type KeyProvider } from "../gateway/client";
import type { Logger } from "../obs/logger";
import { silentLogger } from "../obs/logger";
import { parseTopic, topicToEnvelope } from "../memory/derived";
import type { MemoryStore, Store } from "./types";

/**
 * A MemoryStore decorator that mirrors every write to the mlpal-memory-graph service
 * (topic file → POST /api/v1/episodes) via the shared topicToEnvelope mapper — the concrete
 * "sync worker" the layer was designed for. Local stays the source of truth: reads always
 * come from the wrapped store, and a sync POST is BEST-EFFORT (failures are logged, never
 * block the agent). Off by default; enabled by `memory.backend: "graph"`.
 */
export interface SyncingMemoryOptions {
  base: MemoryStore;
  endpoint: string;
  apiKey?: KeyProvider;
  logger?: Logger;
  /** Injectable for tests; defaults to fetch. Resolves to the HTTP status. */
  post?: (url: string, body: string, headers: Record<string, string>) => Promise<number>;
  /** The identity headers every other memory call sends (the Bearer plus, under dev auth, the
   *  X-Test-* tenant headers). Built per request so a rotating key is read at send time. Without
   *  it the mirror carried a Bearer alone and, on a dev-auth service, every Memorize episode
   *  landed in the fallback tenant (memory v13 experiment, F4). */
  headers?: () => Record<string, string>;
}

export class SyncingMemory implements MemoryStore {
  private readonly base: MemoryStore;
  private readonly endpoint: string;
  private readonly apiKey?: KeyProvider;
  private readonly log: Logger;
  private readonly post: NonNullable<SyncingMemoryOptions["post"]>;
  private readonly identity?: () => Record<string, string>;

  constructor(opts: SyncingMemoryOptions) {
    this.base = opts.base;
    this.endpoint = opts.endpoint.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.identity = opts.headers;
    this.log = opts.logger ?? silentLogger;
    this.post =
      opts.post ??
      (async (url, body, headers) => {
        const res = await fetch(url, { method: "POST", body, headers });
        return res.status;
      });
  }

  /** Built per request: the key may rotate under a keyring. The host's identity headers win when
   *  supplied; the bare Bearer is the fallback for a host that has no tenant headers to send. */
  private headers(): Record<string, string> {
    const identity = this.identity?.() ?? (this.apiKey ? { authorization: `Bearer ${resolveApiKey(this.apiKey)}` } : {});
    return { "content-type": "application/json", ...identity };
  }

  readIndex(): Promise<string> {
    return this.base.readIndex();
  }
  readTopic(name: string): Promise<string | null> {
    return this.base.readTopic(name);
  }
  listTopics(): Promise<string[]> {
    return this.base.listTopics();
  }

  async writeTopic(name: string, content: string): Promise<void> {
    await this.base.writeTopic(name, content); // local is source of truth — always persist
    // Best-effort mirror to the graph. Never let a sync failure surface to the agent.
    try {
      const envelope = topicToEnvelope(name, parseTopic(content));
      // The ingest endpoint takes a LIST; the bare envelope was a 422 and every Memorize mirror
      // silently failed for weeks (the test pinned the wrong shape).
      const status = await this.post(`${this.endpoint}/api/v1/episodes`, JSON.stringify({ episodes: [envelope] }), this.headers());
      if (status >= 200 && status < 300) {
        this.log.info("memory synced to graph", { topic: name, event_id: envelope.event_id });
      } else {
        // 403 on repo-scope is expected until the service opens that write path — log, don't fail.
        this.log.warn("memory-graph sync non-2xx", { topic: name, status });
      }
    } catch (e) {
      this.log.warn("memory-graph sync failed (kept local)", { topic: name, error: String(e) });
    }
  }
}

/** Compose a Store with a different MemoryStore, delegating everything else to the base. */
export function withMemory(base: Store, memory: MemoryStore): Store {
  return {
    get root() {
      return base.root;
    },
    get conversation() {
      return base.conversation;
    },
    get logs() {
      return base.logs;
    },
    get registry() {
      return base.registry;
    },
    get mailbox() {
      return base.mailbox;
    },
    memory,
    artifactPath: (sessionId, name) => base.artifactPath(sessionId, name),
  };
}
