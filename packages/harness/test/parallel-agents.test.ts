import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentSession } from "../src/loop/agent";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";
import { BackgroundAgents } from "../src/subagent/background";
import { createTaskTool, type SubagentRun } from "../src/subagent/task";

/**
 * The loop's concurrency gate, end to end: one assistant turn batching TWO Agent calls.
 * With read_only they must run via Promise.all (overlapping wall time); without it the
 * batch serializes (Agent is statically mutating). This is the CC-parity fan-out.
 */
const cwd = mkdtempSync(join(tmpdir(), "yodex-par-"));

function textDone(s: string): ModelResult {
  return {
    model: "test",
    message: { role: "assistant", content: [{ type: "text", text: s }] },
    usage: { input_tokens: 1, output_tokens: 1 },
    stopReason: "end_turn",
  };
}

function batchModel(readOnly: boolean): ModelClient {
  let turn = 0;
  return {
    async *stream(): AsyncGenerator<never, ModelResult, void> {
      turn++;
      if (turn > 1) return textDone("done");
      return {
        model: "test",
        message: {
          role: "assistant",
          content: [1, 2].map((n) => ({
            type: "tool_use" as const,
            id: `tu_${n}`,
            name: "Agent",
            input: { description: `child ${n}`, prompt: "go", ...(readOnly ? { read_only: true } : {}) },
          })),
        },
        usage: { input_tokens: 1, output_tokens: 1 },
        stopReason: "tool_use",
      };
    },
  };
}

async function runBatch(readOnly: boolean): Promise<{ wall: number; startGap: number }> {
  const starts: number[] = [];
  const runner: SubagentRun = async () => {
    starts.push(Date.now());
    await new Promise((r) => setTimeout(r, 120));
    return { text: "ok", sessionId: crypto.randomUUID() };
  };
  const tools = new ToolRegistry();
  tools.register(createTaskTool(runner, [], new BackgroundAgents()));
  const sess = new AgentSession({
    agentId: "ag1",
    sessionId: `s-${readOnly}`,
    workspace: "w",
    cwd,
    model: "test",
    systemPrompt: "test",
    tools,
    store: new LocalStore(mkdtempSync(join(tmpdir(), "yodex-par-store-"))),
    model_client: batchModel(readOnly),
    canUseTool: createPolicy({ mode: "autopilot" }),
    maxTurns: 3,
  });
  const t0 = Date.now();
  for await (const _e of sess.run({ text: "fan out" })) void _e;
  return { wall: Date.now() - t0, startGap: Math.abs(starts[0]! - starts[1]!) };
}

describe("loop concurrency gate × Agent batches", () => {
  test("read_only batch runs in parallel", async () => {
    const { wall, startGap } = await runBatch(true);
    expect(startGap).toBeLessThan(60); // both children started together
    expect(wall).toBeLessThan(230); // serial would be ≥240
  });

  test("write-capable batch stays serialized", async () => {
    const { startGap } = await runBatch(false);
    expect(startGap).toBeGreaterThanOrEqual(100); // second child waited for the first
  });
});
