/**
 * The gateway client against W4's session-token contract fixtures (test/fixtures/p6-session-token, see its README):
 * each refusal body the gateway answers a session token with is replayed through the client's bearer, 401 and 403
 * handling; the token is an opaque bearer the engine sends verbatim. The gateway-internal shapes (the audit event,
 * the usage row) are W4's and skipped by name.
 */
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GatewayClient, GatewayError } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";
import { sessionTokenFixtures } from "./session-token-fixtures";

const SSE = [
  `event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":0}}}`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`,
  `event: message_stop\ndata: {"type":"message_stop"}`,
].join("\n\n") + "\n\n";

const fixtures = sessionTokenFixtures();
const byName = (n: string) => fixtures.find((f) => f.name === n)!;
const realFetch = globalThis.fetch;
let dir: string;
let tokenFile: string;
let bearers: string[];
let answer: (n: number) => Response;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p6-gw-contract-"));
  tokenFile = join(dir, "gateway.token");
  writeFileSync(tokenFile, "tok-1");
  bearers = [];
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    bearers.push(String((init.headers as Record<string, string>).authorization));
    return answer(bearers.length);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const replay = (f: { status?: number; body?: unknown }) => new Response(JSON.stringify(f.body), { status: f.status, headers: { "content-type": "application/json" } });
async function drain(model = "anthropic/claude-opus-4-8"): Promise<unknown> {
  try {
    const g = new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile } }).stream({ model, messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    let r = await g.next();
    while (!r.done) r = await g.next();
    return r.value;
  } catch (e) {
    return e;
  }
}

describe("W4's gateway session-token fixtures (mlpal-assistants-service a45fe8f)", () => {
  test("the set is the one the README pins: six files", () => {
    expect(fixtures.map((f) => f.name)).toEqual(["401-invalid-api-key", "403-model-not-allowed-v2", "403-model-not-allowed", "audit-model-call", "token-claims", "usage-row-key-tags"]);
  });

  test("401-invalid-api-key: one re-read and one retry, then sessionTokenRejected; a token rotated in between is taken", async () => {
    const f = byName("401-invalid-api-key");
    answer = () => replay(f);
    const e = (await drain()) as GatewayError;
    expect(e).toBeInstanceOf(GatewayError);
    expect([e.status, e.code, e.errorType, e.sessionTokenRejected]).toEqual([401, "invalid_api_key", "authentication_error", true]);
    expect(bearers).toEqual(["Bearer tok-1", "Bearer tok-1"]);
    bearers = [];
    answer = (n) => (n === 1 ? (writeFileSync(tokenFile, "tok-2"), replay(f)) : new Response(SSE, { headers: { "content-type": "text/event-stream" } }));
    expect(await drain()).not.toBeInstanceOf(Error);
    expect(bearers).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  test("401-invalid-api-key through the loop: the run ends as the typed refusal", async () => {
    answer = () => replay(byName("401-invalid-api-key"));
    const root = mkdtempSync(join(tmpdir(), "p6-gw-loop-"));
    try {
      const session = new AgentSession({ agentId: "a", sessionId: "s", workspace: "w", cwd: root, model: "anthropic/claude-opus-4-8", systemPrompt: "t", tools: new ToolRegistry(), store: new LocalStore(root), model_client: new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile } }), canUseTool: createPolicy({ mode: "autopilot" }), stamp: { hop: "infra@1.0.0", origin: "test", workspace: "w" } });
      const events: Array<Record<string, unknown>> = [];
      for await (const e of session.run({ text: "go" })) events.push(e as unknown as Record<string, unknown>);
      expect(events.find((e) => e.type === "result")).toMatchObject({ subtype: "error", refusal: { code: "model_access_denied", reason: "gateway", hop: "infra" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const name of ["403-model-not-allowed-v2", "403-model-not-allowed"]) {
    test(`${name}: the access refusal, never retried, the gateway's model kept (${byName(name).case})`, async () => {
      const f = byName(name);
      answer = () => replay(f);
      const e = (await drain()) as GatewayError;
      const body = f.body as { error: { code: string; message: string; type: string; model?: string }; model?: string };
      expect([e.status, e.code, e.errorType, e.modelAccessDenied, e.sessionTokenRejected]).toEqual([403, "model_not_allowed", "permission_error", true, false]);
      expect(e.message).toContain(body.error.message);
      // The Anthropic wire names the model inside `error`; the OpenAI wire beside it (the engine calls /v1/messages).
      expect(e.model).toBe(body.error.model);
      expect(bearers.length).toBe(1);
    });
  }

  test("token-claims: the token is an opaque bearer, sent verbatim (the engine never decodes or verifies it)", async () => {
    const f = byName("token-claims") as unknown as { header: unknown; claims: unknown; vector: { secret: string } };
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const signing = `${b64(f.header)}.${b64(f.claims)}`;
    const jwt = `${signing}.${createHmac("sha256", f.vector.secret).update(signing).digest("base64url")}`;
    writeFileSync(tokenFile, `${jwt}\n`);
    answer = () => new Response(SSE, { headers: { "content-type": "text/event-stream" } });
    await drain();
    expect(bearers).toEqual([`Bearer ${jwt}`]);
  });

  for (const name of ["audit-model-call", "usage-row-key-tags"]) {
    test.skip(`${name}: gateway-internal (${byName(name).case}); the engine never reads it`, () => {});
  }
});
