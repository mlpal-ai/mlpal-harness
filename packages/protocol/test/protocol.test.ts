import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CLOSE_PRINCIPAL_REFUSED,
  HARNESS_PROTOCOL_VERSION,
  type ClientMessage,
  type ErrorEvent,
  type HopView,
  type ModelRefusal,
  type ResultEvent,
  type ScheduleView,
  type ServerMessage,
  type SessionSummary,
  type ToolResultEvent,
  addUsage,
  agentAuthor,
  contentBlockSchema,
  emptyUsage,
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
  test("version", () => {
    expect(HARNESS_PROTOCOL_VERSION).toBe("0.22.3");
    expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version).toBe("0.22.3");
  });

  test("add_schedule and update_schedule take delivery.webhookSecret; a ScheduleView never carries it", () => {
    const add = { type: "add_schedule", requestId: "a", schedule: { name: "hook", cadence: "every 1h", timezone: "UTC", prompt: "p", delivery: { webhook: "https://h.example/in", webhookSecret: "test-only-secret" } } } satisfies ClientMessage;
    const update = { type: "update_schedule", requestId: "u", id: "01J", patch: { delivery: { webhookSecret: "test-only-secret-2" } } } satisfies ClientMessage;
    const view: ScheduleView = { id: "01J", name: "hook", cadence: "every 1h", timezone: "UTC", prompt: "p", delivery: { webhook: "https://h.example/in" }, enabled: true, consecutiveFailures: 0, createdAt: "2026-10-26T00:00:00Z" };
    // @ts-expect-error the secret is write-only: the view's delivery has no webhookSecret
    const leaked: ScheduleView = { ...view, delivery: { webhook: "https://h.example/in", webhookSecret: "test-only-secret" } };
    expect([add.schedule.delivery.webhookSecret, update.patch.delivery.webhookSecret, view.delivery?.webhook, leaked.id]).toEqual(["test-only-secret", "test-only-secret-2", "https://h.example/in", "01J"]);
  });
});
