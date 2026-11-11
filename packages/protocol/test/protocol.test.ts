import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CLOSE_PRINCIPAL_REFUSED,
  HARNESS_PROTOCOL_VERSION,
  type ClientMessage,
  type DelegatedCredential,
  type PageContextV1,
  type ErrorCode,
  type ErrorEvent,
  type InboxRejectedFrame,
  type PendingQueuedRun,
  type QueuedFrame,
  type ServerCapability,
  type WithdrawMessage,
  type WithdrawnFrame,
  type HopView,
  type ModelFallbackEvent,
  type BudgetSubject,
  type ModelRefusal,
  type SpendCode,
  type PendingApproval,
  type ResultEvent,
  type SandboxRefusal,
  type ScheduleView,
  type ServerMessage,
  type SessionStoreGrant,
  type SessionSummary,
  type ToolResultEvent,
  addUsage,
  agentAuthor,
  contentBlockSchema,
  emptyUsage,
  isPersisted,
  messageSchema,
  stopReasonSchema,
  toolUseBlockSchema,
  usageSchema,
} from "../src/index";

describe("content blocks", () => {
  test("parses a text block", () => {
    const b = contentBlockSchema.parse({ type: "text", text: "hello" });
    expect(b.type).toBe("text");
  });

  test("parses a tool_use block with arbitrary input", () => {
    const b = toolUseBlockSchema.parse({
      type: "tool_use",
      id: "tu_1",
      name: "Bash",
      input: { command: "ls -la", timeout: 5000 },
    });
    expect(b.name).toBe("Bash");
    expect(b.input.command).toBe("ls -la");
  });

  test("parses a tool_result with string content and error flag", () => {
    const b = contentBlockSchema.parse({
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "boom",
      is_error: true,
    });
    expect(b.type).toBe("tool_result");
  });

  test("rejects an unknown block type", () => {
    expect(() => contentBlockSchema.parse({ type: "nope" })).toThrow();
  });

  test("accepts cache_control on a text block", () => {
    const b = contentBlockSchema.parse({
      type: "text",
      text: "system prompt",
      cache_control: { type: "ephemeral" },
    });
    expect(b.type).toBe("text");
  });
});

describe("message", () => {
  test("accepts string content", () => {
    expect(messageSchema.parse({ role: "user", content: "hi" }).role).toBe("user");
  });

  test("accepts block-array content", () => {
    const m = messageSchema.parse({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    });
    expect(Array.isArray(m.content)).toBe(true);
  });
});

describe("stop reasons", () => {
  test("accepts the anthropic vocabulary", () => {
    for (const r of ["end_turn", "tool_use", "max_tokens", "stop_sequence"] as const) {
      expect(stopReasonSchema.parse(r)).toBe(r);
    }
  });
});

describe("usage", () => {
  test("adds usage including cache tiers", () => {
    const a = usageSchema.parse({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
    });
    const sum = addUsage(a, { input_tokens: 1, output_tokens: 2 });
    expect(sum.input_tokens).toBe(11);
    expect(sum.output_tokens).toBe(7);
    expect(sum.cache_read_input_tokens).toBe(100);
  });

  test("emptyUsage is zero", () => {
    expect(emptyUsage()).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("author", () => {
  test("agentAuthor defaults displayName to id", () => {
    expect(agentAuthor("a1")).toEqual({
      type: "agent",
      id: "a1",
      displayName: "a1",
    });
  });
});

describe("0.21", () => {
  test("close code (the version is pinned by the newest describe)", () => {
    expect(CLOSE_PRINCIPAL_REFUSED).toEqual({ code: 4403, reason: "principal refused" });
  });

  test("0.20.5 frames are 0.21 frames; the new fields are optional", () => {
    const legacy = { type: "run", requestId: "r", prompt: "hi" } satisfies ClientMessage;
    const detached = { type: "run", requestId: "r", prompt: "hi", detach: true, origin: "schedule:01J" } satisfies ClientMessage;
    const summary = { sessionId: "s", agentId: "a", status: "idle", model: "m", updatedAt: "t", title: "", owner: "org:acme", origin: "api" } satisfies SessionSummary;
    const result: ResultEvent = { type: "result", subtype: "interrupted", reason: "the engine restarted while this run was in flight", numTurns: 0, usage: emptyUsage(), ts: "t" };
    expect([legacy.type, detached.detach, summary.owner, result.subtype]).toEqual(["run", true, "org:acme", "interrupted"]);
  });
});

describe("0.22 (the schedules capability)", () => {
  test("0.21 frames stay valid; the new frames type (the version is pinned by the newest describe)", () => {
    const legacy = { type: "run", requestId: "r", prompt: "hi", detach: true, origin: "schedule:01J" } satisfies ClientMessage;
    const add = { type: "add_schedule", requestId: "a", schedule: { name: "news", cadence: "daily@08:00", timezone: "America/Los_Angeles", prompt: "fetch the news", delivery: { mail: "me@example.com" }, mode: "new" } } satisfies ClientMessage;
    const runs = { type: "schedule_runs", requestId: "q", id: "01J", before: "2026-10-25T08:00:00Z", limit: 20 } satisfies ClientMessage;
    const view: ScheduleView = { id: "01J", name: "news", cadence: "daily@08:00", timezone: "America/Los_Angeles", prompt: "fetch the news", enabled: true, consecutiveFailures: 0, createdAt: "2026-10-24T00:00:00Z", owner: "org:acme", publication: "infra" };
    const fired = { type: "schedule_fired", scheduleId: "01J", sessionId: "s", conversationId: "conv_01J", status: "fired" } satisfies ServerMessage;
    const reply = { type: "schedule_runs", requestId: "q", id: "01J", firings: [{ scheduleId: "01J", slot: "2026-10-25T08:00:00Z", status: "skipped", reason: "cap_exhausted", at: "2026-10-25T08:00:01Z" }, { scheduleId: "01J", slot: "2026-10-26T08:00:00Z", status: "firing", at: "2026-10-26T08:00:00Z" }], hasMore: true } satisfies ServerMessage;
    expect([legacy.origin, add.schedule.name, runs.limit, view.consecutiveFailures, fired.status, reply.firings[0]?.reason]).toEqual(["schedule:01J", "news", 20, 0, "fired", "cap_exhausted"]);
  });
});

describe("0.22.1 (budget_exceeded refusal; HopView.tools.include optional)", () => {
  test("a budget_exceeded refusal rides error, result and tool_result; model_access_denied still does", () => {
    const spent: ModelRefusal = { code: "budget_exceeded", model: "claude-opus-5-5", hop: "infra", reason: "gateway", message: "HOP infra cannot call claude-opus-5-5: the key's spend budget is exhausted" };
    const denied: ModelRefusal = { code: "model_access_denied", model: "gpt-6-sol", hop: "reviewer", reason: "hop_policy", message: "HOP reviewer does not allow gpt-6-sol here" };
    const error: ErrorEvent = { type: "error", message: spent.message, refusal: spent, ts: "t" };
    const result: ResultEvent = { type: "result", subtype: "error", reason: spent.message, refusal: spent, numTurns: 1, usage: emptyUsage(), ts: "t" };
    const toolResult: ToolResultEvent = { type: "tool_result", toolUseId: "tu", toolName: "Agent", content: spent.message, refusal: spent, isError: true, ts: "t" };
    const frame = { type: "error", requestId: "r", message: spent.message, refusal: spent } satisfies ServerMessage;
    expect([error.refusal?.code, result.refusal?.code, toolResult.refusal?.code, frame.refusal.code, denied.code]).toEqual(["budget_exceeded", "budget_exceeded", "budget_exceeded", "budget_exceeded", "model_access_denied"]);
  });

  test("HopView.tools.include is optional: absent = every registered tool, [] = none", () => {
    const view = (tools: HopView["tools"]): HopView => ({ name: "coding", version: "1.0.0", description: "", source: "builtin", dir: null, extendsChain: [], prompts: { system: "", verifierAgent: "" }, loop: { taskType: "coding", verifyCommand: null, envBroken: null, churnThreshold: 3, summarizerSystem: "", condenserSystem: "", checkpointNudge: false }, verification: {}, catalog: { profile: "" }, routing: {}, permissions: { defaultMode: "manual", allow: [], deny: [] }, tools, budgets: { maxTurns: 50 }, telemetry: { taskType: "coding" }, evals: [], locked: [], tunable: [], modules: {} });
    expect([view({}).tools.include, view({ include: [] }).tools.include, view({ include: ["Bash"] }).tools.include]).toEqual([undefined, [], ["Bash"]]);
  });
});

describe("0.22.2 (the budget refusal's window and resetsAt)", () => {
  test("a budget_exceeded refusal with and without window/resetsAt rides the result event and the error frame", () => {
    const bare: ModelRefusal = { code: "budget_exceeded", model: "claude-opus-5-5", hop: "infra", reason: "gateway", message: "HOP infra cannot call claude-opus-5-5 now" };
    const timed: ModelRefusal = { ...bare, window: "daily", resetsAt: "2026-10-27T00:00:00Z" };
    const result: ResultEvent = { type: "result", subtype: "error", reason: timed.message, refusal: timed, numTurns: 1, usage: emptyUsage(), ts: "t" };
    const event = { type: "event", sessionId: "s", event: result } satisfies ServerMessage;
    const frame = { type: "error", requestId: "r", message: bare.message, refusal: bare } satisfies ServerMessage;
    expect([event.event.refusal?.window, event.event.refusal?.resetsAt, frame.refusal.window, frame.refusal.resetsAt]).toEqual(["daily", "2026-10-27T00:00:00Z", undefined, undefined]);
  });
});

describe("0.22.3 (ScheduleSpec.delivery.webhookSecret, write-only)", () => {
  test("add_schedule and update_schedule take delivery.webhookSecret; a ScheduleView never carries it", () => {
    const add = { type: "add_schedule", requestId: "a", schedule: { name: "hook", cadence: "every 1h", timezone: "UTC", prompt: "p", delivery: { webhook: "https://h.example/in", webhookSecret: "test-only-secret" } } } satisfies ClientMessage;
    // A delivery patch is the whole delivery (hop-service replaces it), so a rotation re-sends the webhook.
    const update = { type: "update_schedule", requestId: "u", id: "01J", patch: { delivery: { webhook: "https://h.example/in", webhookSecret: "test-only-secret-2" } } } satisfies ClientMessage;
    const view: ScheduleView = { id: "01J", name: "hook", cadence: "every 1h", timezone: "UTC", prompt: "p", delivery: { webhook: "https://h.example/in" }, enabled: true, consecutiveFailures: 0, createdAt: "2026-10-26T00:00:00Z" };
    // @ts-expect-error the secret is write-only: the view's delivery has no webhookSecret
    const leaked: ScheduleView = { ...view, delivery: { webhook: "https://h.example/in", webhookSecret: "test-only-secret" } };
    expect([add.schedule.delivery.webhookSecret, update.patch.delivery.webhookSecret, view.delivery?.webhook, leaked.id]).toEqual(["test-only-secret", "test-only-secret-2", "https://h.example/in", "01J"]);
  });

  test("update_schedule clears the secret with webhookSecret: null", () => {
    const clear = { type: "update_schedule", requestId: "c", id: "01J", patch: { delivery: { webhook: "https://h.example/in", webhookSecret: null } } } satisfies ClientMessage;
    expect(JSON.parse(JSON.stringify(clear)).patch.delivery).toEqual({ webhook: "https://h.example/in", webhookSecret: null });
  });
});

describe("0.22.4 (SandboxRefusal: the remote sandbox at capacity)", () => {
  test("a sandbox_capacity refusal rides the tool_result, the result and the error event, beside refusal", () => {
    const capacity: SandboxRefusal = { code: "sandbox_capacity", reason: "quota_global", retryAfterS: 5, sandboxId: "sbx_1", message: "remote sandbox at capacity (quota_global): retry after 5 s" };
    const bare: SandboxRefusal = { code: "sandbox_capacity", reason: "no_hosts", message: "remote sandbox at capacity (no_hosts): no retry hint" };
    const toolResult: ToolResultEvent = { type: "tool_result", toolUseId: "tu", toolName: "Bash", content: capacity.message, sandboxRefusal: capacity, isError: true, ts: "t" };
    const result: ResultEvent = { type: "result", subtype: "error", reason: capacity.message, sandboxRefusal: capacity, numTurns: 1, usage: emptyUsage(), ts: "t" };
    const error: ErrorEvent = { type: "error", message: bare.message, sandboxRefusal: bare, ts: "t" };
    // @ts-expect-error rate_limited is not a capacity reason
    const limited: SandboxRefusal = { code: "sandbox_capacity", reason: "rate_limited", message: "m" };
    expect([toolResult.sandboxRefusal?.retryAfterS, result.sandboxRefusal?.sandboxId, error.sandboxRefusal?.retryAfterS, limited.code]).toEqual([5, "sbx_1", undefined, "sandbox_capacity"]);
  });
});

describe("0.26.2 (the gateway's spend codes on a model refusal: additive)", () => {
  test("version", () => {
    expect(HARNESS_PROTOCOL_VERSION).toBe("0.26.3");
    expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version).toBe("0.26.3");
  });

  test("wallet_empty, budget_unavailable and billing_unavailable ride a refusal beside budget_exceeded", () => {
    const codes: SpendCode[] = ["budget_exceeded", "wallet_empty", "budget_unavailable", "billing_unavailable"];
    const refusals: ModelRefusal[] = codes.map((code) => ({ code, model: "claude-opus-5-5", hop: "infra", reason: "gateway", message: "m" }));
    const results: ResultEvent[] = refusals.map((refusal) => ({ type: "result", subtype: "error", reason: refusal.message, refusal, numTurns: 1, usage: emptyUsage(), ts: "t" }));
    // @ts-expect-error insufficient_quota is the OpenAI wire's error type, not a code
    const wrong: ModelRefusal = { code: "insufficient_quota", model: "m", hop: "h", message: "m" };
    expect([results.map((r) => r.refusal?.code), wrong.hop]).toEqual([codes, "h"]);
  });

  test("a cap's subject may be tag, or a subject this protocol does not name, as sent", () => {
    const tag: BudgetSubject = "tag";
    const spent: ModelRefusal = { code: "budget_exceeded", model: "m", hop: "h", reason: "gateway", message: "m", subject: tag };
    const newer: ModelRefusal = { ...spent, subject: "org" };
    expect([spent.subject, newer.subject]).toEqual(["tag", "org"]);
  });
});

describe("0.26.1 (a parked call's tool and arguments: additive)", () => {
  test("pendingApproval may carry toolName and args, on the result event and on the session's history", () => {
    const pending: PendingApproval = { command: "send_email", reason: "approval_required", toolName: "mcp__mail__send", args: '{"to":"a@b.c"}' };
    const result: ResultEvent = { type: "result", subtype: "needs_approval", numTurns: 1, usage: emptyUsage(), ts: "t", pendingApproval: { ...pending } };
    const bare: PendingApproval = { command: "rm -rf build", reason: "approval_required" };
    expect([result.pendingApproval?.toolName, result.pendingApproval?.args, bare.toolName]).toEqual(["mcp__mail__send", '{"to":"a@b.c"}', undefined]);
  });
});

describe("0.26.0 (C8 delegated credential, C2 page context: additive)", () => {

  const cred: DelegatedCredential = { kind: "mlpal_user", token: "eyJh.eyJi.sig", expiresAt: 1_800_000_000_000, subject: "user:42" };

  test("delegated rides run and the three answer messages; the page context rides run as `context`", () => {
    const page: PageContextV1 = { v: 1, seq: 0, surface: "dashboard", routeId: "home", route: "/dashboard", title: "Dashboard home" };
    const run = { type: "run", requestId: "r", sessionId: "s", prompt: "list my agents", delegated: cred, context: page } satisfies ClientMessage;
    const perm = { type: "permission_response", id: "a", decision: "allow", delegated: cred } satisfies ClientMessage;
    const question = { type: "question_response", id: "q", outcome: { declined: false, answers: [] }, delegated: cred } satisfies ClientMessage;
    const approval = { type: "approval_response", sessionId: "s", decision: "allow", parkId: "p", delegated: cred } satisfies ClientMessage;
    expect([run, perm, question, approval].map((m) => m.delegated.kind)).toEqual(["mlpal_user", "mlpal_user", "mlpal_user", "mlpal_user"]);
    // @ts-expect-error a send carries no credential
    const send: ClientMessage = { type: "send", sessionId: "s", text: "x", delegated: cred };
    expect(send.type).toBe("send");
  });

  test("C1 §7.2/§7.4: secret_reveal and abuse_flag frames, the secret_revealed client frame, history cards", () => {
    const reveal = { type: "secret_reveal", sessionId: "s", toolUseId: "t1", kind: "api_key", key_id: "812", key_prefix: "mlpal_sk_abcd1234...", label: "ci", handle: "rvl_x", expires_at: "2026-11-04T21:05:00Z" } satisfies ServerMessage;
    const flag = { type: "abuse_flag", sessionId: "s", requestId: "r", reason: "off_topic" } satisfies ServerMessage;
    const redeemed = { type: "secret_revealed", sessionId: "s", toolUseId: "t1" } satisfies ClientMessage;
    const page = { type: "session_history", sessionId: "s", messages: [], secretReveals: [{ toolUseId: "t1", kind: "api_key", key_id: "812", key_prefix: "p", label: "ci", expires_at: "x", state: "revealed" }] } satisfies ServerMessage;
    expect([reveal.handle, flag.reason, redeemed.toolUseId, page.secretReveals[0]!.state]).toEqual(["rvl_x", "off_topic", "t1", "revealed"]);
  });

  test("the capabilities and the refusal codes are typed", () => {
    const caps: ServerCapability[] = ["delegated_credentials", "page_context", "secret_reveal", "abuse_flag", "live_attach"];
    const codes: ErrorCode[] = ["delegated_not_accepted", "delegated_not_declared", "delegated_subject_mismatch", "delegated_invalid", "delegated_expired"];
    expect([caps.length, codes.length]).toEqual([5, 5]);
    // @ts-expect-error only mlpal_user exists in v1
    const other: DelegatedCredential = { ...cred, kind: "gmail" };
    expect(other.subject).toBe("user:42");
  });
});

describe("0.25.0 (session_history.pendingQueue, D-63: additive)", () => {

  test("a newest history page may list this person's UI-queued runs, each with its words; the field is optional", () => {
    const run: PendingQueuedRun = { requestId: "rq-ui", position: 2, inboxSeq: 7, prompt: "and then?", blocks: [{ type: "text", text: "see" }] };
    const page = { type: "session_history", sessionId: "s1", messages: [], pendingQueue: [run, { requestId: "rq-2", position: 3, inboxSeq: 8, prompt: "x" }] } satisfies ServerMessage;
    const before = { type: "session_history", sessionId: "s1", messages: [] } satisfies ServerMessage;
    expect([page.pendingQueue.map((r) => r.requestId), "pendingQueue" in before]).toEqual([["rq-ui", "rq-2"], false]);
  });
});

describe("0.24.0 (model_fallback, D-53: additive)", () => {

  test("a model_fallback is a persisted SDK message naming the asked-for and the answering model", () => {
    const e: ModelFallbackEvent = { type: "model_fallback", from: "claude-opus-5", to: "gpt-5.6-sol", reason: "gateway 502: upstream 401", code: "http_5xx", ts: "t" };
    expect(isPersisted(e)).toBe(true);
  });
});

describe("0.23.0 (queue in connection mode, P2 1.1: additive)", () => {

  test("the queue frames are server messages, withdraw and watch.noticesAfter are client messages, and the codes are typed", () => {
    const queued: QueuedFrame = { type: "queued", requestId: "r1", sessionId: "s1", position: 2, inboxSeq: 7 };
    const replay: QueuedFrame = { type: "queued", requestId: "r1", sessionId: "s1", position: null, inboxSeq: 7, replayed: true };
    const rejected: InboxRejectedFrame = { type: "inbox_rejected", sessionId: "s1", requestId: "r1", code: "withdrawn", seq: 12 };
    const withdrawn: WithdrawnFrame = { type: "withdrawn", requestId: "r1", sessionId: "s1" };
    const codes: ErrorCode[] = ["inbox_full", "request_id_conflict", "queue_unavailable", "withdraw_refused", "approval_id_required", "approval_stale"];
    const full = { type: "error", requestId: "r1", sessionId: "s1", code: "inbox_full", message: "m", pending: 32, limit: 32, retryAfterS: 5 } satisfies ServerMessage;
    const refused = { type: "error", requestId: "r1", sessionId: "s1", code: "withdraw_refused", state: "consumed", message: "m" } satisfies ServerMessage;
    const server: ServerMessage[] = [queued, replay, rejected, withdrawn, full, refused];
    const withdraw: WithdrawMessage = { type: "withdraw", requestId: "r1", sessionId: "s1" };
    const client: ClientMessage[] = [withdraw, { type: "watch", sessionId: "s1", noticesAfter: 11 }, { type: "watch", sessionId: "s1" }];
    const capability: ServerCapability = "queue";
    expect([server.map((m) => m.type), client.map((m) => m.type), codes.length, capability]).toEqual([
      ["queued", "queued", "inbox_rejected", "withdrawn", "error", "error"],
      ["withdraw", "watch", "watch"],
      6,
      "queue",
    ]);
  });
});

describe("0.22.5 (SessionStoreGrant: the session store credential on the messages that write)", () => {

  test("a grant rides run, permission_response, question_response and approval_response", () => {
    const store: SessionStoreGrant = { leaseId: "lease_1", token: "test-token", url: "http://store:7100/v1" };
    const messages = [
      { type: "run", requestId: "r", sessionId: "s", prompt: "p", store },
      { type: "permission_response", id: "p1", decision: "allow", store },
      { type: "question_response", id: "parked:s", outcome: { declined: false, answers: [] }, store },
      { type: "approval_response", sessionId: "s", decision: "deny", store },
    ] satisfies ClientMessage[];
    expect(messages.map((m) => JSON.parse(JSON.stringify(m)).store)).toEqual([store, store, store, store]);
    const readOnly: SessionStoreGrant = { token: "test-token" };
    expect(readOnly.leaseId).toBeUndefined();
    // @ts-expect-error a read carries no grant
    const load: ClientMessage = { type: "load_session", sessionId: "s", store };
    expect(load.type).toBe("load_session");
  });
});
