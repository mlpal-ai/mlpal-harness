import { describe, expect, test } from "bun:test";
import type { Message } from "@mlpal/harness-protocol";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { deterministicNotices, digestFromMessages, extractRules, modelNotices, renderDigest, shouldWatch, watchTurn } from "../src/watcher/watcher";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string, uses: { id: string; name: string; input: Record<string, unknown> }[] = []): Message => ({ role: "assistant", content: [...(text ? [{ type: "text" as const, text }] : []), ...uses.map((u) => ({ type: "tool_use" as const, id: u.id, name: u.name, input: u.input }))] });
const results = (ids: { id: string; error?: boolean }[]): Message => ({ role: "user", content: ids.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: "ok", ...(r.error ? { is_error: true } : {}) })) });
const done = (text: string): ModelResult => ({ model: "cheap", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" });

describe("watcher: the digest", () => {
  test("the turn starts at the last text prompt; tool results are not prompts; calls carry a summary and their error state; the reply is the last assistant text", () => {
    const msgs: Message[] = [
      user("earlier turn"),
      assistant("old reply"),
      user("fix the login bug and run the tests"),
      assistant("", [{ id: "t1", name: "Read", input: { path: "src/login.ts" } }]),
      results([{ id: "t1" }]),
      assistant("", [{ id: "t2", name: "Edit", input: { path: "src/login.ts", old: "a", new: "b" } }, { id: "t3", name: "Bash", input: { command: "  bun   test  " } }]),
      results([{ id: "t2" }, { id: "t3", error: true }]),
      assistant("Fixed the null check. The tests fail on one case I could not reproduce."),
    ];
    const d = digestFromMessages(msgs, ["Always run bun test"])!;
    expect(d.prompt).toBe("fix the login bug and run the tests");
    expect(d.toolCalls).toEqual([
      { name: "Read", summary: "src/login.ts", isError: false },
      { name: "Edit", summary: "src/login.ts", isError: false },
      { name: "Bash", summary: "bun test", isError: true },
    ]);
    expect(d.reply).toStartWith("Fixed the null check");
    expect(d.rules).toEqual(["Always run bun test"]);
    expect(digestFromMessages([results([{ id: "x" }])])).toBeNull();
    expect(renderDigest(d)).toContain("3. Bash bun test [error]");
  });
});

describe("watcher: the free layer", () => {
  const digest = (reply: string, calls: [string, string, boolean?][]) => ({ prompt: "p", reply, rules: [], toolCalls: calls.map(([name, summary, isError]) => ({ name, summary, isError: Boolean(isError) })) });

  test("a claim with no evidence in the tool log is a notice; the same claim with evidence, or an admission, is not", () => {
    expect(deterministicNotices(digest("All tests pass now.", [["Edit", "a.ts"]])).map((n) => n.text)).toEqual(["the reply says the tests pass, but no such command appears in this turn's tool log"]);
    expect(deterministicNotices(digest("All tests pass now.", [["Bash", "bun test"]]))).toEqual([]);
    expect(deterministicNotices(digest("I did not run the tests; they should pass.", [["Edit", "a.ts"]]))).toEqual([]);
    expect(deterministicNotices(digest("Committed and pushed.", [["Bash", "git commit -m x"]])).map((n) => n.text)).toEqual(["the reply says it pushed, but no such command appears in this turn's tool log"]);
    expect(deterministicNotices(digest("Verified that it works end to end.", [["Read", "a.ts"]])).map((n) => n.kind)).toEqual(["unverified_claim"]);
  });

  test("two or more files edited with nothing run to check them is a notice; one file, or a check, is not", () => {
    expect(deterministicNotices(digest("Done.", [["Edit", "a.ts"], ["Write", "b.ts"]])).map((n) => n.kind)).toEqual(["unchecked_edits"]);
    expect(deterministicNotices(digest("Done.", [["Edit", "a.ts"], ["Edit", "a.ts"]]))).toEqual([]);
    expect(deterministicNotices(digest("Done.", [["Edit", "a.ts"], ["Write", "b.ts"], ["Bash", "bun run typecheck"]]))).toEqual([]);
    expect(deterministicNotices(digest("Done.", [["Edit", "a.ts"], ["Write", "b.ts", true]]))).toEqual([]); // the failed write is not an edit
  });

  test("a turn is watched when it acted or claimed; a read-only answer is not", () => {
    expect(shouldWatch(digest("Here is how it works.", [["Read", "a.ts"], ["Grep", "foo"]]))).toBe(false);
    expect(shouldWatch(digest("Here is how it works.", [["Bash", "ls"]]))).toBe(true);
    expect(shouldWatch(digest("Tests pass.", []))).toBe(true);
  });
});

describe("watcher: the model layer", () => {
  test("notices come back typed and clipped; unknown kinds become other; bad JSON or a failure is an empty list; host claims win over the model's", async () => {
    let answer = '{"notices":[{"kind":"rule_miss","text":"The rule says to run bun test before a commit; the turn committed without it."},{"kind":"nonsense","text":"x"},{"kind":"unverified_claim","text":"dup"}]}';
    const seen: string[] = [];
    const client: Pick<ModelClient, "stream"> = {
      async *stream(req) {
        seen.push(String(req.messages[0]!.content));
        if (answer === "throw") throw new Error("boom");
        return done(answer);
      },
    };
    const d = { prompt: "ship it", reply: "Committed. Tests pass.", rules: ["Always run bun test before a commit"], toolCalls: [{ name: "Bash", summary: "git commit -m x", isError: false }] };
    const m = await modelNotices(d, { client, model: "cheap" });
    expect(m).toEqual([
      { kind: "rule_miss", text: "The rule says to run bun test before a commit; the turn committed without it.", source: "cheap" },
      { kind: "other", text: "x", source: "cheap" },
      { kind: "unverified_claim", text: "dup", source: "cheap" },
    ]);
    expect(seen[0]).toContain("Rules from the instruction files:\n- Always run bun test before a commit");
    const all = await watchTurn(d, { client, model: "cheap" });
    expect(all.map((n) => [n.kind, n.source])).toEqual([["unverified_claim", "host"], ["rule_miss", "cheap"], ["other", "cheap"]]);
    answer = "not json at all";
    expect(await modelNotices(d, { client, model: "cheap" })).toEqual([]);
    answer = "throw";
    expect(await modelNotices(d, { client, model: "cheap" })).toEqual([]);
    // a read-only turn never reaches the model
    const calls = seen.length;
    await watchTurn({ ...d, reply: "Here is the answer.", toolCalls: [{ name: "Read", summary: "a", isError: false }] }, { client, model: "cheap" });
    expect(seen.length).toBe(calls);
  });

  test("rules are the directive lines of an instruction file, fences and headings skipped, clipped", () => {
    const rules = extractRules("# Title\n- **Always** run `bun test` before a commit.\n- short\n```\nnever inside a fence\n```\nPrefer small functions over clever ones.\nThis line describes nothing in particular at all.\n");
    expect(rules).toEqual(["Always run `bun test` before a commit.", "Prefer small functions over clever ones."]);
  });
});
