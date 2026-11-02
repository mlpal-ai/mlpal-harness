import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineEvent } from "@mlpal/harness-protocol";
import { GatewayClient, type ModelClient, type ModelResult } from "../src/gateway/client";
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

describe("D-53 review: the switch is said when it happens, with a real gateway client", () => {
  const sse = (model: string, text: string) =>
    [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", model, usage: { input_tokens: 5, output_tokens: 0 } } })}`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
    ].join("\n\n") + "\n\n";
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });
  const gatewaySession = (store: LocalStore, extra: Record<string, unknown> = {}) =>
    new AgentSession({ agentId: "ag1", sessionId: "s1", workspace: "w", cwd, model: "claude-opus-5", modelFallbacks: ["gpt-5.6-sol"], systemPrompt: "t", tools: defaultRegistry(), store, model_client: new GatewayClient({ baseUrl: "http://gw", apiKey: "k", maxRetries: 0 }), canUseTool: createPolicy({ mode: "autopilot" }), ...extra });
  const primaryFails = (fallbackBody: (signal?: AbortSignal | null) => string | ReadableStream<Uint8Array>, seen: string[] = []) =>
    (globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model as string;
      seen.push(model);
      if (model === "claude-opus-5") return new Response(JSON.stringify({ error: { type: "api_error", message: "upstream said: invalid x-api-key sk-ant-secret" } }), { status: 502 });
      return new Response(fallbackBody(init.signal), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch);

  test("model_fallback comes before the fallback's first text delta, and its reason carries no provider text", async () => {
    primaryFails(() => sse("gpt-5.6-sol", "hello from the fallback"));
    const store = new LocalStore(root);
    const types: string[] = [];
    let fb: EngineEvent | undefined;
    for await (const e of gatewaySession(store).run({ text: "hi" })) {
      const ev = e as EngineEvent;
      types.push(ev.type);
      if (ev.type === "model_fallback") fb = ev;
    }
    expect(types.indexOf("model_fallback")).toBeGreaterThan(-1);
    expect(types.indexOf("model_fallback")).toBeLessThan(types.indexOf("text_delta"));
    expect(fb).toMatchObject({ from: "claude-opus-5", to: "gpt-5.6-sol", code: "http_5xx", reason: "gateway 502 api_error" });
    expect(JSON.stringify(await store.conversation.read("s1"))).not.toContain("sk-ant-secret");
    expect(types.filter((t) => t === "model_fallback")).toHaveLength(1); // announced once, not again on the result
  });

  test("a fallback stream cancelled mid-answer still leaves the transcript record and the events record", async () => {
    primaryFails(
      (signal) =>
        new ReadableStream({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode(sse("gpt-5.6-sol", "partial").split("event: content_block_stop")[0]!));
            // the stream stalls; the person presses Ctrl-C, which (as with a real fetch) ends the body
            signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
          },
        }),
    );
    const store = new LocalStore(root);
    const ac = new AbortController();
    for await (const e of gatewaySession(store, { signal: ac.signal }).run({ text: "hi" })) {
      if ((e as EngineEvent).type === "text_delta") ac.abort();
    }
    expect((await store.conversation.read("s1")).map((x) => x.payload.type)).toContain("model_fallback");
    expect((await store.logs.read("s1", "events")).some((r) => r.kind === "model.fallback")).toBe(true);
  });

  test("review M1: model.fallback deny is enforced by the session: no fallback is tried, whatever modelFallbacks holds", async () => {
    const seen: string[] = [];
    primaryFails(() => sse("gpt-5.6-sol", "should not be asked"), seen);
    const store = new LocalStore(root);
    const types: string[] = [];
    let threw = false;
    try {
      for await (const e of gatewaySession(store, { modelFallback: "deny" }).run({ text: "hi" })) types.push((e as EngineEvent).type);
    } catch {
      threw = true;
    }
    expect(seen).not.toContain("gpt-5.6-sol");
    expect(threw || types.includes("error") || types.includes("result")).toBe(true);
    expect(types).not.toContain("model_fallback");
  });

  test("review M1: under deny, a gateway answer from another model fails the call", async () => {
    globalThis.fetch = (async () => new Response(sse("gpt-5.6-sol", "swapped"), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const store = new LocalStore(root);
    const types: string[] = [];
    let threw = false;
    try {
      for await (const e of gatewaySession(store, { modelFallback: "deny" }).run({ text: "hi" })) types.push((e as EngineEvent).type);
    } catch {
      threw = true;
    }
    expect(types).not.toContain("text_delta");
    expect(threw || types.includes("error")).toBe(true);
  });
});
