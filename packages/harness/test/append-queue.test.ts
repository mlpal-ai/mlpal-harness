import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppendQueue } from "../src/store/append-queue";
import { lastLine, LocalStore } from "../src/store/local";

describe("AppendQueue (telemetry v1: the loop never waits on the disk)", () => {
  test("push returns at once; a batch lands after the flush interval; flush writes everything now", async () => {
    const writes: { file: string; text: string }[] = [];
    const q = new AppendQueue({ flushMs: 20, append: async (file, text) => void writes.push({ file, text }) });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) q.push("/a.jsonl", `{"i":${i}}`);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(writes).toHaveLength(0); // nothing written synchronously
    expect(q.size()).toBe(1000);
    await new Promise((r) => setTimeout(r, 60));
    expect(writes).toHaveLength(1); // one append for the whole batch
    expect(writes[0]!.text.split("\n").filter(Boolean)).toHaveLength(1000);
    q.push("/b.jsonl", "x");
    await q.flush();
    expect(q.size()).toBe(0);
    expect(writes.map((w) => w.file)).toEqual(["/a.jsonl", "/b.jsonl"]);
  });

  test("over the cap the oldest lines of the fullest file are dropped and a marker says so", async () => {
    const writes: string[] = [];
    const q = new AppendQueue({ flushMs: 1000, maxPending: 100, append: async (_f, text) => void writes.push(text) });
    for (let i = 0; i < 101; i++) q.push("/a.jsonl", `{"i":${i}}`);
    expect(q.dropped).toBe(50);
    await q.flush();
    const lines = writes.join("").split("\n").filter(Boolean);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "store.dropped", count: 50 });
    expect(JSON.parse(lines[1]!)).toEqual({ i: 50 }); // the newest survive
    expect(lines).toHaveLength(52);
  });

  test("a failing disk loses the batch, counts it, and never throws into the caller", async () => {
    const q = new AppendQueue({ flushMs: 1, append: async () => { throw new Error("ENOSPC"); } });
    q.push("/a.jsonl", "x");
    q.push("/a.jsonl", "y");
    await q.flush();
    expect(q.failures).toBe(2);
    expect(q.size()).toBe(0);
  });
});

describe("LocalStore reads after queued writes", () => {
  test("read and head see the queued writes; head after a restart comes from the file's tail, not a full parse", async () => {
    const root = mkdtempSync(join(tmpdir(), "yodex-store-"));
    try {
      const store = new LocalStore(root, { flushMs: 5000 });
      const big = "x".repeat(300_000); // one line larger than the tail chunk
      const a = await store.conversation.append("s1", { type: "user", message: { role: "user", content: big }, author: { kind: "human" } as never, ts: "t" }, null);
      const b = await store.conversation.append("s1", { type: "assistant", message: { role: "assistant", content: "ok" }, ts: "t" } as never, a.uuid);
      expect(await store.conversation.head("s1")).toBe(b.uuid); // cached, no disk
      expect(await store.conversation.read("s1")).toHaveLength(2); // flushed for the read
      await store.close();
      const again = new LocalStore(root);
      expect(await again.conversation.head("s1")).toBe(b.uuid);
      expect(await lastLine(join(root, "conversation", "s1.jsonl"))).toContain(b.uuid);
      expect(await lastLine(join(root, "conversation", "none.jsonl"))).toBeNull();
      await store.logs.write("s1", "events", { kind: "k" });
      expect(await store.logs.read("s1", "events")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("registry: one file per session, and a legacy sessions.json is split on first use", async () => {
    const root = mkdtempSync(join(tmpdir(), "yodex-reg-"));
    try {
      const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
      mkdirSync(join(root, "registry"), { recursive: true });
      const rec = (id: string) => ({ sessionId: id, agentId: "a", workspace: "w", cwd: "/w", status: "idle" as const, head: null, model: "m", createdAt: "t", updatedAt: "t" });
      writeFileSync(join(root, "registry", "sessions.json"), JSON.stringify({ old1: rec("old1"), old2: rec("old2") }));
      const store = new LocalStore(root);
      expect((await store.registry.listSessions()).map((s) => s.sessionId).sort()).toEqual(["old1", "old2"]);
      expect(existsSync(join(root, "registry", "sessions.json.migrated"))).toBe(true);
      await store.registry.putSession(rec("new1"));
      await store.registry.patchSession("old1", { status: "active" });
      expect((await store.registry.getSession("old1"))?.status).toBe("active");
      expect(existsSync(join(root, "registry", "sessions", "new1.json"))).toBe(true);
      expect(JSON.parse(readFileSync(join(root, "registry", "sessions", "old1.json"), "utf8")).status).toBe("active");
      // a patch to an unknown session is a no-op, never a file
      await store.registry.patchSession("ghost", { status: "active" });
      expect(existsSync(join(root, "registry", "sessions", "ghost.json"))).toBe(false);
      expect(await store.registry.listSessions()).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("attachments out of line (telemetry v1, step 1d)", () => {
  test("a large image is stored as a blob by hash; the line is small; read rebuilds the block; a missing blob reads as a note", async () => {
    const { externalizeBlobs, rehydrateBlobs, hasBlobRefs } = await import("../src/store/blobs");
    const root = mkdtempSync(join(tmpdir(), "yodex-blobs-"));
    try {
      const store = new LocalStore(root);
      const data = Buffer.alloc(300_000, 7).toString("base64");
      const small = Buffer.alloc(100, 1).toString("base64");
      const payload = { type: "user", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data } }, { type: "image", source: { type: "base64", media_type: "image/png", data: small } }] }, author: { kind: "human" }, ts: "t" } as never;
      const ext = externalizeBlobs(payload);
      expect(ext.blobs).toHaveLength(1); // the small one stays inline
      expect(hasBlobRefs(ext.payload)).toBe(true);
      expect(hasBlobRefs(payload)).toBe(false);
      await store.conversation.append("s1", payload, null);
      await store.close();
      const line = readFileSync(join(root, "conversation", "s1.jsonl"), "utf8");
      expect(line.length).toBeLessThan(2000);
      expect(line).toContain(`"ref":"${ext.blobs[0]!.ref}"`);
      const { statSync, rmSync: rmf } = await import("node:fs");
      expect(statSync(join(root, "conversation", "s1.blobs", ext.blobs[0]!.ref)).size).toBe(300_000);
      const back = (await store.conversation.read("s1"))[0]!.payload as { message: { content: { type: string; source?: { data?: string } }[] } };
      expect(back.message.content[1]!.source!.data).toBe(data); // byte-identical
      expect(back.message.content[2]!.source!.data).toBe(small);
      rmf(join(root, "conversation", "s1.blobs", ext.blobs[0]!.ref));
      const gone = (await store.conversation.read("s1"))[0]!.payload as { message: { content: { type: string; text?: string }[] } };
      expect(gone.message.content[1]!.type).toBe("text");
      expect(gone.message.content[1]!.text).toContain("attachment missing");
      expect(await rehydrateBlobs({ a: 1 }, async () => null)).toEqual({ a: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("LogStore.tail (telemetry v1, step 2)", () => {
  test("returns only new complete lines and a byte cursor; a torn last line waits", async () => {
    const root = mkdtempSync(join(tmpdir(), "yodex-tail-"));
    try {
      const store = new LocalStore(root);
      await store.logs.write("s", "events", { kind: "a" });
      await store.logs.write("s", "events", { kind: "b" });
      const t1 = await store.logs.tail!("s", "events", 0);
      expect(t1.records.map((r) => r.kind)).toEqual(["a", "b"]);
      expect(t1.cursor).toBeGreaterThan(0);
      const t2 = await store.logs.tail!("s", "events", t1.cursor);
      expect(t2.records).toEqual([]);
      expect(t2.cursor).toBe(t1.cursor);
      await store.logs.write("s", "events", { kind: "c" });
      const t3 = await store.logs.tail!("s", "events", t1.cursor);
      expect(t3.records.map((r) => r.kind)).toEqual(["c"]);
      // a torn line (crash mid-write) is not returned and the cursor does not pass it
      const { appendFileSync } = await import("node:fs");
      appendFileSync(join(root, "logs", "s.events.jsonl"), '{"kind":"d"');
      const t4 = await store.logs.tail!("s", "events", t3.cursor);
      expect(t4.records).toEqual([]);
      expect(t4.cursor).toBe(t3.cursor);
      expect((await store.logs.tail!("s", "model", 0)).records).toEqual([]); // no file yet
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ConversationStore.tail (telemetry v1, step 4)", () => {
  test("entries since a cursor, attachments left as references", async () => {
    const root = mkdtempSync(join(tmpdir(), "yodex-ctail-"));
    try {
      const store = new LocalStore(root);
      const data = Buffer.alloc(100_000, 1).toString("base64");
      const a = await store.conversation.append("s", { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data } }] }, author: { kind: "human" }, ts: "t" } as never, null);
      const t1 = await store.conversation.tail!("s", 0);
      expect(t1.entries.map((e) => e.uuid)).toEqual([a.uuid]);
      const img = (t1.entries[0]!.payload as { message: { content: { source: { type: string } }[] } }).message.content[1]!.source;
      expect(img.type).toBe("blob"); // not rebuilt: the indexer wants text only
      const b = await store.conversation.append("s", { type: "assistant", message: { role: "assistant", content: "ok" }, ts: "t" } as never, a.uuid);
      const t2 = await store.conversation.tail!("s", t1.cursor);
      expect(t2.entries.map((e) => e.uuid)).toEqual([b.uuid]);
      expect((await store.conversation.tail!("s", t2.cursor)).entries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("LocalStore with logs off (YODEX_LOG=off)", () => {
  test("records are neither written nor read; the conversation still persists", async () => {
    const root = mkdtempSync(join(tmpdir(), "yodex-logoff-"));
    try {
      const store = new LocalStore(root, { logs: "off" });
      await store.logs.write("s", "events", { kind: "run.start", run: "r" });
      await store.conversation.append("s", { type: "user", message: { role: "user", content: "hi" }, author: { kind: "human" }, ts: "t" } as never, null);
      await store.close();
      expect(await store.logs.read("s", "events")).toEqual([]);
      expect((await store.logs.tail!("s", "events", 0)).records).toEqual([]);
      const { existsSync } = await import("node:fs");
      expect(existsSync(join(root, "logs"))).toBe(false);
      expect(await store.conversation.read("s")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
