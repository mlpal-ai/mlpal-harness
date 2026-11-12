import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HUMAN } from "@mlpal/harness-protocol";
import { LocalStore } from "../src/store/local";
import { resolveSessionRef } from "../src/store/sessions";
import { isSafeSessionId, SessionDeletedError, type SessionRecord, UnsafeSessionIdError } from "../src/store/types";
import { hostname } from "node:os";

let root: string;
let store: LocalStore;

const record = (sessionId: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
  sessionId,
  agentId: "a",
  workspace: "w",
  cwd: "/w",
  status: "idle",
  head: null,
  model: "m",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});

/** A session with every kind of file the file backend writes for it. */
async function seed(sessionId: string): Promise<void> {
  await store.registry.putSession(record(sessionId));
  await store.conversation.append(sessionId, { type: "user", message: { role: "user", content: `hi from ${sessionId}` }, author: HUMAN, ts: "t" }, null);
  await store.logs.write(sessionId, "events", { kind: "k" });
  await store.mailbox.post(sessionId, { type: "peer_message", from: { type: "agent", id: "x", displayName: "x" }, toSession: sessionId, text: "m" });
  await mkdir(join(root, "artifacts", sessionId, "checkpoints"), { recursive: true });
  await writeFile(join(root, "artifacts", sessionId, "checkpoints", "turns.jsonl"), "{}\n");
  await mkdir(join(root, "conversation", `${sessionId}.blobs`), { recursive: true });
  await writeFile(join(root, "conversation", `${sessionId}.blobs`, "ref"), "blob");
  await store.flush();
}

/** Every file under the root that names `sessionId`, relative to the root. */
async function filesOf(sessionId: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (!existsSync(dir)) return;
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), r);
      else if (r.includes(sessionId) && !r.startsWith("registry/deleted/")) out.push(r);
    }
  };
  await walk(root, "");
  return out.sort();
}

beforeEach(() => {
  root = join(tmpdir(), `yodex-lifecycle-${crypto.randomUUID()}`);
  store = new LocalStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("archive", () => {
  test("sets and clears archivedAt and keeps updatedAt, so the list order does not move", async () => {
    await seed("s1");
    const before = (await store.registry.getSession("s1"))!.updatedAt;
    expect(await store.lifecycle.setArchived("s1", "2026-11-12T10:00:00.000Z")).toBe(true);
    const archived = (await store.registry.getSession("s1"))!;
    expect([archived.archivedAt, archived.updatedAt]).toEqual(["2026-11-12T10:00:00.000Z", before]);
    expect(await store.lifecycle.setArchived("s1", null)).toBe(true);
    const restored = (await store.registry.getSession("s1"))!;
    expect(["archivedAt" in restored, restored.updatedAt]).toEqual([false, before]);
    // The transcript is untouched by either.
    expect(await store.conversation.read("s1")).toHaveLength(1);
  });

  test("an unknown or deleted session is not archived (false), and nothing is created", async () => {
    expect(await store.lifecycle.setArchived("nope", "2026-11-12T10:00:00.000Z")).toBe(false);
    expect(existsSync(join(root, "registry", "sessions", "nope.json"))).toBe(false);
    await seed("gone");
    await store.lifecycle.deleteSession("gone");
    expect(await store.lifecycle.setArchived("gone", "2026-11-12T10:00:00.000Z")).toBe(false);
    expect(await filesOf("gone")).toEqual([]);
  });
});

describe("delete", () => {
  test("removes the record, conversation, blobs, logs, mail and artifacts; marks the id dead", async () => {
    await seed("s1");
    expect((await filesOf("s1")).length).toBeGreaterThanOrEqual(6);
    await store.lifecycle.deleteSession("s1");
    expect(await filesOf("s1")).toEqual([]);
    expect(await store.registry.getSession("s1")).toBeNull();
    expect((await store.registry.listSessions()).map((r) => r.sessionId)).toEqual([]);
    expect([...(await store.lifecycle.deletedIds())]).toEqual(["s1"]);
    expect(await resolveSessionRef(store, "s1")).toBeUndefined();
  });

  test("touches no other session, not even one whose id starts with the deleted one's", async () => {
    await seed("abc");
    await seed("abc-2");
    await seed("abcd");
    const keep = [...(await filesOf("abc-2")), ...(await filesOf("abcd"))];
    await store.lifecycle.deleteSession("abc");
    expect((await store.registry.listSessions()).map((r) => r.sessionId).sort()).toEqual(["abc-2", "abcd"]);
    expect([...(await filesOf("abc-2")), ...(await filesOf("abcd"))]).toEqual(keep);
    expect(await store.conversation.read("abcd")).toHaveLength(1);
  });

  test("is idempotent", async () => {
    await seed("s1");
    await store.lifecycle.deleteSession("s1");
    await store.lifecycle.deleteSession("s1");
    expect(await filesOf("s1")).toEqual([]);
  });

  test("a buffered append is written before the files go, so none recreates the transcript", async () => {
    const slow = new LocalStore(join(root, "slow"), { flushMs: 60_000 });
    await slow.registry.putSession(record("s1"));
    await slow.conversation.append("s1", { type: "user", message: { role: "user", content: "late" }, author: HUMAN, ts: "t" }, null);
    await slow.lifecycle.deleteSession("s1");
    await slow.flush();
    expect(existsSync(join(root, "slow", "conversation", "s1.jsonl"))).toBe(false);
  });

  test("ids with path characters are refused before any file is touched", async () => {
    await seed("victim");
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "keep.jsonl"), "x");
    for (const bad of ["../outside/keep", "..", ".", "", "a/b", "a\\b", "s1.jsonl", "x".repeat(129), "a\0b"]) {
      expect(isSafeSessionId(bad)).toBe(false);
      await expect(store.lifecycle.deleteSession(bad)).rejects.toBeInstanceOf(UnsafeSessionIdError);
      await expect(store.lifecycle.setArchived(bad, "t")).rejects.toBeInstanceOf(UnsafeSessionIdError);
    }
    expect(existsSync(join(root, "outside", "keep.jsonl"))).toBe(true);
    expect((await filesOf("victim")).length).toBeGreaterThan(0);
    expect(existsSync(join(root, "registry", "deleted"))).toBe(false);
  });
});

describe("a deleted session cannot be resurrected", () => {
  test("files a restore brings back are hidden from every listing, and swept", async () => {
    await seed("s1");
    await seed("s2");
    await store.lifecycle.deleteSession("s1");
    // A sync restores an older copy of s1's files (the marker survives: it is a file of its own).
    await writeFile(join(root, "registry", "sessions", "s1.json"), JSON.stringify(record("s1")));
    await writeFile(join(root, "conversation", "s1.jsonl"), "");
    const fresh = new LocalStore(root);
    expect((await fresh.registry.listSessions()).map((r) => r.sessionId)).toEqual(["s2"]);
    expect(await fresh.registry.getSession("s1")).toBeNull();
    expect(await fresh.lifecycle.sweepDeleted()).toEqual(["s1"]);
    expect(await filesOf("s1")).toEqual([]);
    expect(await fresh.lifecycle.sweepDeleted()).toEqual([]);
    expect(await store.conversation.read("s2")).toHaveLength(1);
  });

  test("a status patch after the delete is refused and does not recreate the record", async () => {
    await seed("s1");
    await store.lifecycle.deleteSession("s1");
    await expect(store.registry.patchSession("s1", { status: "idle" })).rejects.toBeInstanceOf(SessionDeletedError);
    expect(existsSync(join(root, "registry", "sessions", "s1.json"))).toBe(false);
  });

  test("sweep with nothing deleted reads nothing and returns nothing", async () => {
    await seed("s1");
    expect(await store.lifecycle.sweepDeleted()).toEqual([]);
    expect((await filesOf("s1")).length).toBeGreaterThan(0);
  });
});

describe("a dead id takes no writes (any process)", () => {
  test("record, patch, conversation, mail and logs are refused, typed, and nothing is created", async () => {
    await seed("s1");
    await store.lifecycle.deleteSession("s1");
    // Another process: a fresh store on the same root, which never saw the delete.
    for (const s of [store, new LocalStore(root)]) {
      expect(s.lifecycle.isDeleted("s1")).toBe(true);
      await expect(s.registry.putSession(record("s1"))).rejects.toBeInstanceOf(SessionDeletedError);
      await expect(s.registry.patchSession("s1", { status: "active" })).rejects.toBeInstanceOf(SessionDeletedError);
      await expect(s.conversation.append("s1", { type: "user", message: { role: "user", content: "back?" }, author: HUMAN, ts: "t" }, null)).rejects.toBeInstanceOf(SessionDeletedError);
      await expect(s.mailbox.post("s1", { type: "peer_message", from: { type: "agent", id: "x", displayName: "x" }, toSession: "s1", text: "m" })).rejects.toBeInstanceOf(SessionDeletedError);
      await expect(s.logs.write("s1", "events", { kind: "k" })).rejects.toBeInstanceOf(SessionDeletedError);
      await s.flush();
    }
    expect(await filesOf("s1")).toEqual([]);
    expect(store.lifecycle.isDeleted("s2")).toBe(false);
  });

  test("a live session's writes go on until it is deleted", async () => {
    await seed("s1");
    await store.registry.patchSession("s1", { status: "active" });
    expect((await store.registry.getSession("s1"))?.status).toBe("active");
  });
});

describe("a dotted id is never taken for another session's", () => {
  test("deleting abc leaves abc.x's files", async () => {
    await seed("abc");
    // Made before ids were checked: the file backend wrote whatever a client named.
    for (const f of ["conversation/abc.x.jsonl", "registry/sessions/abc.x.json", "mailbox/abc.x.jsonl", "logs/abc.x.events.jsonl"]) {
      await mkdir(join(root, f, ".."), { recursive: true });
      await writeFile(join(root, f), "{}\n");
    }
    await store.lifecycle.deleteSession("abc");
    for (const f of ["conversation/abc.x.jsonl", "registry/sessions/abc.x.json", "mailbox/abc.x.jsonl", "logs/abc.x.events.jsonl"]) expect(existsSync(join(root, f))).toBe(true);
    expect(existsSync(join(root, "conversation", "abc.jsonl"))).toBe(false);
  });
});

describe("live locks", () => {
  test("a hold is seen by every store on the root; nested holds count; the last release frees it", async () => {
    const other = new LocalStore(root);
    const a = store.lifecycle.holdLive("s1");
    const b = store.lifecycle.holdLive("s1");
    expect([other.lifecycle.isLive("s1"), other.lifecycle.isLive("s2")]).toEqual([true, false]);
    a();
    a();
    expect(other.lifecycle.isLive("s1")).toBe(true);
    b();
    expect(other.lifecycle.isLive("s1")).toBe(false);
    expect(existsSync(join(root, "live", "s1"))).toBe(false);
  });

  test("a lock reads free, and is removed, when its process is gone, not ours, on another host, or a reused pid", async () => {
    const { processStart } = await import("../src/store/local");
    const lock = async (sid: string, holder: string, started: string) => {
      await mkdir(join(root, "live", sid), { recursive: true });
      await writeFile(join(root, "live", sid, holder), started);
    };
    const me = processStart(process.pid)!;
    expect(me).toBeTruthy();
    await lock("dead", `${hostname()}_2147483646`, "");
    await lock("elsewhere", `another-pod_${process.pid}`, me);
    await lock("root", `${hostname()}_1`, ""); // pid 1 is root's: EPERM, never a yodex of ours
    await lock("reused", `${hostname()}_${process.pid}`, "Mon Jan  1 00:00:00 2001");
    await lock("mine", `${hostname()}_${process.pid}`, me);
    expect(["dead", "elsewhere", "root", "reused", "mine"].map((s) => store.lifecycle.isLive(s))).toEqual([false, false, false, false, true]);
    for (const s of ["dead", "elsewhere", "root", "reused"]) expect((await readdir(join(root, "live", s))).length).toBe(0);
    expect(store.lifecycle.isLive("../x")).toBe(false);
    expect(() => store.lifecycle.holdLive("../x")).toThrow(UnsafeSessionIdError);
  });

  test("two processes hold one session each by their own file: one's release leaves the other's lock", async () => {
    await mkdir(join(root, "live", "s1"), { recursive: true });
    const { processStart } = await import("../src/store/local");
    // Another live process of ours (the test runner's parent shell stands in): its own file.
    const other = `${hostname()}_${process.ppid}`;
    await writeFile(join(root, "live", "s1", other), processStart(process.ppid) ?? "");
    const release = store.lifecycle.holdLive("s1");
    release();
    expect(new LocalStore(root).lifecycle.isLive("s1")).toBe(true);
    expect(await readdir(join(root, "live", "s1"))).toEqual([other]);
  });

  test("a lock that cannot be written is logged; the run goes on", async () => {
    const warned: string[] = [];
    const logger = { warn: (e: string) => void warned.push(e), info: () => {}, error: () => {}, debug: () => {}, child: () => logger } as never;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "live"), "a file where the directory goes");
    const s = new LocalStore(root, { logger });
    const release = s.lifecycle.holdLive("s1");
    release();
    expect(warned).toEqual(["store.live_lock.write_failed"]);
  });
});
