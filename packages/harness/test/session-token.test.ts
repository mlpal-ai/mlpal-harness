import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GatewayClient, GatewayError } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { JsonLogger } from "../src/obs/logger";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";

/**
 * P6 (contract P6-vault-egress 1.1, §"Scoped gateway tokens"): on the platform the engine's gateway credential is
 * the scoped per-session token, a file (P3b `/run/session/gateway.token`) read on every request. A `401
 * invalid_api_key` re-reads it once and retries once (the scheduler may have just refreshed it), then ends the run as
 * the typed refusal; the session's `models_allow` refusal (`403 model_not_allowed`) is the same typed refusal.
 */

const SSE = [
  `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":0}}}`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
].join("\n\n") + "\n\n";

/** The gateway's 401 for a bad session token (one code, as S5). */
const INVALID_401 = { type: "error", error: { type: "authentication_error", message: "invalid api key", code: "invalid_api_key" } };
/** The gateway's 403 for a model outside the token's models_allow (typed on the Anthropic wire like budget_exceeded). */
const NOT_ALLOWED_403 = { type: "error", error: { type: "permission_error", message: "model gpt-6-sol is outside this session's models_allow", code: "model_not_allowed" } };

const TOKEN_A = "eyJ0ZXN0IjoiYSJ9.session-token-A.sig";
const TOKEN_B = "eyJ0ZXN0IjoiYiJ9.session-token-B.sig";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = () => new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } });

async function drain(client: GatewayClient, model = "claude-opus-5-5"): Promise<unknown> {
  try {
    const g = client.stream({ model, messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    let r = await g.next();
    while (!r.done) r = await g.next();
    return r.value;
  } catch (e) {
    return e;
  }
}

let dir: string;
let tokenFile: string;
const realFetch = globalThis.fetch;
/** Every request's bearer, in order. */
let bearers: string[];
let answer: (n: number) => Response;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p6-token-"));
  tokenFile = join(dir, "gateway.token");
  writeFileSync(tokenFile, `${TOKEN_A}\n`);
  bearers = [];
  answer = () => ok();
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bearers.push(String((init.headers as Record<string, string>).authorization));
    return answer(bearers.length);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("the session token file is the bearer, read on every request", () => {
  test("each request reads the file: a rotation between calls is the next request's bearer", async () => {
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile } });
    await drain(client);
    writeFileSync(tokenFile, TOKEN_B);
    await drain(client);
    expect(bearers).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
  });

  test("an unreadable or empty token file: no request, a non-retried error naming the path, never a value", async () => {
    unlinkSync(tokenFile);
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile } });
    const missing = await drain(client);
    expect(missing).toBeInstanceOf(GatewayError);
    expect((missing as GatewayError).message).toContain(tokenFile);
    expect((missing as GatewayError).retryable).toBe(false);
    writeFileSync(tokenFile, "\n");
    const empty = await drain(client);
    expect((empty as GatewayError).message).toContain("empty");
    expect(bearers).toEqual([]);
  });
});

describe("401 invalid_api_key: one re-read, one retry, then the typed refusal", () => {
  test("a token the scheduler refreshed after the 401: the retry carries the new file and the call succeeds", async () => {
    answer = (n) => {
      if (n === 1) {
        writeFileSync(tokenFile, TOKEN_B);
        return json(401, INVALID_401);
      }
      return ok();
    };
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile } });
    const result = await drain(client);
    expect(result).not.toBeInstanceOf(Error);
    expect(bearers).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
  });

  test("a second 401: exactly two requests, the error is the session token's refusal", async () => {
    answer = () => json(401, INVALID_401);
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile }, maxRetries: 3 });
    const e = (await drain(client)) as GatewayError;
    expect(e).toBeInstanceOf(GatewayError);
    expect([e.status, e.code, e.sessionTokenRejected]).toEqual([401, "invalid_api_key", true]);
    expect(bearers.length).toBe(2);
  });

  test("a desktop key (a provider, not a token file) is unchanged: one request, an untyped 401", async () => {
    answer = () => json(401, INVALID_401);
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: () => "mlpal_sk_desktop" });
    const e = (await drain(client)) as GatewayError;
    expect([e.status, e.sessionTokenRejected]).toEqual([401, false]);
    expect(bearers).toEqual(["Bearer mlpal_sk_desktop"]);
  });

  test("the retry's log line and the error carry no token value", async () => {
    answer = () => json(401, INVALID_401);
    const lines: string[] = [];
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile }, logger: new JsonLogger({ level: "debug", sink: (l) => lines.push(l) }) });
    const e = (await drain(client)) as GatewayError;
    expect(lines.some((l) => l.includes("session token refused"))).toBe(true);
    for (const text of [...lines, e.message, JSON.stringify(e)]) {
      expect(text).not.toContain(TOKEN_A);
      expect(text).not.toContain("session-token-A");
    }
  });

  test("through the loop: the run ends with refusal {code: model_access_denied, reason: gateway} on its result, persisted", async () => {
    answer = () => json(401, INVALID_401);
    const { result, persisted } = await runOnce(new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile } }), "claude-opus-5-5");
    const refusal = { code: "model_access_denied", model: "claude-opus-5-5", hop: "infra", reason: "gateway" };
    expect(result).toMatchObject({ type: "result", subtype: "error", refusal });
    expect(persisted).toMatchObject({ refusal });
  });
});

describe("403 model_not_allowed (P6 1.1: the token's models_allow)", () => {
  test("typed like model_access_denied: never retried, the refusal names the model and the HOP", async () => {
    answer = () => json(403, NOT_ALLOWED_403);
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile } });
    const e = (await drain(client, "gpt-6-sol")) as GatewayError;
    expect([e.status, e.code, e.modelAccessDenied, e.budgetExceeded]).toEqual([403, "model_not_allowed", true, false]);
    expect(e.message).toContain("outside this session's models_allow");
    expect(bearers.length).toBe(1);
    const { result } = await runOnce(new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile } }), "gpt-6-sol");
    expect(result).toMatchObject({ subtype: "error", refusal: { code: "model_access_denied", model: "gpt-6-sol", hop: "infra", reason: "gateway", message: "HOP infra cannot use gpt-6-sol here (the gateway refused it)" } });
  });

  test("a failover rung outside models_allow is skipped, as a policy-refused rung is", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model as string;
      seen.push(model);
      if (model === "claude-opus-5-5") return json(529, { error: { message: "overloaded" } });
      if (model === "gpt-6-sol") return json(403, NOT_ALLOWED_403);
      return ok();
    }) as unknown as typeof fetch;
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile }, maxRetries: 0 });
    const g = client.stream({ model: "claude-opus-5-5", fallbackModels: ["gpt-6-sol", "claude-haiku-fake"], messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    let r = await g.next();
    while (!r.done) r = await g.next();
    expect(seen.filter((m) => m !== "claude-opus-5-5")).toEqual(["gpt-6-sol", "claude-haiku-fake"]);
  }, 20_000);

  test("403 budget_exceeded is unchanged under the session token", async () => {
    answer = () => json(403, { type: "error", error: { type: "permission_error", message: "Spend budget exhausted", code: "budget_exceeded" } });
    const e = (await drain(new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile } }))) as GatewayError;
    expect([e.budgetExceeded, e.modelAccessDenied, e.sessionTokenRejected]).toEqual([true, false, false]);
    expect(bearers.length).toBe(1);
  });
});

async function runOnce(client: GatewayClient, model: string) {
  const root = mkdtempSync(join(tmpdir(), "p6-run-"));
  try {
    const store = new LocalStore(root);
    const session = new AgentSession({ agentId: "a", sessionId: "s", workspace: "w", cwd: root, model, systemPrompt: "t", tools: new ToolRegistry(), store, model_client: client, canUseTool: createPolicy({ mode: "autopilot" }), stamp: { hop: "infra@1.2.0", origin: "test", workspace: "w" } });
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    for await (const e of session.run({ text: "go" })) events.push(e as unknown as { type: string } & Record<string, unknown>);
    const persisted = (await store.conversation.read("s")).map((e) => e.payload as unknown as { type: string } & Record<string, unknown>).find((p) => p.type === "result");
    return { result: events.find((e) => e.type === "result"), persisted };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
