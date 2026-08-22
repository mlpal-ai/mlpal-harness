import { describe, expect, test } from "bun:test";
import {
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
