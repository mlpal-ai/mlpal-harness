import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineEvent } from "@mlpal/harness-protocol";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { loadMessages } from "../src/loop/messages";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { defaultRegistry } from "../src/tools";

let root: string;
let cwd: string;
beforeEach(async () => {
  root = join(tmpdir(), `yodex-fallback-${crypto.randomUUID()}`);
  cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const answer = (model: string, fallback?: ModelResult["fallback"]): ModelResult => ({
  model,
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  usage: { input_tokens: 8, output_tokens: 4 },
  stopReason: "end_turn",
  ...(fallback ? { fallback } : {}),
});

function session(model: ModelClient, store: LocalStore): AgentSession {
  return new AgentSession({ agentId: "ag1", sessionId: "s1", workspace: "w", cwd, model: "claude-opus-5", modelFallbacks: ["gpt-5.6-sol"], systemPrompt: "t", tools: defaultRegistry(), store, model_client: model, canUseTool: createPolicy({ mode: "autopilot" }) });
}

describe("D-53: a model fallback is never silent", () => {
  test("a call a fallback served yields and persists a typed model_fallback before its answer, and writes the events channel", async () => {
    const store = new LocalStore(root);
    const model: ModelClient = {
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        return answer("gpt-5.6-sol", { from: "claude-opus-5", reason: "HTTP 502: upstream 401 invalid x-api-key", code: "http_5xx" });
      },
    };
    const seen: EngineEvent[] = [];
    for await (const e of session(model, store).run({ text: "fix the deployment" })) seen.push(e as EngineEvent);
    const types = seen.map((e) => e.type);
    const fb = seen.find((e) => e.type === "model_fallback");
    expect(fb).toMatchObject({ type: "model_fallback", from: "claude-opus-5", to: "gpt-5.6-sol", code: "http_5xx", reason: expect.stringContaining("401") });
    expect(types.indexOf("model_fallback")).toBeLessThan(types.indexOf("assistant"));
    expect(seen.find((e) => e.type === "assistant")).toMatchObject({ model: "gpt-5.6-sol" });
    // persisted in the transcript, in order; the replayed model messages are unchanged by it
    const entries = await store.conversation.read("s1");
    expect(entries.map((x) => x.payload.type)).toContain("model_fallback");
    expect((await loadMessages(store, "s1")).map((m) => m.role)).toEqual(["user", "assistant"]);
    // the telemetry channel carries the typed record
    const events = await store.logs.read("s1", "events");
    expect(events.find((r) => r.kind === "model.fallback")).toMatchObject({ from: "claude-opus-5", to: "gpt-5.6-sol", code: "http_5xx" });
  });

  test("a call the requested model answered emits no fallback", async () => {
    const store = new LocalStore(root);
    const model: ModelClient = {
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        return answer("claude-opus-5");
      },
    };
    const seen: EngineEvent[] = [];
    for await (const e of session(model, store).run({ text: "hi" })) seen.push(e as EngineEvent);
    expect(seen.some((e) => e.type === "model_fallback")).toBe(false);
  });
});
