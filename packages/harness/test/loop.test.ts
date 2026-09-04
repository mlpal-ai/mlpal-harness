import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineEvent } from "@mlpal/harness-protocol";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import type { RunOutcomeEvent } from "../src/telemetry/contract";
import { MemoryMetrics } from "../src/obs/metrics";
import { ModelRouter } from "../src/routing/router";
import { createPolicy, type PermissionMode } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { defaultRegistry } from "../src/tools";
import { FunctionHook, HookEngine } from "../src/hooks/engine";
import { AgentSession, type AgentConfig } from "../src/loop/agent";
import { loadMessages } from "../src/loop/messages";

class ScriptedModel implements ModelClient {
  private i = 0;
  readonly seen: ModelRequest[] = [];
  constructor(private readonly scripts: ModelResult[]) {}
  async *stream(req: ModelRequest): AsyncGenerator<never, ModelResult, void> {
    this.seen.push(req);
    const r = this.scripts[this.i++];
    if (!r) throw new GatewayError("script exhausted", 500);
    return r;
  }
}

function toolUse(name: string, input: Record<string, unknown>): ModelResult {
  return {
    model: "test",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `tu_${name}_${crypto.randomUUID().slice(0, 6)}`, name, input }],
    },
    usage: { input_tokens: 10, output_tokens: 5 },
    stopReason: "tool_use",
  };
}

function multiToolUse(calls: { name: string; input: Record<string, unknown> }[]): ModelResult {
  return {
    model: "test",
    message: {
      role: "assistant",
      content: calls.map((c, i) => ({
        type: "tool_use" as const,
        id: `tu_${i}_${crypto.randomUUID().slice(0, 6)}`,
        name: c.name,
        input: c.input,
      })),
    },
    usage: { input_tokens: 10, output_tokens: 5 },
    stopReason: "tool_use",
  };
}

function textDone(text: string): ModelResult {
  return {
    model: "test",
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: { input_tokens: 8, output_tokens: 4 },
    stopReason: "end_turn",
  };
}

let root: string;
let cwd: string;

beforeEach(async () => {
  root = join(tmpdir(), `yodex-loop-${crypto.randomUUID()}`);
  cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function session(
  model: ModelClient,
  mode: PermissionMode,
  extra: Partial<AgentConfig> = {},
): AgentSession {
  return new AgentSession({
    agentId: "ag1",
    sessionId: "s1",
    workspace: "w",
    cwd,
    model: "test",
    systemPrompt: "You are a test.",
    tools: defaultRegistry(),
    store: new LocalStore(root),
    model_client: model,
    canUseTool: createPolicy({ mode }),
    ...extra,
  });
}

async function collect(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("agentic loop", () => {
  test("runs a tool then finishes, persisting the DAG", async () => {
    const model = new ScriptedModel([
      toolUse("Bash", { command: "echo hello-from-tool" }),
      textDone("All done."),
    ]);
    const sess = session(model, "autopilot"); // headless: command execution needs bypass
    const events = await collect(sess.run({ text: "do the thing" }));

    const types = events.map((e) => e.type);
    expect(types).toContain("system");
    expect(types).toContain("user");
    expect(types).toContain("assistant");
    expect(types).toContain("tool_result");
    expect(types).toContain("result");

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult && "content" in toolResult ? toolResult.content : "").toContain(
      "hello-from-tool",
    );
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");

    // second model call received the tool_result as a user message
    expect(model.seen.length).toBe(2);
    const secondCall = model.seen[1]!;
    const lastMsg = secondCall.messages.at(-1)!;
    expect(lastMsg.role).toBe("user");

    // store persisted the full DAG (system, user, assistant, tool_result, assistant)
    const entries = await new LocalStore(root).conversation.read("s1");
    expect(entries.length).toBe(5);
    expect(entries[0]!.parentUuid).toBeNull();
    expect(entries[1]!.parentUuid).toBe(entries[0]!.uuid);
  });

  test("HOP telemetry: a successful run emits one content-free run-outcome at the finish", async () => {
    const emitted: RunOutcomeEvent[] = [];
    const model = new ScriptedModel([toolUse("Bash", { command: "echo hi" }), textDone("done")]);
    const sess = session(model, "autopilot", {
      telemetry: {
        hop: { name: "coding", version: "1.2.3" },
        repo: "acme",
        resolveTier: () => "frontier",
        role: "main",
        emit: (e) => emitted.push(e),
      },
    });
    await collect(sess.run({ text: "go" }));

    expect(emitted).toHaveLength(1);
    const ev = emitted[0]!;
    expect(ev.contract).toBe("d11.4");
    expect(ev.action_type).toBe("run.completed");
    expect(ev.scope_id).toBe("acme");
    expect(ev.payload.hop).toEqual({ name: "coding", version: "1.2.3" });
    expect(ev.payload.run_result).toBe("success");
    expect(ev.payload.failure_class).toBeNull();
    expect(ev.payload.tier).toBe("frontier");
    expect(ev.payload.turns).toBeGreaterThan(0);
    expect(ev.payload.tokens.output).toBeGreaterThan(0);
    expect(typeof ev.payload.wall_ms).toBe("number");
    // echo is not a verify command in the coding vocab, so observe neither ran nor passed.
    expect(ev.payload.checks.observe).toEqual({ ran: false, passed: false });
  });

  test("HOP telemetry (d11.4): role, run_id, parent_run_id and the host task-type override are stamped", async () => {
    const emitted: RunOutcomeEvent[] = [];
    const model = new ScriptedModel([textDone("done")]);
    const sess = session(model, "autopilot", {
      telemetry: {
        hop: { name: "infra", version: "0.1.0" },
        repo: "acme",
        role: "subagent",
        parentRunId: "parent-run",
        taskType: "discover",
        sourceRef: "routine:watch",
        emit: (e) => emitted.push(e),
      },
    });
    await collect(sess.run({ text: "go" }));
    expect(emitted).toHaveLength(1);
    const p = emitted[0]!.payload;
    expect(p.role).toBe("subagent");
    expect(p.parent_run_id).toBe("parent-run");
    expect(typeof p.run_id).toBe("string");
    expect(p.run_id.length).toBeGreaterThan(0);
    expect(p.task_type).toBe("discover"); // host override beats the HOP's telemetry.taskType
    expect(emitted[0]!.source_ref).toBe("routine:watch"); // how the run began, envelope-level
  });

  test("onDecision observes the EFFECTIVE decision: headless ask refused, then a hard deny from policy", async () => {
    const seen: Array<{ command: unknown; behavior: string; via: string; source?: string }> = [];
    const model = new ScriptedModel([toolUse("Bash", { command: "kubectl set image deploy/x c=img" }), toolUse("Bash", { command: "rm -rf /" }), textDone("done")]);
    const sess = session(model, "cruise", {
      canUseTool: (req) => (String(req.input.command).startsWith("rm") ? { behavior: "deny", reason: "catastrophic", source: "hard_deny" } : { behavior: "ask" }),
      onDecision: (req, d, via) => seen.push({ command: req.input.command, behavior: d.behavior, via, source: d.behavior === "deny" ? d.source : undefined }),
    });
    await collect(sess.run({ text: "go" }));
    expect(seen).toEqual([
      { command: "kubectl set image deploy/x c=img", behavior: "deny", via: "headless_refused", source: "mode" },
      { command: "rm -rf /", behavior: "deny", via: "policy", source: "hard_deny" },
    ]);
  });

  test("onAsk receives the ask context: a safety edge carries its safetyReason", async () => {
    const seen: Array<{ command: unknown; safetyReason?: string; reason?: string }> = [];
    const model = new ScriptedModel([toolUse("Bash", { command: "terraform destroy" }), textDone("done")]);
    const sess = session(model, "cruise", {
      canUseTool: (req) =>
        req.toolName === "Bash"
          ? { behavior: "ask", reason: "destructive action requires approval", safetyReason: "needs_approval" }
          : { behavior: "allow" },
      onAsk: async (req, ask) => {
        seen.push({ command: req.input.command, safetyReason: ask.safetyReason, reason: ask.reason });
        return { behavior: "deny", reason: "declined at the edge" };
      },
    });
    await collect(sess.run({ text: "destroy it" }));
    expect(seen).toEqual([{ command: "terraform destroy", safetyReason: "needs_approval", reason: "destructive action requires approval" }]);
  });

  test("HOP telemetry: hitting max turns classes as step_budget_stall", async () => {
    const emitted: RunOutcomeEvent[] = [];
    const model = new ScriptedModel([toolUse("Bash", { command: "echo hi" }), textDone("done")]);
    const sess = session(model, "autopilot", {
      maxTurns: 1,
      telemetry: { hop: { name: "coding", version: "1.0.0" }, repo: "acme", role: "main", emit: (e) => emitted.push(e) },
    });
    await collect(sess.run({ text: "go" }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload.run_result).toBe("max_turns");
    expect(emitted[0]!.payload.failure_class).toBe("step_budget_stall");
    expect(emitted[0]!.payload).not.toHaveProperty("tier"); // no resolver => tier omitted
  });

  test("HOP telemetry: a throwing sink never breaks the run (fire-and-forget)", async () => {
    const model = new ScriptedModel([textDone("done")]);
    const sess = session(model, "autopilot", {
      telemetry: {
        hop: { name: "coding", version: "1.0.0" },
        repo: "acme",
        role: "main",
        emit: () => {
          throw new Error("sink down");
        },
      },
    });
    const events = await collect(sess.run({ text: "go" }));
    expect(events.find((e) => e.type === "result")).toBeDefined();
  });

  test("HOP safety: a headless safety-edge ask ENDS the run as needs_approval (park)", async () => {
    const emitted: RunOutcomeEvent[] = [];
    const model = new ScriptedModel([toolUse("Bash", { command: "terraform destroy" }), textDone("done")]);
    const sess = session(model, "cruise", {
      parkHeadless: true,
      canUseTool: (req) =>
        req.toolName === "Bash"
          ? { behavior: "ask", reason: "needs_approval: destructive", safetyReason: "needs_approval" }
          : { behavior: "allow" },
      telemetry: { hop: { name: "infra", version: "1.0.0" }, repo: "acme", role: "main", emit: (e) => emitted.push(e) },
    });
    const events = await collect(sess.run({ text: "destroy it" }));

    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("needs_approval");
    const pending = result && "pendingApproval" in result ? (result as { pendingApproval?: unknown }).pendingApproval : null;
    expect(pending).toMatchObject({ command: "terraform destroy", reason: "needs_approval" });
    // telemetry: needs_approval + approval_pending (d11.3 invariant, stamped d11.4)
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.payload.run_result).toBe("needs_approval");
    expect(emitted[0]!.payload.failure_class).toBe("approval_pending");
    expect(emitted[0]!.contract).toBe("d11.4");
  });

  test("HOP telemetry: no sink wired => no emit, unchanged behaviour", async () => {
    const model = new ScriptedModel([textDone("done")]);
    const events = await collect(session(model, "autopilot").run({ text: "go" }));
    expect(events.find((e) => e.type === "result")).toBeDefined();
  });

  test("plan mode denies a mutating tool; loop reports the denial and ends", async () => {
    const model = new ScriptedModel([
      toolUse("Write", { path: "x.txt", content: "nope" }),
      textDone("Understood, blocked."),
    ]);
    const events = await collect(session(model, "recon").run({ text: "write a file" }));
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr && "isError" in tr ? tr.isError : false).toBe(true);
    expect(tr && "content" in tr ? tr.content : "").toContain("Permission denied");
  });

  test("default mode (headless) denies an ask with a clear reason", async () => {
    const model = new ScriptedModel([
      toolUse("Bash", { command: "ls" }),
      textDone("ok"),
    ]);
    const events = await collect(session(model, "manual").run({ text: "list" }));
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr && "content" in tr ? tr.content : "").toContain("non-interactively");
  });

  test("runs read-only tools in parallel, preserving result order", async () => {
    await writeFile(join(cwd, "a.txt"), "AAA");
    await writeFile(join(cwd, "b.txt"), "BBB");
    const model = new ScriptedModel([
      multiToolUse([
        { name: "Read", input: { path: "a.txt" } },
        { name: "Read", input: { path: "b.txt" } },
      ]),
      textDone("read both"),
    ]);
    const events = await collect(session(model, "cruise").run({ text: "read them" }));
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(2);
    // order preserved: a.txt result first, b.txt second
    expect("content" in results[0]! ? results[0]!.content : "").toContain("AAA");
    expect("content" in results[1]! ? results[1]!.content : "").toContain("BBB");
  });

  test("a pre-aborted signal yields a cancelled result", async () => {
    const ac = new AbortController();
    ac.abort();
    const sess = new AgentSession({
      agentId: "ag1",
      sessionId: "s1",
      workspace: "w",
      cwd,
      model: "test",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: new ScriptedModel([textDone("never")]),
      canUseTool: createPolicy({ mode: "cruise" }),
      signal: ac.signal,
    });
    const events = await collect(sess.run({ text: "hi" }));
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("cancelled");
  });

  test("cancellation thrown mid-stream yields a cancelled result, not an error", async () => {
    class CancelModel implements ModelClient {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        throw new GatewayError("request cancelled", 0, "cancelled");
      }
    }
    const events = await collect(session(new CancelModel(), "cruise").run({ text: "go" }));
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("cancelled");
  });

  test("auto-compaction triggers during a long run", async () => {
    const metrics = new MemoryMetrics();
    let turn = 0;
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        if (req.system?.includes("compress a coding session")) return textDone("SUMMARY");
        turn += 1;
        if (turn <= 4) return toolUse("Bash", { command: `echo ${"x".repeat(2000)}` });
        return textDone("done");
      },
    };
    const sess = new AgentSession({
      agentId: "ag1",
      sessionId: "s1",
      workspace: "w",
      cwd,
      model: "test",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: model,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTokens: 200,
      contextWindow: 1500,
      compaction: { keepRecentTurns: 2 },
      metrics,
    });
    await collect(sess.run({ text: "start" }));
    const compactions = [...metrics.counters.entries()].filter(([k]) =>
      k.startsWith("agent.compactions"),
    );
    expect(compactions.length).toBeGreaterThan(0);
  });

  test("image tool results flow to the model as image blocks", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(cwd, "pic.png"), png);
    const model = new ScriptedModel([toolUse("Read", { path: "pic.png" }), textDone("I can see it")]);
    await collect(session(model, "cruise").run({ text: "look at pic.png" }));

    // the second model call's tool_result carries the image block
    const second = model.seen[1]!;
    const last = second.messages.at(-1)!;
    expect(last.role).toBe("user");
    const tr = (last.content as Array<{ type: string; content: unknown }>)[0]!;
    expect(tr.type).toBe("tool_result");
    const inner = tr.content as Array<{ type: string }>;
    expect(inner[0]!.type).toBe("image");
  });

  test("a PreToolUse hook can block a tool", async () => {
    const hooks = new HookEngine();
    hooks.register(
      new FunctionHook("noBash", ["PreToolUse"], (i) =>
        i.event === "PreToolUse" && i.toolName === "Bash"
          ? { block: true, reason: "bash is not allowed here" }
          : {},
      ),
    );
    const model = new ScriptedModel([toolUse("Bash", { command: "rm -rf /" }), textDone("ok")]);
    const events = await collect(session(model, "cruise", { hooks }).run({ text: "go" }));
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr && "isError" in tr ? tr.isError : false).toBe(true);
    expect(tr && "content" in tr ? tr.content : "").toContain("Blocked by hook");
  });

  test("a correlated handoff request is auto-answered on its correlationId channel", async () => {
    const store = new LocalStore(root);
    // Another repo's agent posts a task to this session, tagged with a private reply channel.
    await store.mailbox.post("s1", {
      type: "peer_message",
      from: { type: "agent", id: "repo-a" },
      toSession: "s1",
      text: "Add a /health route.",
      correlationId: "corr-123",
    });
    const sess = new AgentSession({
      agentId: "repo-b",
      sessionId: "s1",
      workspace: "backend",
      cwd,
      model: "test",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store,
      model_client: new ScriptedModel([
        textDone("On it."), // first finish → drains the handoff, continues
        textDone("Done — added GET /health to app.py."), // real work report
      ]),
      canUseTool: createPolicy({ mode: "autopilot" }),
    });
    await collect(sess.run({ text: "start working" }));

    // the reply landed on the correlationId channel with the agent's final report
    const reply = await store.mailbox.drain("corr-123");
    expect(reply.length).toBe(1);
    expect(reply[0]!.text).toContain("GET /health");
    expect(reply[0]!.correlationId).toBe("corr-123");
  });

  test("a Stop hook forces continuation (verifier loop), then allows done", async () => {
    let stopCalls = 0;
    const hooks = new HookEngine();
    hooks.register(
      new FunctionHook("verify", ["Stop"], () => {
        stopCalls += 1;
        return stopCalls === 1 ? { block: true, reason: "tests not run yet" } : {};
      }),
    );
    const model = new ScriptedModel([textDone("I think I'm done"), textDone("Now actually done")]);
    const events = await collect(session(model, "cruise", { hooks }).run({ text: "build it" }));

    // a system-authored continuation was injected
    const injected = events.find(
      (e) => e.type === "user" && "author" in e && e.author.type === "system",
    );
    expect(injected).toBeTruthy();
    expect(stopCalls).toBe(2);
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
  });

  test("difficulty ladder climbs one rung per verifier block, then settles", async () => {
    const seenModels: string[] = [];
    const feedback: { model: string; task_type: string; outcome: string; escalated_to?: string }[] = [];
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        seenModels.push(req.model);
        return textDone("attempt");
      },
      postFeedback(fb) {
        feedback.push(fb);
      },
    };
    let stopCalls = 0;
    const hooks = new HookEngine();
    hooks.register(
      new FunctionHook("verify", ["Stop"], () => {
        stopCalls += 1;
        return stopCalls <= 2 ? { block: true, reason: "not passing yet" } : {};
      }),
    );
    const events = await collect(
      session(model, "cruise", {
        hooks,
        escalation: ["cheap", "mid", "strong"],
        escalationPatience: 1, // climb on each block
      }).run({ text: "hard task" }),
    );

    // rung 0 (cheap) → block → rung 1 (mid) → block → rung 2 (strong) → pass
    expect(seenModels).toEqual(["cheap", "mid", "strong"]);
    // the escalation is surfaced in the injected verification note
    const notes = events
      .filter((e) => e.type === "user" && "author" in e && e.author.type === "system")
      .map((e) => (e.type === "user" && typeof e.message.content === "string" ? e.message.content : ""));
    expect(notes.some((n) => n.includes("Escalating to a stronger model (mid)"))).toBe(true);
    expect(notes.some((n) => n.includes("Escalating to a stronger model (strong)"))).toBe(true);
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
    // each climb reports an escalated outcome: the failed rung → the model it climbed to
    expect(feedback).toEqual([
      { model: "cheap", task_type: "coding", outcome: "escalated", escalated_to: "mid" },
      { model: "mid", task_type: "coding", outcome: "escalated", escalated_to: "strong" },
    ]);
  });

  test("classifyStart begins on the classifier's chosen rung", async () => {
    const seenModels: string[] = [];
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        // the classifier call carries a routing system prompt; answer it with a rung
        if (req.system?.includes("route a coding task")) {
          seenModels.push(`classify:${req.model}`);
          return textDone('{"rung": 1, "why": "hard"}');
        }
        seenModels.push(req.model);
        return textDone("done");
      },
    };
    const router = new ModelRouter({ main: "strong", classify: "cheap-classifier" });
    const events = await collect(
      session(model, "cruise", {
        router,
        escalation: ["cheap", "strong"],
        classifyStart: true,
      }).run({ text: "a hard task" }),
    );
    // classifier ran on the cheap classify model, then the loop started on rung 1 (strong)
    expect(seenModels[0]).toBe("classify:cheap-classifier");
    expect(seenModels[1]).toBe("strong");
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
  });

  test("patience lets a rung retry before escalating (cheap self-corrects)", async () => {
    const seenModels: string[] = [];
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        seenModels.push(req.model);
        return textDone("attempt");
      },
    };
    let stopCalls = 0;
    const hooks = new HookEngine();
    hooks.register(
      new FunctionHook("verify", ["Stop"], () => {
        stopCalls += 1;
        // cheap fails once, fixes it on the retry — should never escalate
        return stopCalls === 1 ? { block: true, reason: "close, fix the edge case" } : {};
      }),
    );
    await collect(
      session(model, "cruise", {
        hooks,
        escalation: ["cheap", "strong"],
        escalationPatience: 2,
      }).run({ text: "task cheap can self-correct" }),
    );
    // both turns on cheap; the second block never came, so no escalation
    expect(seenModels).toEqual(["cheap", "cheap"]);
  });

  test("ladder does not climb past the top rung when the verifier keeps blocking", async () => {
    const seenModels: string[] = [];
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        seenModels.push(req.model);
        return textDone("attempt");
      },
    };
    const hooks = new HookEngine();
    hooks.register(new FunctionHook("verify", ["Stop"], () => ({ block: true, reason: "never done" })));
    await collect(
      session(model, "cruise", {
        hooks,
        escalation: ["cheap", "strong"],
        escalationPatience: 1,
        maxStopContinuations: 4,
      }).run({ text: "impossible" }),
    );
    // climbs cheap → strong, then stays on strong for remaining retries (never past top)
    expect(seenModels[0]).toBe("cheap");
    expect(seenModels[1]).toBe("strong");
    expect(seenModels.slice(1).every((m) => m === "strong")).toBe(true);
  });

  test("compaction routes to the cheap model while the loop uses the main", async () => {
    const seenModels: string[] = [];
    let turn = 0;
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        seenModels.push(req.model);
        if (req.system?.includes("compress a coding session")) return textDone("SUMMARY");
        turn += 1;
        if (turn <= 4) return toolUse("Bash", { command: `echo ${"x".repeat(2000)}` });
        return textDone("done");
      },
    };
    const sess = new AgentSession({
      agentId: "ag1",
      sessionId: "s1",
      workspace: "w",
      cwd,
      model: "main-model",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: model,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTokens: 200,
      contextWindow: 1500,
      compaction: { keepRecentTurns: 2 },
      router: new ModelRouter({ main: "main-model", summarize: "cheap-model" }),
    });
    await collect(sess.run({ text: "start" }));
    expect(seenModels).toContain("main-model"); // the loop
    expect(seenModels).toContain("cheap-model"); // compaction summary
  });

  test("SessionStart fires once on a new session and seeds injectContext", async () => {
    const starts: string[] = [];
    const hooks = new HookEngine();
    hooks.register(
      new FunctionHook("boot", ["SessionStart"], (input) => {
        starts.push((input as { source: string }).source);
        return { injectContext: "PROJECT STATUS: on branch main" };
      }),
    );
    const model = new ScriptedModel([textDone("hi"), textDone("hi again")]);
    const sess = session(model, "cruise", { hooks });

    const first = await collect(sess.run({ text: "turn one" }));
    // seeded as a system-authored turn ahead of the user's
    const seeded = first.find(
      (e) => e.type === "user" && "author" in e && e.author.type === "system",
    );
    expect(seeded && seeded.type === "user" && typeof seeded.message.content === "string"
      ? seeded.message.content : "").toContain("PROJECT STATUS");
    // the model actually saw it
    expect(JSON.stringify(model.seen[0]!.messages)).toContain("PROJECT STATUS");

    // a second turn on the SAME session does not re-fire SessionStart
    await collect(sess.run({ text: "turn two" }));
    expect(starts).toEqual(["startup"]);
  });

  test("end() fires SessionEnd hooks", async () => {
    const ends: string[] = [];
    const hooks = new HookEngine();
    hooks.register(
      new FunctionHook("bye", ["SessionEnd"], (input) => {
        ends.push((input as { reason: string }).reason);
        return {};
      }),
    );
    const sess = session(new ScriptedModel([textDone("ok")]), "cruise", { hooks });
    await sess.end("exit");
    expect(ends).toEqual(["exit"]);
  });

  test("PreCompact fires when the loop compacts", async () => {
    const pre: number[] = [];
    const hooks = new HookEngine();
    hooks.register(
      new FunctionHook("snap", ["PreCompact"], (input) => {
        pre.push((input as { messageCount: number }).messageCount);
        return {};
      }),
    );
    let turn = 0;
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        if (req.system?.includes("compress a coding session")) return textDone("SUMMARY");
        turn += 1;
        if (turn <= 4) return toolUse("Bash", { command: `echo ${"x".repeat(2000)}` });
        return textDone("done");
      },
    };
    const sess = new AgentSession({
      agentId: "ag1",
      sessionId: "s1",
      workspace: "w",
      cwd,
      model: "main-model",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: model,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTokens: 200,
      contextWindow: 1500,
      compaction: { keepRecentTurns: 2 },
      hooks,
      router: new ModelRouter({ main: "main-model", summarize: "cheap-model" }),
    });
    await collect(sess.run({ text: "start" }));
    expect(pre.length).toBeGreaterThan(0); // PreCompact fired before compaction
  });

  test("abort during a stuck tool returns control immediately (Ctrl-C can't be trapped)", async () => {
    const { defineTool } = await import("../src/tools/types");
    const { z } = await import("zod");
    const tools = defaultRegistry();
    tools.register(
      defineTool({
        name: "Stuck",
        description: "never resolves",
        readOnly: true,
        schema: z.object({}),
        call: () => new Promise(() => {}), // ignores signals forever
      }) as never,
    );
    const ac = new AbortController();
    const model = new ScriptedModel([toolUse("Stuck", {}), textDone("never reached")]);
    const sess = session(model, "autopilot", { tools, signal: ac.signal });

    setTimeout(() => ac.abort(), 100); // user hits Ctrl-C while the tool is stuck
    const t0 = Date.now();
    const events = await collect(sess.run({ text: "go" }));
    expect(Date.now() - t0).toBeLessThan(2000); // returned promptly, not hung
    const tr = events.find((e) => e.type === "tool_result");
    expect(tr && "content" in tr ? tr.content : "").toContain("interrupted");
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("cancelled");
  });

  test("max_turns guard fires", async () => {
    // a model that always asks for a tool would loop forever; cap it
    const looping = new ScriptedModel(Array.from({ length: 60 }, () => toolUse("Bash", { command: "echo x" })));
    const sess = new AgentSession({
      agentId: "ag1",
      sessionId: "s1",
      workspace: "w",
      cwd,
      model: "test",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: looping,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTurns: 3,
    });
    const events = await collect(sess.run({ text: "loop" }));
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("max_turns");
  });

  // Count injected "[Self-check]" nudges among the emitted events.
  const nudgeCount = (events: EngineEvent[]): number =>
    events.filter(
      (e) =>
        e.type === "user" &&
        typeof (e as { message?: { content?: unknown } }).message?.content === "string" &&
        ((e as { message: { content: string } }).message.content).includes("[Self-check]"),
    ).length;

  test("completion self-check fires once after >=3 edits with no verification", async () => {
    const model = new ScriptedModel([
      toolUse("Write", { path: "a.txt", content: "1" }),
      toolUse("Write", { path: "b.txt", content: "2" }),
      toolUse("Write", { path: "c.txt", content: "3" }),
      textDone("all done"), // enters DONE -> self-check fires and forces one more turn
      textDone("couldn't run tests here; finishing"), // selfCheckFired -> finishes
    ]);
    const events = await collect(session(model, "autopilot").run({ text: "edit three files" }));
    expect(nudgeCount(events)).toBe(1);
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
  });

  test("self-check stays quiet when a verification command ran", async () => {
    const model = new ScriptedModel([
      toolUse("Write", { path: "a.txt", content: "1" }),
      toolUse("Write", { path: "b.txt", content: "2" }),
      toolUse("Write", { path: "c.txt", content: "3" }),
      // matches VERIFY_CMD_RE, succeeds, no env-broken markers -> counts as verification
      toolUse("Bash", { command: 'echo "pytest: 3 passed"' }),
      textDone("ran the tests, all green"),
    ]);
    const events = await collect(session(model, "autopilot").run({ text: "edit then test" }));
    expect(nudgeCount(events)).toBe(0);
  });

  test("self-check ignores a check that couldn't run (env-broken output)", async () => {
    const model = new ScriptedModel([
      toolUse("Write", { path: "a.txt", content: "1" }),
      toolUse("Write", { path: "b.txt", content: "2" }),
      toolUse("Write", { path: "c.txt", content: "3" }),
      // matches VERIFY_CMD_RE but the check never actually ran -> NOT verification
      toolUse("Bash", { command: 'echo "No module named pytest"' }),
      textDone("tried to test but couldn't"),
      textDone("finishing after the nudge"),
    ]);
    const events = await collect(session(model, "autopilot").run({ text: "edit, broken test" }));
    expect(nudgeCount(events)).toBe(1); // env-broken check doesn't suppress the self-check
  });

  test("self-check stays quiet below the edit threshold", async () => {
    const model = new ScriptedModel([
      toolUse("Write", { path: "a.txt", content: "1" }),
      toolUse("Write", { path: "b.txt", content: "2" }),
      textDone("two small edits, done"),
    ]);
    const events = await collect(session(model, "autopilot").run({ text: "two edits" }));
    expect(nudgeCount(events)).toBe(0);
  });

  test("self-check can be disabled via config", async () => {
    const model = new ScriptedModel([
      toolUse("Write", { path: "a.txt", content: "1" }),
      toolUse("Write", { path: "b.txt", content: "2" }),
      toolUse("Write", { path: "c.txt", content: "3" }),
      textDone("done, no nudge expected"),
    ]);
    const events = await collect(
      session(model, "autopilot", { selfCheck: false }).run({ text: "edits, check off" }),
    );
    expect(nudgeCount(events)).toBe(0);
  });

  // The anti-churn nudge is folded into a tool-results turn (not a standalone event), so detect
  // it in what the model was actually sent.
  const sawChurnNote = (model: ScriptedModel): boolean =>
    model.seen.some((req) => JSON.stringify(req.messages).includes("[Anti-churn]"));

  test("anti-churn breaker fires after repeated edits to one file without verification", async () => {
    const model = new ScriptedModel([
      ...Array.from({ length: 6 }, (_, i) => toolUse("Write", { path: "same.py", content: `v${i}` })),
      textDone("finishing"),
    ]);
    await collect(session(model, "autopilot", { selfCheck: false }).run({ text: "keep editing one file" }));
    expect(sawChurnNote(model)).toBe(true);
  });

  test("anti-churn stays quiet when edits are spread across files", async () => {
    const model = new ScriptedModel([
      ...["a", "b", "c", "d", "e", "f"].map((f) => toolUse("Write", { path: `${f}.py`, content: "x" })),
      textDone("touched six different files, done"),
    ]);
    await collect(session(model, "autopilot", { selfCheck: false }).run({ text: "spread edits" }));
    expect(sawChurnNote(model)).toBe(false);
  });

  test("anti-churn fires on repeated edits even after a verification command (edit-count based)", async () => {
    // The breaker is deliberately NOT gated on verify-detection: a run can suppress a check's
    // stderr, so churn is judged purely by how many times one file is rewritten.
    const model = new ScriptedModel([
      toolUse("Bash", { command: 'echo "pytest: ok"' }),
      ...Array.from({ length: 6 }, (_, i) => toolUse("Write", { path: "same.py", content: `v${i}` })),
      textDone("edited a lot"),
    ]);
    await collect(session(model, "autopilot", { selfCheck: false }).run({ text: "edit with a check" }));
    expect(sawChurnNote(model)).toBe(true);
  });

  test("anti-churn can be disabled via config", async () => {
    const model = new ScriptedModel([
      ...Array.from({ length: 6 }, (_, i) => toolUse("Write", { path: "same.py", content: `v${i}` })),
      textDone("done, breaker off"),
    ]);
    await collect(
      session(model, "autopilot", { selfCheck: false, antiChurn: false }).run({ text: "churn but off" }),
    );
    expect(sawChurnNote(model)).toBe(false);
  });

  test("background-task notifications are injected at the finish boundary and force a continue", async () => {
    let calls = 0;
    const drain = () => (calls++ === 0 ? ["[background] Task bg1 (npm run build) finished. exit 0"] : []);
    const model = new ScriptedModel([
      textDone("looks done to me"), // boundary 1: a bg task just finished -> inject + continue
      textDone("acknowledged, finishing"), // boundary 2: nothing pending -> finish
    ]);
    const events = await collect(
      session(model, "autopilot", { drainBackgroundNotifications: drain }).run({ text: "kick off a build" }),
    );
    const injected = events.filter(
      (e) =>
        e.type === "user" &&
        typeof (e as { message?: { content?: unknown } }).message?.content === "string" &&
        ((e as { message: { content: string } }).message.content).includes("[background]"),
    );
    expect(injected.length).toBe(1);
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
  });

  test("condense shrinks a large tool output before the model sees it next turn", async () => {
    const model = new ScriptedModel([
      toolUse("Bash", { command: "printf 'BIGCHUNK%.0s' {1..40}" }), // 320 chars > threshold
      textDone("[condensed from 1 line] the gist"), // the condense side-call's response
      textDone("ok done"),
    ]);
    const sess = session(model, "autopilot", { condense: { threshold: 100, model: "test" } });
    await collect(sess.run({ text: "go" }));
    const turn2 = JSON.stringify(model.seen.at(-1)!.messages); // last request sees the condensed result
    expect(turn2).toContain("[condensed from 1 line]");
    expect(turn2).not.toContain("BIGCHUNKBIGCHUNK"); // raw output is not in the model's context
  });

  test("condense leaves a small output untouched", async () => {
    const model = new ScriptedModel([
      toolUse("Bash", { command: "echo small-output-here" }),
      textDone("done"),
    ]);
    const sess = session(model, "autopilot", { condense: { threshold: 100, model: "test" } });
    await collect(sess.run({ text: "go" }));
    expect(JSON.stringify(model.seen.at(-1)!.messages)).toContain("small-output-here");
  });

  test("a max_tokens-truncated response is resumed, not silently accepted", async () => {
    const truncated: ModelResult = {
      model: "test",
      message: { role: "assistant", content: [{ type: "text", text: "Here is the first half of the file" }] },
      usage: { input_tokens: 8, output_tokens: 16 },
      stopReason: "max_tokens",
    };
    const sess = session(new ScriptedModel([truncated, textDone("…and the rest. Done.")]), "autopilot");
    const events = await collect(sess.run({ text: "write the big file" }));

    // The run continued past the truncation and reached a clean success.
    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
    // A continuation nudge was injected as a user turn between the two model calls.
    const injected = events.some(
      (e) => e.type === "user" && typeof e.message.content === "string" && e.message.content.includes("[Output limit]"),
    );
    expect(injected).toBe(true);
  });

  test("listen loop: an idle worker picks up a handoff and auto-replies", async () => {
    const store = new LocalStore(root);
    const ac = new AbortController();
    const sess = new AgentSession({
      agentId: "worker",
      sessionId: "w1",
      workspace: "backend",
      cwd,
      model: "test",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store,
      model_client: new ScriptedModel([textDone("Done — added GET /health to app.py.")]),
      canUseTool: createPolicy({ mode: "autopilot" }),
    });

    // Drive the listen loop in the background; it should mark the session `listening`.
    const loop = (async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of sess.listen({ signal: ac.signal, pollMs: 15 })) {
        /* consume events */
      }
    })();
    await Bun.sleep(40);
    expect((await store.registry.getSession("w1"))?.status).toBe("listening");

    // A peer hands off work on a private reply channel; the idle worker should pick it up.
    await store.mailbox.post("w1", {
      type: "peer_message",
      from: { type: "agent", id: "repo-a" },
      toSession: "w1",
      text: "Add a /health route.",
      correlationId: "corr-listen",
    });

    let reply = await store.mailbox.drain("corr-listen");
    for (let i = 0; i < 100 && reply.length === 0; i++) {
      await Bun.sleep(15);
      reply = await store.mailbox.drain("corr-listen");
    }
    ac.abort();
    await loop;

    expect(reply.length).toBe(1);
    expect(reply[0]!.text).toContain("/health");
    expect(reply[0]!.correlationId).toBe("corr-listen");
    // Aborting the loop leaves the session idle (no longer a live-routing target).
    expect((await store.registry.getSession("w1"))?.status).toBe("idle");
  });
});

describe("mid-run steering", () => {
  // once() drains its contents on the first call and nothing after — mirrors the REPL queue,
  // whose splice(0) hands the run each steer exactly once.
  const once = (...items: string[]) => {
    const q = [...items];
    return () => q.splice(0);
  };

  test("a steer sent during a tool step folds into the tool-result turn and reaches the next call", async () => {
    const model = new ScriptedModel([
      toolUse("Bash", { command: "echo hi" }),
      textDone("done"),
    ]);
    const sess = session(model, "autopilot", { drainSteering: once("Also handle the empty case.") });
    const events = await collect(sess.run({ text: "build it" }));

    // the steer rides with the tool_result in ONE user message on the next model call
    const second = model.seen[1]!.messages.at(-1)!;
    expect(second.role).toBe("user");
    const blocks = second.content as { type: string; text?: string }[];
    expect(blocks.some((b) => b.type === "tool_result")).toBe(true);
    expect(blocks.some((b) => b.type === "text" && b.text?.includes("empty case"))).toBe(true);

    // it's persisted + yielded as a human-authored user turn (transcript shows what the user injected).
    // Two human turns exist — the initial prompt and the steer — so match the one carrying the steer.
    const humanTurns = events.filter(
      (e): e is Extract<EngineEvent, { type: "user" }> => e.type === "user" && e.author.type === "human",
    );
    expect(humanTurns.some((e) => JSON.stringify(e.message.content).includes("empty case"))).toBe(true);

    expect(events.find((e) => e.type === "result" && "subtype" in e && e.subtype === "success")).toBeTruthy();
  });

  test("the persisted steer reloads as one user turn — role alternation stays valid", async () => {
    const model = new ScriptedModel([toolUse("Bash", { command: "echo hi" }), textDone("done")]);
    const sess = session(model, "autopilot", { drainSteering: once("Rename the flag to --quiet.") });
    await collect(sess.run({ text: "build it" }));

    const reloaded = await loadMessages(new LocalStore(root), "s1");
    // no two consecutive user messages — the steer folded into the tool-result turn, not after it
    for (let i = 1; i < reloaded.length; i++) {
      expect(reloaded[i - 1]!.role === "user" && reloaded[i]!.role === "user").toBe(false);
    }
    // and that single folded turn carries both the tool result and the steer text
    const folded = reloaded.find(
      (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    const fb = folded!.content as { type: string; text?: string }[];
    expect(fb.some((b) => b.type === "text" && b.text?.includes("--quiet"))).toBe(true);
  });

  test("a steer sent as the agent wraps up continues the run instead of finishing", async () => {
    // No tool step — the model returns text (would stop), but a steer is waiting, so the run keeps going.
    const model = new ScriptedModel([textDone("I think I'm done."), textDone("Handled the extra ask.")]);
    const sess = session(model, "autopilot", { drainSteering: once("One more thing: add a --version flag.") });
    const events = await collect(sess.run({ text: "build it" }));

    // the steer was injected and the model ran a second time (didn't stop at the first text turn)
    expect(model.seen.length).toBe(2);
    expect(model.seen[1]!.messages.at(-1)!.content).toContain("--version");
    const humanTurns = events.filter((e) => e.type === "user" && e.author.type === "human");
    // the initial prompt + the steer, both human-authored
    expect(humanTurns.length).toBe(2);
  });

  test("no steering wired leaves the loop unchanged", async () => {
    const model = new ScriptedModel([textDone("done in one turn.")]);
    const sess = session(model, "autopilot"); // no drainSteering
    await collect(sess.run({ text: "build it" }));
    expect(model.seen.length).toBe(1); // stopped at the first text turn, no phantom continuation
  });
});
