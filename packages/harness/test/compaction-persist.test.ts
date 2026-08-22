import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { loadMessages } from "../src/loop/messages";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { defaultRegistry } from "../src/tools";

let root: string;
let cwd: string;

beforeEach(async () => {
  root = join(tmpdir(), `yodex-compact-${crypto.randomUUID()}`);
  cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function textDone(text: string): ModelResult {
  return {
    model: "test",
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: { input_tokens: 8, output_tokens: 4 },
    stopReason: "end_turn",
  };
}

function session(model: ModelClient, extra = {}): AgentSession {
  return new AgentSession({
    agentId: "ag1",
    sessionId: "s1",
    workspace: "w",
    cwd,
    model: "test",
    systemPrompt: "t",
    tools: defaultRegistry(),
    store: new LocalStore(root),
    model_client: model,
    canUseTool: createPolicy({ mode: "autopilot" }),
    ...extra,
  });
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) void _;
}

describe("persistent compaction", () => {
  test("manual compact() writes a boundary; reload starts from the summary", async () => {
    // a model that answers turns, and produces a summary when asked to compress
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        if (req.system?.includes("compress a coding session")) return textDone("THE SUMMARY");
        return textDone("ok");
      },
    };
    const sess = session(model);
    await drain(sess.run({ text: "first message about widgets" }));
    await drain(sess.run({ text: "second message about gadgets" }));

    const before = await loadMessages(new LocalStore(root), "s1");
    expect(before.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant

    const res = await sess.compact("the widget decision");
    expect(res).not.toBeNull();
    expect(res!.summary).toBe("THE SUMMARY");

    const after = await loadMessages(new LocalStore(root), "s1");
    // reload is now bounded: just the summary turn (nothing came after the boundary yet)
    expect(after).toHaveLength(1);
    expect(after[0]!.role).toBe("user");
    expect(after[0]!.content).toContain("THE SUMMARY");
  });

  test("a post-boundary turn replays after the summary", async () => {
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        if (req.system?.includes("compress a coding session")) return textDone("SUMMARY-X");
        return textDone("reply");
      },
    };
    const sess = session(model);
    await drain(sess.run({ text: "early context" }));
    await sess.compact();
    await drain(sess.run({ text: "later question" }));

    const msgs = await loadMessages(new LocalStore(root), "s1");
    // [summary(user), later-question(user), reply(assistant)]
    expect(msgs[0]!.content).toContain("SUMMARY-X");
    expect(JSON.stringify(msgs)).toContain("later question");
    expect(JSON.stringify(msgs)).not.toContain("early context"); // folded into the summary

    // the next model call's history must be bounded by the boundary too
    const seen: string[] = [];
    const probe: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        seen.push(JSON.stringify(req.messages));
        return textDone("done");
      },
    };
    await drain(session(probe).run({ text: "ping" }));
    expect(seen[0]!).toContain("SUMMARY-X");
    expect(seen[0]!).not.toContain("early context");
  });

  test("the plan snapshot survives compaction verbatim (anchor state)", async () => {
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        if (req.system?.includes("compress a coding session")) return textDone("SUMMARY");
        return textDone("worked on it");
      },
    };
    const sess = session(model, {
      maxTurns: 2,
      planSnapshot: () => "#1 [completed] wire the auth flow\n#2 [in_progress] add rate limiting",
    });
    await drain(sess.run({ text: "do the work" }));
    const res = await sess.compact();
    expect(res!.summary).toContain("Current plan (verbatim");
    expect(res!.summary).toContain("#1 [completed] wire the auth flow");
    expect(res!.summary).toContain("#2 [in_progress] add rate limiting");
  });

  test("compact() is a no-op on a near-empty session", async () => {
    const sess = session({
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        return textDone("never");
      },
    });
    expect(await sess.compact()).toBeNull();
  });
});
