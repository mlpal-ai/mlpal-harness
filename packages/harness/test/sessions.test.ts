import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HUMAN } from "@mlpal/harness-protocol";
import { mostRecentSessionId, recentSessions } from "../src/store/sessions";
import { LocalStore } from "../src/store/local";

let root: string;
let store: LocalStore;

beforeEach(() => {
  root = join(tmpdir(), `yodex-sess-${crypto.randomUUID()}`);
  store = new LocalStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(id: string, cwd: string, updatedAt: string, firstMsg: string): Promise<void> {
  await store.registry.putSession({
    sessionId: id,
    agentId: "a",
    workspace: "w",
    cwd,
    status: "idle",
    head: null,
    model: "m",
    createdAt: updatedAt,
    updatedAt,
  });
  await store.conversation.append(
    id,
    { type: "user", message: { role: "user", content: firstMsg }, author: HUMAN, ts: updatedAt },
    null,
  );
}

describe("recentSessions", () => {
  test("filters by cwd, sorts newest-first, includes a preview", async () => {
    await seed("s1", "/proj/a", "2026-06-27T10:00:00Z", "build feature X");
    await seed("s2", "/proj/a", "2026-06-27T12:00:00Z", "fix the bug");
    await seed("s3", "/proj/b", "2026-06-27T13:00:00Z", "other project");

    const here = await recentSessions(store, { cwd: "/proj/a" });
    expect(here.map((s) => s.record.sessionId)).toEqual(["s2", "s1"]); // newest first, cwd-filtered
    expect(here[0]!.preview).toBe("fix the bug");

    const all = await recentSessions(store);
    expect(all).toHaveLength(3);
    expect(all[0]!.record.sessionId).toBe("s3"); // newest overall
  });

  test("mostRecentSessionId honors the cwd filter", async () => {
    await seed("s1", "/proj/a", "2026-06-27T10:00:00Z", "a");
    await seed("s2", "/proj/b", "2026-06-27T12:00:00Z", "b");
    expect(await mostRecentSessionId(store, "/proj/a")).toBe("s1");
    expect(await mostRecentSessionId(store)).toBe("s2");
  });
});

describe("recentSessions lastReply", () => {
  test("carries the last assistant text, trimmed, and empty when the agent never replied", async () => {
    await seed("s1", "/proj/a", "2026-06-27T10:00:00Z", "build feature X");
    const head = await store.conversation.head("s1");
    const a1 = await store.conversation.append(
      "s1",
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "  first   reply " }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn", model: "m", ts: "2026-06-27T10:01:00Z" },
      head,
    );
    await store.conversation.append(
      "s1",
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use", model: "m", ts: "2026-06-27T10:02:00Z" },
      a1.uuid,
    );
    await seed("s2", "/proj/a", "2026-06-27T11:00:00Z", "no reply yet");
    const rows = await recentSessions(store, { cwd: "/proj/a" });
    expect(rows.find((r) => r.record.sessionId === "s1")!.lastReply).toBe("first reply"); // the tool-only turn has no text
    expect(rows.find((r) => r.record.sessionId === "s2")!.lastReply).toBe("");
  });
});
