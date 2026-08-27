import { describe, expect, test } from "bun:test";
import type { Message } from "@mlpal/harness-protocol";
import {
  estimateMessagesTokens,
  estimateTokens,
  maybeCompact,
} from "../src/context/compaction";

const big = (n: number) => "x".repeat(n);

describe("token estimation", () => {
  test("char/4 with content scaling", () => {
    expect(estimateTokens("xxxx")).toBe(1);
    const small = estimateMessagesTokens([{ role: "user", content: "hi" }]);
    const large = estimateMessagesTokens([{ role: "user", content: big(4000) }]);
    expect(large).toBeGreaterThan(small + 900);
  });
});

describe("maybeCompact", () => {
  const summarize = async () => "SUMMARY";

  test("no compaction under budget", async () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const r = await maybeCompact(messages, "sys", {
      contextWindow: 200000,
      maxOutputTokens: 8192,
      summarize,
    });
    expect(r.compacted).toBe(false);
    expect(r.messages).toBe(messages);
  });

  test("compacts when over budget, keeps recent, prepends summary", async () => {
    // build a long alternating history; small context window to force compaction
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `turn ${i} ${big(500)}` });
      messages.push({ role: "assistant", content: `reply ${i} ${big(500)}` });
    }
    const r = await maybeCompact(messages, undefined, {
      contextWindow: 4000,
      maxOutputTokens: 500,
      threshold: 0.8,
      keepRecentTurns: 4,
      summarize,
    });
    expect(r.compacted).toBe(true);
    expect(r.messages.length).toBeLessThan(messages.length);
    // first message carries the summary and is a user turn
    const first = r.messages[0]!;
    expect(first.role).toBe("user");
    expect(JSON.stringify(first.content)).toContain("SUMMARY");
  });

  test("never starts recent on an orphaned tool_result (boundary safety)", async () => {
    // history where the natural cut would land mid tool_use/tool_result pair
    const messages: Message[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `ask ${i} ${big(400)}` });
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { cmd: big(200) } }],
      });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `t${i}`, content: big(400) }],
      });
      messages.push({ role: "assistant", content: `done ${i}` });
    }
    const r = await maybeCompact(messages, undefined, {
      contextWindow: 3000,
      maxOutputTokens: 400,
      keepRecentTurns: 5,
      summarize,
    });
    expect(r.compacted).toBe(true);
    // the message right after the summary must not be a tool_result carrier
    const second = r.messages[1];
    if (second && typeof second.content !== "string") {
      expect(second.content.some((b) => b.type === "tool_result")).toBe(false);
    }
    // and the summary-bearing first message itself isn't a tool_result carrier
    const first = r.messages[0]!;
    if (typeof first.content !== "string") {
      expect(first.content.some((b) => b.type === "tool_result")).toBe(false);
    }
  });

  test("skips compaction when too short to cut safely", async () => {
    const messages: Message[] = [
      { role: "user", content: big(5000) },
      { role: "assistant", content: big(5000) },
    ];
    const r = await maybeCompact(messages, undefined, {
      contextWindow: 1000,
      maxOutputTokens: 100,
      keepRecentTurns: 6,
      summarize,
    });
    expect(r.compacted).toBe(false);
  });
});

describe("compaction estimation hardening (2026-08-27 engine review #4/#11)", () => {
  test("knownFloorTokens forces compaction when char/4 underestimates", async () => {
    // Small transcript by char count, but the gateway reported it's really huge (cache-heavy).
    const messages: Message[] = [
      { role: "user", content: "small" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "another" },
    ];
    let summarized = false;
    const r = await maybeCompact(messages, undefined, {
      contextWindow: 10000,
      maxOutputTokens: 1000,
      keepRecentTurns: 1,
      knownFloorTokens: 9000, // real occupancy the estimate can't see
      summarize: async () => {
        summarized = true;
        return "summary";
      },
    });
    expect(r.compacted).toBe(true);
    expect(summarized).toBe(true);
  });

  test("overheadTokens (tool schemas) counts toward the budget", async () => {
    const messages: Message[] = [
      { role: "user", content: "x".repeat(400) },
      { role: "assistant", content: "y".repeat(400) },
      { role: "user", content: "z".repeat(400) },
    ];
    // Without overhead this fits; the schema block pushes it over.
    const under = await maybeCompact(messages, undefined, {
      contextWindow: 4000, maxOutputTokens: 500, keepRecentTurns: 1, summarize: async () => "s",
    });
    expect(under.compacted).toBe(false);
    const over = await maybeCompact(messages, undefined, {
      contextWindow: 4000, maxOutputTokens: 500, keepRecentTurns: 1, overheadTokens: 3000,
      summarize: async () => "s",
    });
    expect(over.compacted).toBe(true);
  });
});
