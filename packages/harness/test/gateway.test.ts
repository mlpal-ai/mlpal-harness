import { afterEach, describe, expect, test } from "bun:test";
import type { StreamDelta, ToolUseBlock } from "@mlpal/harness-protocol";
import {
  GatewayClient,
  GatewayError,
  type ModelResult,
  type ModelRequest,
  parseComputeUnits,
  withConversationCache,
} from "../src/gateway/client";
import { parseSSE } from "../src/gateway/sse";

const SSE = [
  `event: message_start
data: {"type":"message_start","message":{"id":"m1","model":"claude-opus-4-8","usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":0}}}`,
  `event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}`,
  `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}`,
  `event: content_block_stop
data: {"type":"content_block_stop","index":0}`,
  `event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}}`,
  `event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}`,
  `event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}`,
  `event: content_block_stop
data: {"type":"content_block_stop","index":1}`,
  `event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}`,
  `event: message_stop
data: {"type":"message_stop"}`,
].join("\n\n") + "\n\n";

async function drain(
  gen: AsyncGenerator<StreamDelta, ModelResult, void>,
): Promise<{ deltas: StreamDelta[]; result: ModelResult }> {
  const deltas: StreamDelta[] = [];
  let r = await gen.next();
  while (!r.done) {
    deltas.push(r.value);
    r = await gen.next();
  }
  return { deltas, result: r.value };
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // chunk it to exercise the buffer across reads
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
}

// A stream that surfaces some complete SSE (so a delta is emitted) and THEN the socket dies — the
// laptop-sleep signature: content was flowing, then the connection was torn down on wake. Pull-based
// so the prefix is fully delivered and parsed (emitting the delta) BEFORE the next read errors —
// a synchronous enqueue+error would let the error preempt delivery of the buffered chunk.
function streamThenError(prefix: string, err: Error): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(prefix);
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(bytes);
      } else {
        controller.error(err);
      }
    },
  });
}

// message_start + one text_delta("partial"), well-formed so consume() emits it before the drop.
const MID_DROP_PREFIX =
  [
    `event: message_start
data: {"type":"message_start","message":{"id":"m1","model":"m","usage":{"input_tokens":1,"output_tokens":0}}}`,
    `event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}`,
  ].join("\n\n") + "\n\n";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("parseSSE", () => {
  test("parses events across chunk boundaries", async () => {
    const events: Record<string, unknown>[] = [];
    for await (const e of parseSSE(streamFrom(SSE))) events.push(e);
    expect(events[0]?.type).toBe("message_start");
    expect(events.at(-1)?.type).toBe("message_stop");
  });

  test("handles \\r\\n framing", async () => {
    const crlf = SSE.replace(/\n/g, "\r\n");
    const events: Record<string, unknown>[] = [];
    for await (const e of parseSSE(streamFrom(crlf))) events.push(e);
    expect(events.length).toBeGreaterThan(5);
  });
});

describe("compute-units cost header", () => {
  test("parseComputeUnits: parsed when present (any case), absent when missing or garbage — never 0", () => {
    expect(parseComputeUnits(new Headers({ "X-MLPal-Compute-Units": "0.42" }))).toBe(0.42);
    expect(parseComputeUnits(new Headers({ "x-mlpal-compute-units": "1.5e-7" }))).toBe(1.5e-7);
    expect(parseComputeUnits(new Headers())).toBeUndefined();
    expect(parseComputeUnits(new Headers({ "X-MLPal-Compute-Units": "not-a-number" }))).toBeUndefined();
  });

  test("stream result carries computeUnits when the response header is present, omits it when not", async () => {
    globalThis.fetch = (async () =>
      new Response(SSE, { status: 200, headers: { "X-MLPal-Compute-Units": "0.137" } })) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const req: ModelRequest = { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], maxTokens: 100 };
    const withHeader = await drain(client.stream(req));
    expect(withHeader.result.computeUnits).toBe(0.137);

    globalThis.fetch = (async () => new Response(SSE, { status: 200 })) as unknown as typeof fetch;
    const without = await drain(client.stream(req));
    expect(without.result.computeUnits).toBeUndefined();
    expect("computeUnits" in without.result).toBe(false); // absent, not 0/null
  });
});

describe("GatewayClient accumulation (mocked)", () => {
  test("assembles text + tool_use and usage", async () => {
    globalThis.fetch = (async () =>
      new Response(SSE, { status: 200 })) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const req: ModelRequest = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    };
    const { deltas, result } = await drain(client.stream(req));

    const content = result.message.content as Array<{ type: string }>;
    const text = content.find((b) => b.type === "text") as unknown as { text: string };
    const tool = content.find((b) => b.type === "tool_use") as ToolUseBlock;

    expect(text.text).toBe("Hello world");
    expect(tool.name).toBe("Bash");
    expect(tool.input.command).toBe("ls");
    expect(result.stopReason).toBe("tool_use");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(20);
    expect(result.usage.cache_read_input_tokens).toBe(5);

    expect(deltas.some((d) => d.type === "text_delta" && d.text === "Hello ")).toBe(true);
    expect(deltas.some((d) => d.type === "tool_use_start")).toBe(true);
  });

  test("effort rides as output_config.effort only when set (no request-side thinking budget)", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(SSE, { status: 200 });
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const base: ModelRequest = { model: "claude-opus-4-8", messages: [{ role: "user", content: "hi" }], maxTokens: 100 };

    await drain(client.stream(base));
    expect(sent.output_config).toBeUndefined(); // unset => model/gateway default
    expect(sent.thinking).toBeUndefined(); // the dead budget_tokens knob is gone (400s on latest models)

    await drain(client.stream({ ...base, effort: "medium" }));
    expect(sent.output_config).toEqual({ effort: "medium" });
  });

  test("effort is sent only for Anthropic models (provider-agnostic: GPT/Gemini keep their defaults)", async () => {
    let sent: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(SSE, { status: 200 });
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const msgs = [{ role: "user" as const, content: "hi" }];

    await drain(client.stream({ model: "claude-opus-5", messages: msgs, maxTokens: 100, effort: "high" }));
    expect(sent.output_config).toEqual({ effort: "high" }); // Anthropic → sent

    for (const model of ["gpt-5.6-sol", "gemini-3.1-pro-preview"]) {
      await drain(client.stream({ model, messages: msgs, maxTokens: 100, effort: "high" }));
      expect(sent.output_config).toBeUndefined(); // non-Anthropic → not sent
    }
  });

  test("postFeedback POSTs the outcome to /v1/feedback and never throws", async () => {
    let url = "";
    let init: { method?: string; body?: string } = {};
    globalThis.fetch = (async (u: string, i: any) => {
      url = u;
      init = i;
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    client.postFeedback({ model: "gpt-5.6-terra", task_type: "coding", outcome: "escalated", escalated_to: "claude-opus-4-8" });
    await Promise.resolve(); // let the fire-and-forget request start
    expect(url).toBe("http://x/v1/feedback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body!)).toMatchObject({ model: "gpt-5.6-terra", outcome: "escalated", escalated_to: "claude-opus-4-8" });
  });

  test("postFeedback swallows a rejected request (best-effort telemetry)", () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    expect(() => client.postFeedback({ model: "m", task_type: "coding", outcome: "failed" })).not.toThrow();
  });

  test("merges usage that only arrives in the final message_delta (OpenAI-edge shape)", async () => {
    // Non-Anthropic providers learn input/cache counts at end-of-stream; the gateway
    // sends zeros at message_start and the exact usage in the last message_delta.
    const LATE = [
      `event: message_start
data: {"type":"message_start","message":{"id":"m1","model":"gpt-5.5","usage":{"input_tokens":0,"output_tokens":0}}}`,
      `event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
      `event: content_block_stop
data: {"type":"content_block_stop","index":0}`,
      `event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":432,"output_tokens":7,"cache_read_input_tokens":100}}`,
      `event: message_stop
data: {"type":"message_stop"}`,
    ].join("\n\n") + "\n\n";
    globalThis.fetch = (async () =>
      new Response(LATE, { status: 200 })) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const { result } = await drain(
      client.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "hi" }], maxTokens: 10 }),
    );
    expect(result.usage.input_tokens).toBe(432);
    expect(result.usage.output_tokens).toBe(7);
    expect(result.usage.cache_read_input_tokens).toBe(100);
  });

  test("throws GatewayError on non-200", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { type: "not_found", message: "no model" } }), {
        status: 404,
      })) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k", maxRetries: 0 });
    await expect(
      drain(
        client.stream({
          model: "nope",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 10,
        }),
      ),
    ).rejects.toThrow(/gateway 404/);
  });
});

describe("GatewayClient hardening", () => {
  test("honors retry-after and retries a 429", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(SSE, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const { result } = await drain(
      client.stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 50 }),
    );
    expect(calls).toBe(2);
    expect(result.stopReason).toBe("tool_use");
  });

  test("retries a stream that fails before emitting any content (pre-content)", async () => {
    // A stream that connects (200) but then errors before any delta — a transient drop — is
    // safe to retry because nothing was surfaced. This is the gap connect()'s retries missed.
    const EARLY_ERR =
      [
        `event: message_start
data: {"type":"message_start","message":{"id":"m1","model":"m","usage":{"input_tokens":1,"output_tokens":0}}}`,
        `event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}`,
      ].join("\n\n") + "\n\n";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(calls === 1 ? EARLY_ERR : SSE, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const { result } = await drain(
      client.stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 50 }),
    );
    expect(calls).toBe(2); // retried once, then succeeded
    expect(result.stopReason).toBe("tool_use");
  });

  test("re-streaming after content never duplicates output — a reset precedes each re-partial", async () => {
    // Re-streaming a mid-stream error could double output; it doesn't, because every resume yields a
    // `reset` first, telling the consumer to discard the stale partial before the fresh turn arrives.
    // So each "partial" delta is immediately preceded by a reset — no net duplication ever reaches
    // the transcript, even across the bounded resumes.
    const MID_ERR =
      [
        `event: message_start
data: {"type":"message_start","message":{"id":"m1","model":"m","usage":{"input_tokens":1,"output_tokens":0}}}`,
        `event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        `event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}`,
        `event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"boom"}}`,
      ].join("\n\n") + "\n\n";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(MID_ERR, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const gen = client.stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
    const seen: StreamDelta[] = [];
    await expect(
      (async () => {
        let r = await gen.next();
        while (!r.done) {
          seen.push(r.value);
          r = await gen.next();
        }
      })(),
    ).rejects.toThrow(/overloaded|boom|stream/);
    expect(calls).toBe(3); // initial + 2 bounded resumes, then surfaced
    // No duplication reaches the consumer: every "partial" delta is immediately preceded by a reset.
    const partialIdxs = seen.flatMap((d, i) => (d.type === "text_delta" && d.text === "partial" ? [i] : []));
    expect(partialIdxs.length).toBeGreaterThan(1); // it re-streamed the partial across resumes
    for (const i of partialIdxs.slice(1)) expect(seen[i - 1]?.type).toBe("reset"); // each re-partial follows a reset
  });

  test("resumes the whole turn on a mid-stream connection drop (laptop sleep), then completes", async () => {
    // Attempt 1 streams a delta, then the socket dies (network error). Because it's a pure
    // connectivity drop — not a server decision — the turn is safe to re-stream in full; the
    // consumer gets a `reset` to discard the stale partial, then the fresh complete turn.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(streamThenError(MID_DROP_PREFIX, new TypeError("fetch failed")), { status: 200 });
      }
      return new Response(SSE, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const { deltas, result } = await drain(
      client.stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 50 }),
    );
    expect(calls).toBe(2); // resumed the whole turn once
    expect(deltas.some((d) => d.type === "reset")).toBe(true); // consumer told to discard the partial
    const texts = deltas.filter((d) => d.type === "text_delta").map((d) => (d as { text: string }).text);
    expect(texts).toContain("partial"); // attempt 1's partial reached the consumer (then reset)
    expect(texts).toContain("Hello "); // attempt 2 re-streamed the full turn
    expect(result.stopReason).toBe("tool_use"); // and it completed cleanly
  });

  test("bounds resumes: a persistently dropping connection surfaces after maxResume", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(streamThenError(MID_DROP_PREFIX, new TypeError("ECONNRESET")), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k", maxResume: 2 });
    const gen = client.stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
    const seen: StreamDelta[] = [];
    await expect(
      (async () => {
        let r = await gen.next();
        while (!r.done) {
          seen.push(r.value);
          r = await gen.next();
        }
      })(),
    ).rejects.toThrow(/connection lost|network|ECONNRESET/i);
    expect(calls).toBe(3); // initial + 2 bounded resumes, then surfaced
    expect(seen.filter((d) => d.type === "reset").length).toBe(2); // one reset per resume
  });

  // A mid-stream `error` event (e.g. overloaded) after content is usually a transient upstream blip.
  // Re-streaming the byte-identical turn (partial discarded via `reset`) is safe, so we resume it —
  // bounded tight so a *persistent* error surfaces fast with minimal re-bill, not after eight re-runs.
  const MID_ERR =
    MID_DROP_PREFIX +
    `event: error
data: {"type":"error","error":{"type":"overloaded_error","message":"upstream stream error"}}` +
    "\n\n";

  test("re-streams a transient upstream stream error and recovers (no dying on a provider blip)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return calls === 1 ? new Response(MID_ERR, { status: 200 }) : new Response(SSE, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const { deltas, result } = await drain(
      client.stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 50 }),
    );
    expect(calls).toBe(2); // resumed once, then completed
    expect(deltas.some((d) => d.type === "reset")).toBe(true); // consumer told to discard the partial
    const text = (result.message.content as Array<{ type: string; text?: string }>).find((b) => b.type === "text");
    expect(text?.text).toBe("Hello world"); // attempt 2 re-streamed the full turn
  });

  test("bounds upstream stream-error resumes: a persistent one surfaces after a couple tries", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(MID_ERR, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const seen: StreamDelta[] = [];
    await expect(
      (async () => {
        for await (const d of client.stream({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          maxTokens: 50,
        }))
          seen.push(d);
      })(),
    ).rejects.toThrow(/overloaded|stream/);
    expect(calls).toBe(3); // initial + 2 bounded resumes, then surfaced
    expect(seen.filter((d) => d.type === "reset").length).toBe(2); // one reset per resume
  });

  test("a pre-aborted external signal yields a cancelled error (no fetch)", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(SSE, { status: 200 });
    }) as unknown as typeof fetch;

    const ac = new AbortController();
    ac.abort();
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k", signal: ac.signal });
    try {
      await drain(client.stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 10 }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).kind).toBe("cancelled");
    }
    expect(calls).toBe(0);
  });

  test("an abort during the request maps to cancelled even if the error isn't an AbortError", async () => {
    // Guards the interrupt path: if a Ctrl-C surfaces as a non-DOMException error, the user's
    // aborted signal must still yield `cancelled` (not a generic failure → ugly ✗, no flush).
    const ac = new AbortController();
    globalThis.fetch = (async () => {
      ac.abort(); // user hits Ctrl-C mid-flight
      throw new TypeError("terminated"); // ...and the runtime throws a non-AbortError shape
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k", signal: ac.signal, maxRetries: 0 });
    try {
      await drain(client.stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 10 }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).kind).toBe("cancelled");
    }
  });

  test("skips a malformed SSE event instead of crashing the stream", async () => {
    const BAD =
      [
        `data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}`,
        `data: {oops not json`,
        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`,
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`,
        `data: {"type":"message_stop"}`,
      ].join("\n\n") + "\n\n";
    globalThis.fetch = (async () => new Response(BAD, { status: 200 })) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k" });
    const { result } = await drain(
      client.stream({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 10 }),
    );
    const text = (result.message.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
  });
});

// Live test against the real gateway — runs only when YODEX_API_KEY is set.
const liveTest = process.env.YODEX_API_KEY ? test : test.skip;
describe("GatewayClient live", () => {
  liveTest(
    "calls the real gateway and gets a response",
    async () => {
      const client = new GatewayClient({
        baseUrl: process.env.YODEX_GATEWAY_URL ?? "https://models.mlpal.ai",
        apiKey: process.env.YODEX_API_KEY!,
      });
      const { result } = await drain(
        client.stream({
          model: process.env.YODEX_MODEL ?? "claude-opus-4-8",
          system: "You are a test harness. Reply with exactly one word.",
          messages: [{ role: "user", content: "Reply with exactly: PONG" }],
          maxTokens: 50,
        }),
      );
      const content = result.message.content as Array<{ type: string; text?: string }>;
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      expect(text.toUpperCase()).toContain("PONG");
      expect(result.usage.input_tokens).toBeGreaterThan(0);
    },
    30000,
  );
});

describe("GatewayClient model failover", () => {
  test("falls over to the next fallback model on a persistent pre-content error", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model as string;
      seen.push(model);
      if (model === "primary")
        return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
      return new Response(SSE, { status: 200 });
    }) as unknown as typeof fetch;

    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k", maxRetries: 0 });
    const { result } = await drain(
      client.stream({
        model: "primary",
        fallbackModels: ["fallback"],
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 50,
      }),
    );
    expect(result.stopReason).toBe("tool_use"); // succeeded on the fallback
    expect(seen.at(-1)).toBe("fallback");
    expect(seen.filter((m) => m === "fallback").length).toBe(1);
  });

  test("does not fail over on a non-retryable error (e.g. 404)", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string).model as string);
      return new Response(JSON.stringify({ error: { type: "not_found", message: "no model" } }), { status: 404 });
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://x", apiKey: "k", maxRetries: 0 });
    await expect(
      drain(client.stream({ model: "primary", fallbackModels: ["fallback"], messages: [{ role: "user", content: "hi" }], maxTokens: 50 })),
    ).rejects.toThrow();
    expect(seen).not.toContain("fallback"); // 404 is terminal — no failover
  });
});

describe("withConversationCache (Anthropic sliding-window breakpoints)", () => {
  test("marks the last two messages' final block, leaves earlier ones untouched", () => {
    const msgs = [
      { role: "user", content: "first" },
      { role: "assistant", content: [ { type: "text", text: "b" }, { type: "tool_use", id: "1", name: "x", input: {} } ] },
      { role: "user", content: [ { type: "tool_result", tool_use_id: "1", content: "r" } ] },
    ] as any;
    const out = withConversationCache(msgs) as any[];
    expect(out[0].content).toBe("first"); // unmarked -> untouched string
    expect(out[1].content.at(-1).cache_control).toEqual({ type: "ephemeral" }); // last block of 2nd-last
    expect(out[1].content[0].cache_control).toBeUndefined(); // only the final block
    expect(out[2].content.at(-1).cache_control).toEqual({ type: "ephemeral" }); // last block of last
  });

  test("a single message is marked; string content is wrapped to a text block", () => {
    const out = withConversationCache([{ role: "user", content: "hi" }] as any) as any[];
    expect(out[0].content).toEqual([{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }]);
  });

  test("empty conversation does not crash", () => {
    expect(withConversationCache([])).toEqual([]);
  });
});
