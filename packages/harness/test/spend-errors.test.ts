import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { SpendCode } from "@mlpal/harness-protocol";
import { GatewayClient, GatewayError, type ModelSwitch, SPEND_RETRY_ATTEMPTS, SPEND_RETRY_BUDGET_MS } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";
import { FakeClock } from "./fake-clock";

/**
 * The gateway's spend codes (assistants-service 8d1cb2b, the managed-v1 ledger's harness-facing table). The bodies are
 * the gateway's own: the cap's two from the ledger, the wallet's from `WALLET_EMPTY_MESSAGE` and its two renderers, the
 * `_unavailable` envelopes from `typed_error_handler`.
 */
const CAP_MESSAGE = "Daily spend cap reached: 2.00 CU of 2.00 CU used today. It resets at 00:00 UTC on 2026-11-10.";
const WALLET_MESSAGE = "Wallet balance exhausted — top up at https://mlpal.ai/billing";
const BUDGET_UNAVAILABLE_MESSAGE = "The spend cap could not be checked just now, so the call was not made. Retry in a few seconds.";
const BILLING_UNAVAILABLE_MESSAGE = "Billing is temporarily unavailable; the request was not sent to the model. Retry shortly.";

const typedEnvelope = (code: string, message: string, extras: Record<string, unknown> = {}) => ({ code, message, detail: message, ...extras, type: "error", error: { type: "api_error", code, message, ...extras } });

interface Case {
  code: SpendCode;
  wire: "anthropic" | "openai";
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const CASES: Case[] = [
  {
    code: "budget_exceeded",
    wire: "anthropic",
    status: 403,
    body: { type: "error", error: { type: "permission_error", code: "budget_exceeded", message: CAP_MESSAGE, window: "daily", reset_at: "2026-11-10T00:00:00+00:00", subject: "key", unit: "cu", limit: 2.0, spent: 2.0012, budget_id: "workspace-daily" } },
  },
  { code: "budget_exceeded", wire: "openai", status: 402, body: { error: { message: CAP_MESSAGE, type: "insufficient_quota", code: "budget_exceeded", param: null } } },
  { code: "wallet_empty", wire: "anthropic", status: 402, body: { type: "error", error: { type: "billing_error", message: WALLET_MESSAGE, code: "wallet_empty" } } },
  { code: "wallet_empty", wire: "openai", status: 402, body: { error: { message: WALLET_MESSAGE, type: "insufficient_quota", code: "wallet_empty" } } },
  {
    code: "budget_unavailable",
    wire: "anthropic",
    status: 503,
    body: typedEnvelope("budget_unavailable", BUDGET_UNAVAILABLE_MESSAGE, { window: "daily", budget_id: "workspace-daily", subject: "key" }),
    headers: { "retry-after": "5", "x-should-retry": "true" },
  },
  { code: "budget_unavailable", wire: "openai", status: 503, body: { error: { type: "api_error", code: "budget_unavailable", message: BUDGET_UNAVAILABLE_MESSAGE } }, headers: { "retry-after": "5", "x-should-retry": "true" } },
  { code: "billing_unavailable", wire: "anthropic", status: 503, body: typedEnvelope("billing_unavailable", BILLING_UNAVAILABLE_MESSAGE), headers: { "retry-after": "5" } },
  { code: "billing_unavailable", wire: "openai", status: 503, body: { error: { type: "api_error", code: "billing_unavailable", message: BILLING_UNAVAILABLE_MESSAGE } }, headers: { "retry-after": "5" } },
];

const RETRIED = new Set<SpendCode>(["budget_unavailable", "billing_unavailable"]);

const answer = (c: Pick<Case, "status" | "body" | "headers">) => new Response(JSON.stringify(c.body), { status: c.status, headers: { "content-type": "application/json", ...c.headers } });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every request's model, answered by `reply` (by the model asked for and the request's index). */
function fakeGateway(reply: (model: string, i: number) => Response, clock?: FakeClock, latencyMs = 0) {
  const seen: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const model = JSON.parse(init.body as string).model as string;
    seen.push(model);
    if (clock && latencyMs) clock.advance(latencyMs);
    return reply(model, seen.length - 1);
  }) as unknown as typeof fetch;
  return seen;
}

/** A client on a manual clock whose waits advance it at once; every wait is recorded. */
function clientOn(clock: FakeClock) {
  const waits: number[] = [];
  const client = new GatewayClient({
    baseUrl: "http://gw",
    apiKey: "k",
    now: clock.now,
    sleep: async (ms) => {
      waits.push(ms);
      clock.advance(ms);
    },
  });
  return { client, waits };
}

/** Drains one call; what it yielded and what it threw. */
async function drain(client: GatewayClient, fallbackModels: string[] = ["claude-haiku-5-5", "gpt-6-luna"]) {
  const switches: ModelSwitch[] = [];
  try {
    const g = client.stream({ model: "claude-opus-5-5", fallbackModels, messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    for (let r = await g.next(); !r.done; r = await g.next()) if (r.value.type === "model_switch") switches.push(r.value);
  } catch (e) {
    return { switches, error: e as GatewayError };
  }
  return { switches, error: undefined };
}

describe("the gateway's spend codes at the client: typed by error.code, never failed over", () => {
  for (const c of CASES) {
    test(`${c.code} (${c.wire} wire, ${c.status}): ${RETRIED.has(c.code) ? `retried after Retry-After within ${SPEND_RETRY_ATTEMPTS} attempts` : "not retried"}, no other model asked`, async () => {
      const clock = new FakeClock();
      const seen = fakeGateway(() => answer(c));
      const { client, waits } = clientOn(clock);
      const { switches, error } = await drain(client);
      expect(error).toBeInstanceOf(GatewayError);
      expect([error!.code, error!.spendCode, error!.status]).toEqual([c.code, c.code, c.status]);
      expect(switches).toEqual([]);
      if (RETRIED.has(c.code)) {
        expect(seen).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5"]);
        expect(waits).toEqual([5000, 5000]);
      } else {
        expect(seen).toEqual(["claude-opus-5-5"]);
        expect(waits).toEqual([]);
      }
    });
  }

  test("a 402 is not a code: wallet_empty and budget_exceeded share it and are told apart by error.code alone", async () => {
    const codes: Array<string | undefined> = [];
    for (const c of CASES.filter((x) => x.status === 402)) {
      fakeGateway(() => answer(c));
      codes.push((await drain(clientOn(new FakeClock()).client)).error?.spendCode);
    }
    expect(codes).toEqual(["budget_exceeded", "wallet_empty", "wallet_empty"]);
  });

  test("the cap's 403 keeps the gateway's sentence, window, reset_at and subject", async () => {
    fakeGateway(() => answer(CASES[0]!));
    const { error } = await drain(clientOn(new FakeClock()).client);
    expect([error!.gatewayMessage, error!.window, error!.resetAt, error!.subject]).toEqual([CAP_MESSAGE, "daily", "2026-11-10T00:00:00+00:00", "key"]);
  });

  test("a transient spend code that clears on a retry answers from the same model", async () => {
    const unavailable = CASES.find((c) => c.code === "budget_unavailable")!;
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const seen = fakeGateway((_m, i) => (i === 0 ? answer(unavailable) : new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })));
    const { client, waits } = clientOn(new FakeClock());
    const g = client.stream({ model: "claude-opus-5-5", fallbackModels: ["claude-haiku-5-5"], messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    let r = await g.next();
    while (!r.done) r = await g.next();
    expect([r.value.model, r.value.attempts, r.value.fallback]).toEqual(["claude-opus-5-5", 2, undefined]);
    expect([seen, waits]).toEqual([["claude-opus-5-5", "claude-opus-5-5"], [5000]]);
  });

  test("a rung reached by an ordinary failover that meets a spend code ends there: no further rung", async () => {
    const overloaded = { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "busy" } }, headers: { "retry-after": "0" } };
    const seen = fakeGateway((model) => (model === "claude-opus-5-5" ? answer(overloaded) : answer(CASES[0]!)));
    const { switches, error } = await drain(clientOn(new FakeClock()).client);
    expect(error?.spendCode).toBe("budget_exceeded");
    expect(switches.map((s) => s.to)).toEqual(["claude-haiku-5-5"]);
    expect(seen.filter((m) => m !== "claude-opus-5-5")).toEqual(["claude-haiku-5-5"]);
  });
});

describe(`the retry bound for a transient spend code: ${SPEND_RETRY_ATTEMPTS} attempts or ${SPEND_RETRY_BUDGET_MS / 1000} s, on a manual clock`, () => {
  const unavailable = (retryAfter?: string): Pick<Case, "status" | "body" | "headers"> => ({ status: 503, body: { error: { type: "api_error", code: "budget_unavailable", message: BUDGET_UNAVAILABLE_MESSAGE } }, headers: retryAfter === undefined ? {} : { "retry-after": retryAfter } });

  test("Retry-After is honoured, never shortened: a wait past the budget ends the retries", async () => {
    for (const [retryAfter, requests, waits] of [
      ["5", 3, [5000, 5000]],
      ["15", 2, [15000]],
      ["20", 2, [20000]],
      ["21", 1, []],
      ["300", 1, []],
    ] as const) {
      const clock = new FakeClock();
      const started = clock.now();
      const seen = fakeGateway(() => answer(unavailable(retryAfter)));
      const c = clientOn(clock);
      const { error } = await drain(c.client);
      expect([retryAfter, error?.spendCode, seen.length, c.waits]).toEqual([retryAfter, "budget_unavailable", requests, [...waits]]);
      expect(clock.now() - started).toBeLessThanOrEqual(SPEND_RETRY_BUDGET_MS);
    }
  });

  test("the budget counts the requests' own time too", async () => {
    const clock = new FakeClock();
    const started = clock.now();
    const seen = fakeGateway(() => answer(unavailable("5")), clock, 9000);
    const c = clientOn(clock);
    await drain(c.client);
    // 9 s, wait 5 s (14 s), 9 s (23 s): a further 5 s wait would end past 20 s.
    expect([seen.length, c.waits, clock.now() - started]).toEqual([2, [5000], 23_000]);
  });

  test("without Retry-After the client's own backoff applies, within the same bound", async () => {
    const seen = fakeGateway(() => answer(unavailable()));
    const c = clientOn(new FakeClock());
    await drain(c.client);
    expect([seen.length, c.waits]).toEqual([3, [1000, 2000]]);
  });

  test("an ordinary 503 keeps its own retries and failover", async () => {
    const seen = fakeGateway(() => answer({ status: 503, body: { type: "error", error: { type: "api_error", message: "upstream" } }, headers: { "retry-after": "0" } }));
    const { switches } = await drain(clientOn(new FakeClock()).client);
    expect(switches.map((s) => s.to)).toEqual(["claude-haiku-5-5", "gpt-6-luna"]);
    expect(new Set(seen)).toEqual(new Set(["claude-opus-5-5", "claude-haiku-5-5", "gpt-6-luna"]));
  });
});

describe("a run that meets a spend code ends with a typed refusal, persisted, with no model switch", () => {
  const WORDS: Record<SpendCode, string> = {
    budget_exceeded: CAP_MESSAGE,
    wallet_empty: "Your wallet is empty, top up at mlpal.ai/billing",
    budget_unavailable: "The spend cap could not be checked, try again shortly",
    billing_unavailable: "Billing could not be checked, try again shortly",
  };

  async function runAgainst(c: Case) {
    const seen = fakeGateway(() => answer(c));
    const clock = new FakeClock();
    const root = mkdtempSync(join(tmpdir(), "yx-spend-"));
    try {
      const store = new LocalStore(root);
      const session = new AgentSession({
        agentId: "a",
        sessionId: "s",
        workspace: "w",
        cwd: root,
        model: "claude-opus-5-5",
        modelFallbacks: ["claude-haiku-5-5", "gpt-6-luna"],
        systemPrompt: "t",
        tools: new ToolRegistry(),
        store,
        model_client: clientOn(clock).client,
        canUseTool: createPolicy({ mode: "autopilot" }),
        stamp: { hop: "infra@1.2.0", origin: "test", workspace: "w" },
      });
      const events: Array<{ type: string } & Record<string, unknown>> = [];
      for await (const e of session.run({ text: "go" })) events.push(e as unknown as { type: string } & Record<string, unknown>);
      const persisted = (await store.conversation.read("s")).map((e) => e.payload as unknown as { type: string } & Record<string, unknown>);
      return { seen, events, persisted };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  for (const c of CASES) {
    test(`${c.code} (${c.wire} wire)`, async () => {
      const { seen, events, persisted } = await runAgainst(c);
      const refusal = { code: c.code, model: "claude-opus-5-5", hop: "infra", reason: "gateway", message: WORDS[c.code] };
      const result = events.find((e) => e.type === "result");
      expect(result).toMatchObject({ subtype: "error", reason: WORDS[c.code], refusal });
      expect(persisted.find((p) => p.type === "result")).toMatchObject({ subtype: "error", refusal });
      expect(events.some((e) => e.type === "model_fallback")).toBe(false);
      expect(new Set(seen)).toEqual(new Set(["claude-opus-5-5"]));
    });
  }

  test("the cap's refusal carries the gateway's window, reset_at and subject for the UI", async () => {
    const { events } = await runAgainst(CASES[0]!);
    expect(events.find((e) => e.type === "result")?.refusal).toEqual({ code: "budget_exceeded", model: "claude-opus-5-5", hop: "infra", reason: "gateway", message: CAP_MESSAGE, window: "daily", resetsAt: "2026-11-10T00:00:00+00:00", subject: "key" });
  });
});
