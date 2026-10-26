import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  CLOSE_PRINCIPAL_REFUSED,
  HARNESS_PROTOCOL_VERSION,
  type ClientMessage,
  type ResultEvent,
  type ScheduleView,
  type ServerMessage,
  type SessionSummary,
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
  test("version; 0.21 frames stay valid; the new frames type", () => {
    expect(HARNESS_PROTOCOL_VERSION).toBe("0.22.0");
    expect(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version).toBe("0.22.0");
    const legacy = { type: "run", requestId: "r", prompt: "hi", detach: true, origin: "schedule:01J" } satisfies ClientMessage;
    const add = { type: "add_schedule", requestId: "a", schedule: { name: "news", cadence: "daily@08:00", timezone: "America/Los_Angeles", prompt: "fetch the news", delivery: { mail: "me@example.com" }, mode: "new" } } satisfies ClientMessage;
    const runs = { type: "schedule_runs", requestId: "q", id: "01J", before: "2026-10-25T08:00:00Z", limit: 20 } satisfies ClientMessage;
    const view: ScheduleView = { id: "01J", name: "news", cadence: "daily@08:00", timezone: "America/Los_Angeles", prompt: "fetch the news", enabled: true, consecutiveFailures: 0, createdAt: "2026-10-24T00:00:00Z", owner: "org:acme", publication: "infra" };
    const fired = { type: "schedule_fired", scheduleId: "01J", sessionId: "s", conversationId: "conv_01J", status: "fired" } satisfies ServerMessage;
    const reply = { type: "schedule_runs", requestId: "q", id: "01J", firings: [{ scheduleId: "01J", slot: "2026-10-25T08:00:00Z", status: "skipped", reason: "cap_exhausted", at: "2026-10-25T08:00:01Z" }, { scheduleId: "01J", slot: "2026-10-26T08:00:00Z", status: "firing", at: "2026-10-26T08:00:00Z" }], hasMore: true } satisfies ServerMessage;
    expect([legacy.origin, add.schedule.name, runs.limit, view.consecutiveFailures, fired.status, reply.firings[0]?.reason]).toEqual(["schedule:01J", "news", 20, 0, "fired", "cap_exhausted"]);
  });
});
