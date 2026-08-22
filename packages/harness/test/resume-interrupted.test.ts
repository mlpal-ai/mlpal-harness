import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalStore } from "../src/store/local";
import { loadMessages } from "../src/loop/messages";

let root: string;
beforeEach(async () => {
  root = join(tmpdir(), `yodex-resume-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
});
afterEach(async () => rm(root, { recursive: true, force: true }));

/** Every tool_use must be answered in the next user turn or the API rejects the request. */
function assertToolUsesAnswered(messages: Awaited<ReturnType<typeof loadMessages>>): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    if (!ids.length) continue;
    const next = messages[i + 1];
    expect(next?.role).toBe("user");
    const answered = new Set(
      (Array.isArray(next!.content) ? next!.content : [])
        .filter((b) => b.type === "tool_result")
        .map((b) => (b as { tool_use_id: string }).tool_use_id),
    );
    for (const id of ids) expect(answered.has(id)).toBe(true);
  }
}

describe("resuming a session interrupted mid-tool", () => {
  test("synthesizes results for tool calls that never finished", async () => {
    const store = new LocalStore(root);
    const sid = "s1";
    let parent: string | null = null;
    const add = async (payload: Parameters<typeof store.conversation.append>[1]) => {
      parent = (await store.conversation.append(sid, payload, parent)).uuid;
    };
    await add({ type: "user", message: { role: "user", content: "analyze the repo" }, author: { type: "human" }, ts: "" });
    // The agent fired two tools, then the run was interrupted — no results were ever persisted.
    await add({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "List", input: {} },
          { type: "tool_use", id: "t2", name: "Read", input: {} },
        ],
      },
      usage: { input_tokens: 1, output_tokens: 1 },
      stopReason: "tool_use",
      model: "m",
      ts: "",
    });

    const messages = await loadMessages(store, sid);
    // Without healing this array is malformed and the next request fails before it starts.
    assertToolUsesAnswered(messages);
    const last = messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("interrupted");
  });

  test("a partially answered turn keeps its real results and fills only the gap", async () => {
    const store = new LocalStore(root);
    const sid = "s2";
    let parent: string | null = null;
    const add = async (payload: Parameters<typeof store.conversation.append>[1]) => {
      parent = (await store.conversation.append(sid, payload, parent)).uuid;
    };
    await add({ type: "user", message: { role: "user", content: "go" }, author: { type: "human" }, ts: "" });
    await add({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "Read", input: {} },
          { type: "tool_use", id: "b", name: "Read", input: {} },
        ],
      },
      usage: { input_tokens: 1, output_tokens: 1 },
      stopReason: "tool_use",
      model: "m",
      ts: "",
    });
    // Only the first tool got a result before the interruption.
    await add({ type: "tool_result", toolUseId: "a", toolName: "Read", content: "real output", isError: false, ts: "" });

    const messages = await loadMessages(store, sid);
    assertToolUsesAnswered(messages);
    const results = JSON.stringify(messages.at(-1)!.content);
    expect(results).toContain("real output"); // the genuine result survives
    expect(results).toContain("interrupted"); // the missing one is filled
  });

  test("a complete conversation is left untouched", async () => {
    const store = new LocalStore(root);
    const sid = "s3";
    let parent: string | null = null;
    const add = async (payload: Parameters<typeof store.conversation.append>[1]) => {
      parent = (await store.conversation.append(sid, payload, parent)).uuid;
    };
    await add({ type: "user", message: { role: "user", content: "go" }, author: { type: "human" }, ts: "" });
    await add({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] },
      usage: { input_tokens: 1, output_tokens: 1 },
      stopReason: "tool_use",
      model: "m",
      ts: "",
    });
    await add({ type: "tool_result", toolUseId: "x", toolName: "Read", content: "done", isError: false, ts: "" });

    const messages = await loadMessages(store, sid);
    assertToolUsesAnswered(messages);
    expect(JSON.stringify(messages)).not.toContain("interrupted");
  });
});
