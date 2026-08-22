import { describe, expect, test } from "bun:test";
import type { Message } from "@mlpal/harness-protocol";
import { contextReport } from "../src/context/report";

describe("contextReport", () => {
  test("breaks usage into system/tools/conversation and sums them", () => {
    const messages: Message[] = [
      { role: "user", content: "hello there" },
      { role: "assistant", content: "hi" },
    ];
    const r = contextReport({
      systemPrompt: "x".repeat(400),
      toolSchemas: "y".repeat(200),
      messages,
      window: 200000,
    });
    expect(r.segments.map((s) => s.label)).toEqual([
      "System prompt (incl. memory + env)",
      "Tool definitions",
      "Conversation",
    ]);
    expect(r.segments[0]!.tokens).toBe(100); // 400/4
    expect(r.segments[1]!.tokens).toBe(50); // 200/4
    expect(r.estimatedUsed).toBe(r.segments.reduce((a, s) => a + s.tokens, 0));
    expect(r.window).toBe(200000);
    expect(r.lastInputTokens).toBeUndefined();
  });

  test("surfaces the real last-request anchor when provided", () => {
    const r = contextReport({
      systemPrompt: "sys",
      toolSchemas: "[]",
      messages: [],
      window: 100000,
      lastInputTokens: 4242,
    });
    expect(r.lastInputTokens).toBe(4242);
  });
});
