import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HUMAN } from "@mlpal/harness-protocol";
import { mostRecentSessionId, recentSessions } from "../src/store/sessions";
import { LocalStore } from "../src/store/local";

/** A text file in a turn as the hosted composer and context/attachments.ts both write it, spelled out: the wire format. */
const attached = (name: string, body: string) => ({ type: "text", text: `<attached-document name="${name}">\n${body}\n</attached-document>` });

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

describe("session titles with attachments (gap 14)", () => {
  test("a first turn with text and an image is titled by its text; an attachment-only turn names what it holds", async () => {
    const dir = join(tmpdir(), `yx-titles-${crypto.randomUUID().slice(0, 8)}`);
    const store = new LocalStore(dir);
    const seedBlocks = async (id: string, content: unknown) => {
      await store.registry.putSession({ sessionId: id, agentId: "a", workspace: "w", cwd: dir, status: "idle", head: null, model: "m", createdAt: "2026-06-27T10:00:00Z", updatedAt: "2026-06-27T10:00:00Z" });
      await store.conversation.append(id, { type: "user", message: { role: "user", content }, author: HUMAN, ts: "2026-06-27T10:00:00Z" } as never, null);
    };
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    await seedBlocks("t1", [img, { type: "text", text: "  what is in this screenshot?  " }]);
    await seedBlocks("t2", [img]);
    await seedBlocks("t3", [img, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } }]);
    const rows = await recentSessions(store, { limit: 10 });
    const title = (id: string) => rows.find((r) => r.record.sessionId === id)!.preview;
    expect(title("t1")).toBe("what is in this screenshot?");
    expect(title("t2")).toBe("[image]");
    expect(title("t3")).toBe("[image, document]");
  });
});

describe("the one title rule, on the file backend too (E-30, E-23)", () => {
  const seedBlocks = async (id: string, content: unknown) => {
    await store.registry.putSession({ sessionId: id, agentId: "a", workspace: "w", cwd: "/w", status: "idle", head: null, model: "m", createdAt: "2026-06-27T10:00:00Z", updatedAt: "2026-06-27T10:00:00Z" });
    await store.conversation.append(id, { type: "user", message: { role: "user", content }, author: HUMAN, ts: "2026-06-27T10:00:00Z" } as never, null);
  };
  const title = async (id: string) => (await recentSessions(store)).find((r) => r.record.sessionId === id)!.preview;

  test("a text file attached alone titles the session by its name, never its contents; with words, the words", async () => {
    const csv = attached("rows.csv", "id,amount\n7,19.99\n".repeat(5_000));
    await seedBlocks("alone", [csv]);
    await seedBlocks("worded", [csv, { type: "text", text: "  what changed in these rows? " }]);
    await seedBlocks("two", [csv, attached("notes.md", "# notes")]);
    expect(await title("alone")).toBe("rows.csv");
    expect(await title("worded")).toBe("what changed in these rows?");
    expect(await title("two")).toBe("rows.csv, notes.md");
  });

  test("the hosted serve's page-context block is the browser's data, never the title", async () => {
    const page = '<page_context>\nThe user\'s browser describes the page they are on.\n{"routeId":"usage"}\n</page_context>';
    await seedBlocks("own-block", [{ type: "text", text: page }, { type: "text", text: "why did usage spike?" }]);
    await seedBlocks("in-prompt", `${page}\nwhy did usage spike?`);
    expect(await title("own-block")).toBe("why did usage spike?");
    expect(await title("in-prompt")).toBe("why did usage spike?");
  });

  test("a long first message is cut at 72 characters with an ellipsis, never inside a surrogate pair", async () => {
    await seedBlocks("long", "x".repeat(71) + "😀".repeat(10));
    const t = await title("long");
    expect(t).toBe(`${"x".repeat(71)}…`);
    expect(t.isWellFormed()).toBe(true);
  });
});
