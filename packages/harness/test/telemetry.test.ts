import { describe, expect, test } from "bun:test";
import {
  buildRunOutcome,
  classifyFailure,
  type RunOutcomeInput,
  TELEMETRY_CONTRACT_VERSION,
} from "../src/telemetry/contract";

/** A GatewayError-shaped object without importing the class (the contract duck-types on .name). */
function gatewayError(): unknown {
  const e = new Error("boom");
  e.name = "GatewayError";
  return e;
}

describe("classifyFailure", () => {
  test("success => null (the null-iff-success invariant)", () => {
    expect(classifyFailure("success")).toBeNull();
    expect(classifyFailure("success", gatewayError())).toBeNull();
  });

  test("max_turns => step_budget_stall", () => {
    expect(classifyFailure("max_turns")).toBe("step_budget_stall");
  });

  test("cancelled => user_cancelled", () => {
    expect(classifyFailure("cancelled")).toBe("user_cancelled");
  });

  test("error with a GatewayError => gateway_error", () => {
    expect(classifyFailure("error", gatewayError())).toBe("gateway_error");
  });

  test("error with a non-gateway throw => other, never a guessed bucket", () => {
    expect(classifyFailure("error", new Error("nope"))).toBe("other");
    expect(classifyFailure("error")).toBe("other");
    expect(classifyFailure("error", "a string")).toBe("other");
  });
});

const baseInput: RunOutcomeInput = {
  hop: { name: "coding", version: "1.0.0" },
  repo: "my-repo",
  model: "claude-opus-5",
  tier: "frontier",
  taskType: "coding",
  runResult: "success",
  failureClass: null,
  tokens: { input: 100, output: 50, cacheRead: 10, cacheCreation: 5 },
  wallMs: 1234,
  turns: 7,
  checks: {
    selfCheckFired: true,
    antiChurnFired: false,
    observeRan: true,
    observePassed: true,
    agentVerdict: "PASS",
  },
  occurredAt: "2026-09-01T00:00:00.000Z",
};

describe("buildRunOutcome", () => {
  test("produces the exact D11.2 wire shape (snake_case, allowlisted, content-free)", () => {
    const ev = buildRunOutcome(baseInput);
    expect(ev).toEqual({
      contract: "d11.2",
      action_type: "run.completed",
      scope_id: "my-repo",
      occurred_at: "2026-09-01T00:00:00.000Z",
      payload: {
        hop: { name: "coding", version: "1.0.0" },
        repo: "my-repo",
        model: "claude-opus-5",
        tier: "frontier",
        task_type: "coding",
        run_result: "success",
        failure_class: null,
        checks: {
          self_check: { fired: true },
          anti_churn: { fired: false },
          observe: { ran: true, passed: true },
          agent: { verdict: "PASS" },
        },
        tokens: { input: 100, output: 50, cache_read_input: 10, cache_creation_input: 5 },
        wall_ms: 1234,
        turns: 7,
      },
    });
  });

  test("contract discriminator is the frozen constant", () => {
    expect(buildRunOutcome(baseInput).contract).toBe(TELEMETRY_CONTRACT_VERSION);
    expect(TELEMETRY_CONTRACT_VERSION).toBe("d11.2");
  });

  test("tier and feedback_outcome are omitted when unset (absent != empty), verdict null kept", () => {
    const ev = buildRunOutcome({
      ...baseInput,
      tier: undefined,
      runResult: "max_turns",
      failureClass: "step_budget_stall",
      checks: { ...baseInput.checks, agentVerdict: null },
    });
    expect(ev.payload).not.toHaveProperty("tier");
    expect(ev.payload).not.toHaveProperty("feedback_outcome");
    expect(ev.payload.failure_class).toBe("step_budget_stall");
    expect(ev.payload.checks.agent).toEqual({ verdict: null });
  });

  test("carries feedback_outcome only when provided", () => {
    const ev = buildRunOutcome({ ...baseInput, feedbackOutcome: "escalated" });
    expect(ev.payload.feedback_outcome).toBe("escalated");
  });

  test("serializes to JSON with no undefined keys (a clean wire envelope)", () => {
    const ev = buildRunOutcome({ ...baseInput, tier: undefined });
    const round = JSON.parse(JSON.stringify(ev));
    expect(round.payload).not.toHaveProperty("tier");
    expect(round.contract).toBe("d11.2");
  });
});
