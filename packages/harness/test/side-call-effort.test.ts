import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@mlpal/harness-protocol";
import { GatewayClient, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import { PromptHook } from "../src/hooks/engine";
import { answerAside } from "../src/input/aside";
import { suggestCompletion } from "../src/input/suggest";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { createPermissionJudge } from "../src/permission/judge";
import { classifyStartRung } from "../src/routing/classifier";
import { LocalStore } from "../src/store/local";
import { defaultRegistry } from "../src/tools";
import { modelNotices } from "../src/watcher/watcher";

/**
 * Every small side call but the permission judge asks for no reasoning (`effort: "none"`). The gateway reads a missing effort as the model's
 * default, so a reasoning model at its default can spend a few-hundred-token budget thinking and answer nothing
 * (gpt-6-luna at max_tokens 200: 57 of 98 calls in a day). The main loop's calls keep the session's own effort.
 */

let root: string;
let cwd: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "yodex-sideeffort-"));
  cwd = mkdtempSync(join(tmpdir(), "yodex-sideeffort-cwd-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const text = (t: string): ModelResult => ({ model: "cheap", message: { role: "assistant", content: [{ type: "text", text: t }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" });

/** A model that answers `reply` and records every request it was sent. */
function recording(reply: (req: ModelRequest) => ModelResult = () => text("{}")) {
  const seen: ModelRequest[] = [];
  const client: ModelClient = {
    async *stream(req): AsyncGenerator<never, ModelResult, void> {
      seen.push(req);
      return reply(req);
    },
  };
  return { client, seen };
}

describe("side calls send effort none; the judge sends low", () => {
  test("the prompt hook", async () => {
    const { client, seen } = recording(() => text('{"block": false}'));
    await new PromptHook("cfg:PreToolUse#1", ["PreToolUse"], "block any git push to main", { client, model: "cheap" }).run({ event: "PreToolUse", toolName: "Bash", input: { command: "ls" } }, { sessionId: "s", agentId: "a", cwd: "/w" });
    expect(seen.map((r) => r.effort)).toEqual(["none"]);
  });

  test("the cruise permission judge reasons (low, with room for it): its wrong ALLOW is the one side-call error nothing catches", async () => {
    const { client, seen } = recording(() => text('{"verdict":"unsure","reason":"r"}'));
    const judge = createPermissionJudge({ model_client: client, model: "cheap", context: () => ({ hop: "coding", purpose: "p", allow: [], deny: [], roots: ["/w"] }) });
    await judge({ toolName: "Bash", input: { command: "make" }, readOnly: false, isEdit: false, principal: "user" as never });
    expect(seen.map((r) => [r.effort, r.maxTokens])).toEqual([["low", 1024]]);
  });

  test("the start-rung classifier, a suggestion, an aside and the watcher", async () => {
    const { client, seen } = recording();
    await classifyStartRung({ model_client: client, model: "cheap", task: "rename a variable", rungs: 3 });
    await suggestCompletion({ model_client: client, model: "cheap", draft: "fix the" });
    await answerAside({ model_client: client, model: "cheap", question: "what changed?" });
    await modelNotices({ prompt: "p", toolCalls: [], reply: "r", rules: [] }, { client, model: "cheap" });
    expect(seen.map((r) => r.effort)).toEqual(["none", "none", "none", "none"]);
  });

  test("the loop's summaries (compaction and condensed tool output) send none; its own model calls keep the session's effort", async () => {
    let turn = 0;
    const { client, seen } = recording((req) => {
      if (!req.tools?.length) return text(req.system?.includes("compress a coding session") ? "SUMMARY" : "condensed");
      turn += 1;
      return turn === 1
        ? { model: "m", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: `printf '%0.sx' $(seq 1 400)` } }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use" }
        : text("done");
    });
    const sess = new AgentSession({
      agentId: "ag",
      sessionId: "s-side-effort",
      workspace: "w",
      cwd,
      model: "m",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: client,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTokens: 100,
      effort: "high",
      condense: { threshold: 100, model: "cheap" },
    });
    const events: EngineEvent[] = [];
    for await (const e of sess.run({ text: "go" })) events.push(e);
    await sess.compact();
    // The loop's own calls carry its tools; a side call has none.
    const main = seen.filter((r) => r.tools?.length);
    const side = seen.filter((r) => !r.tools?.length);
    expect(main.length).toBeGreaterThanOrEqual(2);
    expect(main.every((r) => r.effort === "high")).toBe(true);
    expect(side.length).toBe(2); // one condensation, one compaction summary
    expect(side.map((r) => r.effort)).toEqual(["none", "none"]);
  });
});

describe("effort none reaches the gateway", () => {
  const SSE =
    [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"gpt-6-luna","usage":{"input_tokens":1,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"block\\": false}"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join("\n\n") + "\n\n";
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("as output_config.effort on the gateway's Anthropic wire, for an OpenAI and an Anthropic model alike, with no thinking field", async () => {
    const sent: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream", "x-mlpal-reasoning-effort": "none->none" } });
    }) as unknown as typeof fetch;
    const gateway = new GatewayClient({ baseUrl: "http://gateway", apiKey: "k" });
    for (const model of ["gpt-6-luna", "claude-haiku-5-5"]) {
      const hook = new PromptHook("cfg:PreToolUse#1", ["PreToolUse"], "block any git push to main", { client: gateway, model });
      expect(await hook.run({ event: "PreToolUse", toolName: "Bash", input: { command: "ls" } }, { sessionId: "s", agentId: "a", cwd: "/w" })).toEqual({});
    }
    expect(sent.map((b) => [b.model, b.output_config, b.thinking])).toEqual([
      ["gpt-6-luna", { effort: "none" }, undefined],
      ["claude-haiku-5-5", { effort: "none" }, undefined],
    ]);
  });
});
