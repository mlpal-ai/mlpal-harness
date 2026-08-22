import { describe, expect, test } from "bun:test";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { classifyStartRung } from "../src/routing/classifier";

function fakeModel(reply: string, onReq?: (model: string) => void): ModelClient {
  return {
    async *stream(req): AsyncGenerator<never, ModelResult, void> {
      onReq?.(req.model);
      return {
        model: req.model,
        message: { role: "assistant", content: [{ type: "text", text: reply }] },
        usage: { input_tokens: 5, output_tokens: 3 },
        stopReason: "end_turn",
      };
    },
  };
}

describe("classifyStartRung", () => {
  test("returns the classifier's rung, clamped to the ladder", async () => {
    const r = await classifyStartRung({
      model_client: fakeModel('{"rung": 2, "why": "tricky recursion"}'),
      model: "cheap",
      task: "implement a parser with precedence",
      rungs: 3,
    });
    expect(r).toBe(2);
  });

  test("clamps an out-of-range rung to the top", async () => {
    const r = await classifyStartRung({
      model_client: fakeModel('{"rung": 9}'),
      model: "cheap",
      task: "very hard",
      rungs: 3,
    });
    expect(r).toBe(2);
  });

  test("uses the cheap classify model, not a ladder model", async () => {
    let usedModel = "";
    await classifyStartRung({
      model_client: fakeModel('{"rung": 1}', (m) => (usedModel = m)),
      model: "cheap-classifier",
      task: "do a thing",
      rungs: 2,
    });
    expect(usedModel).toBe("cheap-classifier");
  });

  test("fails safe to rung 0 on an unparseable reply", async () => {
    const r = await classifyStartRung({
      model_client: fakeModel("I cannot produce JSON"),
      model: "cheap",
      task: "anything",
      rungs: 3,
    });
    expect(r).toBe(0);
  });

  test("fails safe to rung 0 when the classifier throws", async () => {
    const boom: ModelClient = {
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        throw new Error("gateway down");
      },
    };
    const r = await classifyStartRung({ model_client: boom, model: "cheap", task: "x", rungs: 3 });
    expect(r).toBe(0);
  });

  test("short-circuits (no call) for a single-rung ladder or empty task", async () => {
    let called = false;
    const spy = fakeModel('{"rung": 2}', () => (called = true));
    expect(await classifyStartRung({ model_client: spy, model: "c", task: "x", rungs: 1 })).toBe(0);
    expect(await classifyStartRung({ model_client: spy, model: "c", task: "   ", rungs: 3 })).toBe(0);
    expect(called).toBe(false);
  });
});
