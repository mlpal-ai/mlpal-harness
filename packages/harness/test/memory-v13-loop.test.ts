import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@mlpal/harness-protocol";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { FunctionHook, HookEngine } from "../src/hooks/engine";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { codingCheckpointNudge } from "../src/profile/builtins/coding";
import { LocalStore } from "../src/store/local";
import { defaultRegistry } from "../src/tools";

let root: string;
let cwd: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "yodex-v13-loop-"));
  cwd = mkdtempSync(join(tmpdir(), "yodex-v13-cwd-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const textDone = (text: string): ModelResult => ({
  model: "test",
  message: { role: "assistant", content: [{ type: "text", text }] },
  usage: { input_tokens: 8, output_tokens: 4 },
  stopReason: "end_turn",
});
const toolUse = (name: string, input: Record<string, unknown>): ModelResult => ({
  model: "test",
  message: { role: "assistant", content: [{ type: "tool_use", id: `tu_${crypto.randomUUID().slice(0, 6)}`, name, input }] },
  usage: { input_tokens: 10, output_tokens: 5 },
  stopReason: "tool_use",
});
async function collect(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const userTexts = (events: EngineEvent[]) =>
  events.filter((e) => e.type === "user").map((e) => (typeof e.message.content === "string" ? e.message.content : ""));

describe("memory v13 host triggers (F5)", () => {
  test("PreCompact carries the verbatim window and an ordinal; the context is rebuilt from memory after compaction", async () => {
    const seen: { transcript?: string; window?: number; messageCount: number }[] = [];
    const hooks = new HookEngine();
    hooks.register(
      new FunctionHook("ckpt", ["PreCompact"], (input) => {
        if (input.event === "PreCompact") seen.push({ transcript: input.transcript, window: input.window, messageCount: input.messageCount });
        return {};
      }),
    );
    let turn = 0;
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        if (req.system?.includes("compress a coding session")) return textDone("SUMMARY");
        turn += 1;
        if (turn <= 4) return toolUse("Bash", { command: `echo ${"x".repeat(2000)}` });
        return textDone("done");
      },
    };
    const rebuilt: string[] = [];
    const sess = new AgentSession({
      agentId: "ag1",
      sessionId: "s-v13",
      workspace: "w",
      cwd,
      model: "main-model",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: model,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTokens: 200,
      contextWindow: 1500,
      compaction: {
        keepRecentTurns: 2,
        onAfterCompact: async (summary) => {
          rebuilt.push(summary);
          return "[Memory after compaction]\nNow: echoing x.\nOpen threads: none.";
        },
      },
      hooks,
    });
    const events = await collect(sess.run({ text: "start" }));
    expect(seen.length).toBeGreaterThan(0);
    // ordinals count the session's summary compactions, 1..n
    expect(seen.map((x) => x.window)).toEqual(seen.map((_, i) => i + 1));
    // every window is the verbatim transcript about to be replaced, oldest turn first
    expect(seen[0]!.transcript).toContain("user: start");
    for (const x of seen) expect(x.transcript!.length).toBeGreaterThan(0);
    // one rebuild per summary compaction, each handed the summary the loop kept
    expect(rebuilt.length).toBe(seen.length);
    expect(new Set(rebuilt)).toEqual(new Set(["SUMMARY"]));
    expect(userTexts(events).some((t) => t.startsWith("[Memory after compaction]"))).toBe(true);
  });

  test("the host nudges a checkpoint every N turns, only while the memory tool is present", async () => {
    let turn = 0;
    const model: ModelClient = {
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        turn += 1;
        if (turn <= 6) return toolUse("Bash", { command: "echo hi" });
        return textDone("done");
      },
    };
    let present = true;
    const sess = new AgentSession({
      agentId: "ag1",
      sessionId: "s-v13-nudge",
      workspace: "billing-v2",
      cwd,
      model: "main-model",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: model,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTokens: 200,
      memoryCheckpoint: { everyTurns: 3, nudge: (t) => codingCheckpointNudge(t, "billing-v2"), enabled: () => present },
    });
    const events = await collect(sess.run({ text: "start" }));
    const nudges = userTexts(events).filter((t) => t.startsWith("[Checkpoint]"));
    expect(nudges.length).toBe(2); // turns 3 and 6 of 7
    expect(nudges[0]).toContain('workspace "billing-v2"');
    expect(nudges[0]).toContain("memory_checkpoint");

    turn = 0;
    present = false;
    const quiet = await collect(
      new AgentSession({
        agentId: "ag1",
        sessionId: "s-v13-quiet",
        workspace: "billing-v2",
        cwd,
        model: "main-model",
        systemPrompt: "t",
        tools: defaultRegistry(),
        store: new LocalStore(root),
        model_client: model,
        canUseTool: createPolicy({ mode: "autopilot" }),
        maxTokens: 200,
        memoryCheckpoint: { everyTurns: 3, nudge: (t) => codingCheckpointNudge(t, "billing-v2"), enabled: () => present },
      }).run({ text: "start" }),
    );
    expect(userTexts(quiet).filter((t) => t.startsWith("[Checkpoint]"))).toHaveLength(0);
  });
});
