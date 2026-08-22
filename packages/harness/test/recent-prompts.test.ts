import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentAuthor, HUMAN } from "@mlpal/harness-protocol";
import { recentPrompts } from "../src/store/sessions";
import { LocalStore } from "../src/store/local";

let root: string;
let store: LocalStore;

beforeEach(() => {
  root = join(tmpdir(), `yodex-rp-${crypto.randomUUID()}`);
  store = new LocalStore(root);
});
afterEach(async () => await rm(root, { recursive: true, force: true }));

async function session(id: string, cwd: string, updatedAt: string): Promise<void> {
  await store.registry.putSession({
    sessionId: id,
    agentId: "cli",
    workspace: "w",
    cwd,
    status: "idle",
    head: null,
    model: "m",
    createdAt: updatedAt,
    updatedAt,
  });
}
async function userTurn(sid: string, text: string, ts: string, author = HUMAN): Promise<string | null> {
  const head = await store.conversation.head(sid);
  const e = await store.conversation.append(
    sid,
    { type: "user", message: { role: "user", content: text }, author, ts },
    head,
  );
  return e.uuid;
}

describe("recentPrompts (store-derived Up-arrow history)", () => {
  test("returns this cwd's human prompts, oldest→newest", async () => {
    await session("s1", "/proj", "2026-01-01T00:00:00Z");
    await userTurn("s1", "first prompt", "2026-01-01T00:00:01Z");
    await userTurn("s1", "second prompt", "2026-01-01T00:00:02Z");
    expect(await recentPrompts(store, { cwd: "/proj" })).toEqual(["first prompt", "second prompt"]);
  });

  test("scopes by cwd", async () => {
    await session("a", "/proj-a", "2026-01-01T00:00:00Z");
    await userTurn("a", "in-a", "2026-01-01T00:00:01Z");
    await session("b", "/proj-b", "2026-01-01T00:00:00Z");
    await userTurn("b", "in-b", "2026-01-01T00:00:01Z");
    expect(await recentPrompts(store, { cwd: "/proj-a" })).toEqual(["in-a"]);
  });

  test("merges across sessions in timestamp order and dedups consecutive repeats", async () => {
    await session("s1", "/p", "2026-01-01T00:00:00Z");
    await session("s2", "/p", "2026-01-02T00:00:00Z");
    await userTurn("s1", "alpha", "2026-01-01T00:00:01Z");
    await userTurn("s2", "alpha", "2026-01-02T00:00:01Z"); // dup across sessions → collapsed
    await userTurn("s2", "beta", "2026-01-02T00:00:02Z");
    expect(await recentPrompts(store, { cwd: "/p" })).toEqual(["alpha", "beta"]);
  });

  test("fully dedups non-consecutive repeats, keeping the most-recent position", async () => {
    await session("s1", "/p", "2026-01-01T00:00:00Z");
    await userTurn("s1", "hi", "2026-01-01T00:00:01Z");
    await userTurn("s1", "fix the bug", "2026-01-01T00:00:02Z");
    await userTurn("s1", "hi", "2026-01-01T00:00:03Z"); // "hi" again, not adjacent
    // "hi" appears once, at its newest position → Up gives ["fix the bug", "hi"]
    expect(await recentPrompts(store, { cwd: "/p" })).toEqual(["fix the bug", "hi"]);
  });

  test("caps to the most-recent `limit` distinct prompts", async () => {
    await session("s1", "/p", "2026-01-01T00:00:00Z");
    // Fixed-width, lexically-sortable timestamps (real seconds would overflow past 59).
    for (let i = 0; i < 150; i++) await userTurn("s1", `p${i}`, `t${String(i).padStart(4, "0")}`);
    const out = await recentPrompts(store, { cwd: "/p", limit: 100 });
    expect(out.length).toBe(100);
    expect(out[out.length - 1]).toBe("p149"); // newest kept
    expect(out[0]).toBe("p50"); // oldest 50 dropped by the cap
  });

  test("excludes peer-agent and system-injected turns — only what the human typed", async () => {
    await session("s1", "/p", "2026-01-01T00:00:00Z");
    await userTurn("s1", "human line", "2026-01-01T00:00:01Z", HUMAN);
    await userTurn("s1", "peer injected", "2026-01-01T00:00:02Z", agentAuthor("peer", "Peer"));
    expect(await recentPrompts(store, { cwd: "/p" })).toEqual(["human line"]);
  });

  test("bounds work by the session cap", async () => {
    for (let i = 0; i < 30; i++) {
      await session(`s${i}`, "/p", `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`);
      await userTurn(`s${i}`, `p${i}`, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:01Z`);
    }
    const out = await recentPrompts(store, { cwd: "/p", sessions: 5 });
    expect(out).toEqual(["p25", "p26", "p27", "p28", "p29"]);
  });
});
