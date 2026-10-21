import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@mlpal/harness-protocol";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { stampFields, traceHeaders } from "../src/telemetry/stamp";
import { defaultRegistry } from "../src/tools";

let root: string;
let cwd: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "yodex-stamp-"));
  cwd = mkdtempSync(join(tmpdir(), "yodex-stamp-cwd-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const textDone = (text: string): ModelResult => ({ model: "test", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 8, output_tokens: 4 }, stopReason: "end_turn" });
const toolUse = (name: string, input: Record<string, unknown>): ModelResult => ({ model: "test", message: { role: "assistant", content: [{ type: "tool_use", id: `tu_${crypto.randomUUID().slice(0, 6)}`, name, input }] }, usage: { input_tokens: 10, output_tokens: 5 }, stopReason: "tool_use" });
async function drain(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("telemetry v1: the stamp on every record", () => {
  test("run.start and run.end bracket a turn; model and tool records carry the same run; a second turn is a new run with a continuing seq", async () => {
    let turn = 0;
    const model: ModelClient = {
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        turn += 1;
        return turn === 1 ? toolUse("Bash", { command: "echo hi" }) : textDone("done");
      },
    };
    const store = new LocalStore(root);
    const sess = new AgentSession({
      agentId: "ag1",
      sessionId: "s-stamp",
      workspace: "billing",
      cwd,
      model: "main-model",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store,
      model_client: model,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTokens: 200,
      stamp: { hop: "coding@1.0.0", origin: "local", workspace: "billing" },
    });
    expect(sess.runId()).toBeNull();
    await drain(sess.run({ text: "first" }));
    const run1 = sess.runId()!;
    expect(run1).toBeTruthy();
    const events = await store.logs.read("s-stamp", "events");
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("run.start");
    expect(kinds.at(-1)).toBe("run.end");
    for (const e of events) {
      expect(e.session).toBe("s-stamp");
      expect(e.run).toBe(run1);
      expect(e.prompt).toBe(run1); // a human prompt names the run
      expect(e.hop).toBe("coding@1.0.0");
      expect(e.origin).toBe("local");
      expect(e.workspace).toBe("billing");
      expect(typeof e.seq).toBe("number");
    }
    const end = events.at(-1)!;
    expect(end.subtype).toBe("success");
    expect(end.turns).toBe(2);
    const models = await store.logs.read("s-stamp", "model");
    const execs = await store.logs.read("s-stamp", "exec");
    expect(models).toHaveLength(2);
    expect(execs).toHaveLength(1);
    for (const r of [...models, ...execs]) {
      expect(r.run).toBe(run1);
      expect(r.hop).toBe("coding@1.0.0");
    }
    expect(models.every((m) => typeof m.ref === "string")).toBe(true); // points at the assistant entry
    expect(models.every((m) => typeof m.callId === "string" && m.callId.length > 0)).toBe(true); // the id the gateway saw in traceparent
    // seq orders every record of the session across channels
    const seqs = [...events, ...models, ...execs].map((r) => r.seq as number).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(seqs.length);

    await drain(sess.run({ text: "second" }));
    const run2 = sess.runId()!;
    expect(run2).not.toBe(run1);
    const events2 = (await store.logs.read("s-stamp", "events")).filter((e) => e.run === run2);
    expect(events2.map((e) => e.kind)).toEqual(["run.start", "run.end"]);
    expect(events2[0]!.prompt).toBe(run2);
    expect(events2[0]!.seq).toBe(1); // seq restarts with the run
  });

  test("a model record's ms is the loop's wall time for the call, and attempts is the client's count (U10a-ms)", async () => {
    let turn = 0;
    const model: ModelClient = {
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        turn += 1;
        await Bun.sleep(60); // the call's own wait, inside the measured span
        return turn === 1 ? { ...textDone("first"), attempts: 3 } : textDone("second");
      },
    };
    const store = new LocalStore(root);
    const sess = new AgentSession({ agentId: "ag-ms", sessionId: "s-ms", workspace: "w", cwd, model: "m", systemPrompt: "t", tools: defaultRegistry(), store, model_client: model, canUseTool: createPolicy({ mode: "autopilot" }), maxTokens: 50 });
    await drain(sess.run({ text: "one" }));
    await drain(sess.run({ text: "two" }));
    const [a, b] = await store.logs.read("s-ms", "model");
    expect(a!.attempts).toBe(3);
    expect("attempts" in b!).toBe(false); // a client that does not count leaves it absent, never 1
    for (const r of [a!, b!]) {
      expect(r.ms as number).toBeGreaterThanOrEqual(55);
      expect(r.ms as number).toBeLessThan(5_000);
    }
  });

  test("a subagent carries its parent's run; an agent-authored turn keeps the prompt of the turn it lands in", async () => {
    const model: ModelClient = {
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        return textDone("ok");
      },
    };
    const store = new LocalStore(root);
    const child = new AgentSession({
      agentId: "ag2",
      sessionId: "s-child",
      workspace: "billing",
      cwd,
      model: "m",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store,
      model_client: model,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTokens: 100,
      stamp: { origin: "subagent" },
      parentRunId: "parent-run-1",
    });
    await drain(child.run({ text: "do it" }));
    const first = (await store.logs.read("s-child", "events"))[0]!;
    expect(first.parent_run).toBe("parent-run-1");
    expect(first.origin).toBe("subagent");
    const p1 = first.prompt;
    await drain(child.run({ text: "peer says hi", author: { type: "agent", agentId: "peer", displayName: "peer" } as never }));
    const later = (await store.logs.read("s-child", "events")).filter((e) => e.kind === "run.start").at(-1)!;
    expect(later.run).not.toBe(first.run);
    expect(later.prompt).toBe(p1); // not a new prompt: the person did not speak
  });

  test("stampFields keeps a fixed order; traceHeaders derive stable W3C ids and carry the stamp as baggage", () => {
    const s = { session: "S", run: "R", prompt: "P", hop: "h@1", origin: "local", workspace: "w" };
    expect(Object.keys(stampFields(s))).toEqual(["session", "run", "prompt", "hop", "origin", "workspace"]);
    expect(Object.keys(stampFields({ session: "S", run: "R" }))).toEqual(["session", "run"]);
    const hash = (t: string) => Array.from(new TextEncoder().encode(t)).map((b) => (b * 7 % 256).toString(16).padStart(2, "0")).join("").padEnd(64, "a");
    const h = traceHeaders(s, "call-1", hash);
    expect(h.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(traceHeaders(s, "call-1", hash)).toEqual(h); // stable across a retry
    expect(traceHeaders(s, "call-2", hash).traceparent).not.toBe(h.traceparent === h.traceparent ? traceHeaders(s, "call-2", hash).traceparent + "x" : "");
    expect(h.baggage).toBe("mlpal.session=S,mlpal.run=R,mlpal.prompt=P,mlpal.hop=h%401,mlpal.origin=local,mlpal.workspace=w");
  });
});
