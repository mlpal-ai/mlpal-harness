import { describe, expect, test } from "bun:test";
import { GatewayClient } from "../src/gateway/client";

const SSE = [
  ["message_start", { type: "message_start", message: { id: "m", model: "x", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
]
  .map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
  .join("");

describe("gateway client carries the run's trace (telemetry v1, step 3)", () => {
  test("traceparent and baggage ride every request when a trace is given; stable across a retry; absent without one", async () => {
    const seen: Record<string, string>[] = [];
    let first = true;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      seen.push({ ...init.headers });
      if (first) {
        first = false;
        return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
      }
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    try {
      const client = new GatewayClient({ baseUrl: "http://gw", apiKey: "k" });
      const stamp = { session: "S", run: "R", prompt: "R", hop: "coding@1.0.0", origin: "local", workspace: "w" };
      const gen = client.stream({ model: "x", messages: [{ role: "user", content: "hi" }], maxTokens: 10, trace: { stamp, callId: "call-1" } });
      let r = await gen.next();
      while (!r.done) r = await gen.next();
      expect(seen).toHaveLength(2); // one retry
      expect(seen[0]!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(seen[1]!.traceparent).toBe(seen[0]!.traceparent); // the same call, the same ids
      expect(seen[0]!.baggage).toContain("mlpal.session=S,mlpal.run=R,mlpal.prompt=R,mlpal.hop=coding%401.0.0");
      expect(seen[0]!.authorization).toBe("Bearer k"); // the extra headers never shadow auth
      const gen2 = client.stream({ model: "x", messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
      let r2 = await gen2.next();
      while (!r2.done) r2 = await gen2.next();
      expect(seen[2]!.traceparent).toBeUndefined();
      expect(seen[2]!.baggage).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("C6: X-MLPal-On-Behalf-Of on every gateway call of an owner-paid run", () => {
  const run = async (client: GatewayClient) => {
    const gen = client.stream({ model: "x", messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
  };

  test("set: every message call and the feedback post carry it, across a retry; unset: absent", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let first = true;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: { ...init.headers } });
      if (url.endsWith("/v1/feedback")) return new Response("{}", { status: 200 });
      if (first) {
        first = false;
        return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
      }
      return new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    try {
      const paid = new GatewayClient({ baseUrl: "http://gw", apiKey: "k", onBehalfOf: "42" });
      await run(paid);
      paid.postFeedback({ outcome: "accepted" } as never);
      await Bun.sleep(10);
      expect(seen.map((s) => s.headers["x-mlpal-on-behalf-of"])).toEqual(["42", "42", "42"]);
      expect(seen.every((s) => s.headers.authorization === "Bearer k")).toBe(true);
      seen.length = 0;
      await run(new GatewayClient({ baseUrl: "http://gw", apiKey: "k" }));
      expect(seen[0]!.headers["x-mlpal-on-behalf-of"]).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a value outside C6's shape is refused at construction, never sent", () => {
    for (const bad of ["", "has space", "x".repeat(65), "tab\there", "é"]) expect(() => new GatewayClient({ baseUrl: "http://gw", apiKey: "k", onBehalfOf: bad })).toThrow(/on-behalf-of/);
  });
});
