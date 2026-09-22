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

  test("needs_approval => approval_pending (the d11.3 invariant)", () => {
    expect(classifyFailure("needs_approval")).toBe("approval_pending");
  });
});

const baseInput: RunOutcomeInput = {
  hop: { name: "coding", version: "1.0.0" },
  repo: "my-repo",
  model: "claude-opus-5",
  tier: "frontier",
  role: "main",
  runId: "run-1",
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
      contract: "d11.8",
      action_type: "run.completed",
      scope_id: "my-repo",
      occurred_at: "2026-09-01T00:00:00.000Z",
      payload: {
        hop: { name: "coding", version: "1.0.0" },
        repo: "my-repo",
        model: "claude-opus-5",
        tier: "frontier",
        role: "main",
        run_id: "run-1",
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
    expect(TELEMETRY_CONTRACT_VERSION).toBe("d11.8");
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

  test("d11.5: memories_injected rides on the payload when given, absent otherwise", () => {
    const withMem = buildRunOutcome({ ...baseInput, memoriesInjected: ["e1", "e2"] });
    expect(withMem.payload.memories_injected).toEqual(["e1", "e2"]);
    expect("memories_injected" in buildRunOutcome(baseInput).payload).toBe(false);
  });

  test("d11.7: tool_calls (names → counts) rides on the payload when given, absent otherwise", () => {
    const withCalls = buildRunOutcome({ ...baseInput, toolCalls: { Bash: 3, mcp__memory__memory_search: 2 } });
    expect(withCalls.payload.tool_calls).toEqual({ Bash: 3, mcp__memory__memory_search: 2 });
    expect("tool_calls" in buildRunOutcome(baseInput).payload).toBe(false);
  });

  test("d11.6: memory_projection (counts only) rides on the payload when given, absent otherwise", () => {
    const stat = { fact_count: 7, estimated_tokens: 900, truncated: true };
    expect(buildRunOutcome({ ...baseInput, memoryProjection: stat }).payload.memory_projection).toEqual(stat);
    expect("memory_projection" in buildRunOutcome(baseInput).payload).toBe(false);
  });

  test("d11.4: a sub-agent run carries role + parent_run_id; a main run omits parent_run_id", () => {
    const child = buildRunOutcome({ ...baseInput, role: "subagent", runId: "run-2", parentRunId: "run-1" });
    expect(child.payload).toMatchObject({ role: "subagent", run_id: "run-2", parent_run_id: "run-1" });
    expect("parent_run_id" in buildRunOutcome(baseInput).payload).toBe(false);
  });

  test("carries feedback_outcome only when provided", () => {
    const ev = buildRunOutcome({ ...baseInput, feedbackOutcome: "escalated" });
    expect(ev.payload.feedback_outcome).toBe("escalated");
  });

  test("serializes to JSON with no undefined keys (a clean wire envelope)", () => {
    const ev = buildRunOutcome({ ...baseInput, tier: undefined });
    const round = JSON.parse(JSON.stringify(ev));
    expect(round.payload).not.toHaveProperty("tier");
    expect(round.contract).toBe("d11.8");
  });
});


import { providerOfCommand } from "../src/telemetry/contract";

describe("d11.8 provider labels", () => {
  test("the label is the first real word of a command, never the command", () => {
    expect(providerOfCommand("aws s3 ls s3://bucket")).toBe("aws");
    expect(providerOfCommand("AWS_PROFILE=prod kubectl get pods -A")).toBe("kubectl");
    expect(providerOfCommand("sudo /usr/local/bin/gcloud auth list")).toBe("gcloud");
    expect(providerOfCommand("cat results/tune/turn.log")).toBeUndefined();
    expect(providerOfCommand("")).toBeUndefined();
  });
  test("labels ride the record only when a provider was called", () => {
    const base = {
      hop: { name: "infra-ro", version: "0.3.1" }, repo: "infra", model: "m", role: "main" as const, runId: "r", taskType: "infra",
      runResult: "success" as const, failureClass: null, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, wallMs: 1, turns: 1,
      checks: { selfCheckFired: false, antiChurnFired: false, observeRan: false, observePassed: false, agentVerdict: null },
    };
    expect(buildRunOutcome({ ...base, labels: { aws: 3 } }).payload.labels).toEqual({ aws: 3 });
    expect(buildRunOutcome({ ...base, labels: {} }).payload.labels).toBeUndefined();
    expect(buildRunOutcome(base).payload.labels).toBeUndefined();
  });
});
