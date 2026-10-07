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
