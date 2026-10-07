import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@mlpal/harness-protocol";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { clipHookResult, FilteredHook, FunctionHook, HOOK_OUTPUT_CAP, HookEngine, HttpHook, matchesWhen, PromptHook, registerPluginHooks } from "../src/hooks/engine";
import type { HookInput } from "../src/hooks/types";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { createTaskTool } from "../src/subagent/task";
import { defaultRegistry } from "../src/tools";

let root: string;
let cwd: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "yodex-hooks2-"));
  cwd = mkdtempSync(join(tmpdir(), "yodex-hooks2-cwd-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const ctx = { sessionId: "s", agentId: "a", cwd: "/w" };
const textDone = (text: string): ModelResult => ({ model: "m", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" });
const toolUse = (name: string, input: Record<string, unknown>): ModelResult => ({ model: "m", message: { role: "assistant", content: [{ type: "tool_use", id: `tu_${crypto.randomUUID().slice(0, 6)}`, name, input }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use" });
async function drain(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("hooks v2: kinds, filters, clipping, the plugin api", () => {
  test("when filters match on tool name, a command regex, error state, kind and agent type; unknown fields never match", () => {
    const pre: HookInput = { event: "PreToolUse", toolName: "Bash", input: { command: "git push origin main" } };
    expect(matchesWhen(undefined, pre)).toBe(true);
    expect(matchesWhen({ toolName: "Bash" }, pre)).toBe(true);
    expect(matchesWhen({ toolName: ["Edit", "Write"] }, pre)).toBe(false);
    expect(matchesWhen({ command: "^git push" }, pre)).toBe(true);
    expect(matchesWhen({ command: "^git pull" }, pre)).toBe(false);
    expect(matchesWhen({ command: "[" }, pre)).toBe(false); // a bad regex never matches
    expect(matchesWhen({ isError: true }, { event: "PostToolUse", toolName: "Bash", input: {}, result: "", isError: true })).toBe(true);
    expect(matchesWhen({ isError: true }, pre)).toBe(false);
    expect(matchesWhen({ kind: ["needs_approval"] }, { event: "Notification", kind: "needs_approval", message: "" })).toBe(true);
    expect(matchesWhen({ agentType: "reviewer" }, { event: "SubagentStart", description: "d", agentType: "reviewer", background: false })).toBe(true);
    expect(matchesWhen({ prompt: "deploy" }, { event: "UserPromptSubmit", prompt: "please deploy" })).toBe(true);
    const seen: string[] = [];
    const filtered = new FilteredHook(new FunctionHook("f", ["PreToolUse"], (i) => (seen.push((i as { toolName: string }).toolName), { block: true })), { toolName: "Bash" });
    expect(filtered.run({ event: "PreToolUse", toolName: "Edit", input: {} }, ctx)).resolves.toEqual({});
    expect(filtered.run(pre, ctx)).resolves.toEqual({ block: true });
  });

  test("hook output is clipped at the cap, with a marker", () => {
    const long = "x".repeat(HOOK_OUTPUT_CAP + 100);
    const r = clipHookResult({ injectContext: long, reason: "short", updatedPrompt: long });
    expect(r.injectContext!.length).toBeLessThan(HOOK_OUTPUT_CAP + 80);
    expect(r.injectContext).toContain("[hook output clipped at");
    expect(r.reason).toBe("short");
    expect(r.updatedPrompt).toContain("clipped");
  });

  test("an http hook posts the event with the context and reads a result; a failure is a no-op, not an error", async () => {
    const seen: { url: string; body: Record<string, unknown>; auth?: string }[] = [];
    let fail = false;
    const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      seen.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      if (fail) return new Response("down", { status: 503 });
      return new Response(JSON.stringify({ block: true, reason: "policy says no" }), { status: 200 });
    }) as unknown as typeof fetch;
    const hook = new HttpHook("h", ["PreToolUse"], "https://hooks.example/check", { headers: { authorization: "Bearer t" }, fetchImpl });
    const r = await hook.run({ event: "PreToolUse", toolName: "Bash", input: { command: "rm -rf /" } }, { ...ctx, runId: "run-1" });
    expect(r).toEqual({ block: true, reason: "policy says no" });
    expect(seen[0]!.body).toMatchObject({ event: "PreToolUse", toolName: "Bash", context: { sessionId: "s", runId: "run-1" } });
    expect(seen[0]!.auth).toBe("Bearer t");
    fail = true;
    expect(await hook.run({ event: "PreToolUse", toolName: "Bash", input: {} }, ctx)).toEqual({});
  });

  test("a prompt hook asks a cheap model and blocks only on a clear yes; malformed answers are no-ops", async () => {
    let answer = '{"block": true, "reason": "push to main is forbidden by the rule"}';
    const seen: string[] = [];
    const client: Pick<ModelClient, "stream"> = {
      async *stream(req) {
        seen.push(String(req.messages[0]!.content));
        return textDone(answer);
      },
    };
    const hook = new PromptHook("p", ["PreToolUse"], "block any git push to main", { client, model: "cheap" });
    const blocked = await hook.run({ event: "PreToolUse", toolName: "Bash", input: { command: "git push origin main" } }, ctx);
    expect(blocked).toEqual({ block: true, reason: "push to main is forbidden by the rule" });
    expect(seen[0]).toContain("Rule: block any git push to main");
    answer = '{"block": false}';
    expect(await hook.run({ event: "PreToolUse", toolName: "Bash", input: { command: "ls" } }, ctx)).toEqual({});
    answer = "I am not sure";
    expect(await hook.run({ event: "PreToolUse", toolName: "Bash", input: { command: "ls" } }, ctx)).toEqual({});
  });

  test("the plugin api registers handlers as hooks: on(event) and tool.check", async () => {
    const engine = new HookEngine();
    const n = await registerPluginHooks(engine, "guard", (api) => {
      api.tool.check((tool) => (tool.name === "Bash" && String(tool.input.command).includes("rm -rf") ? { block: true, reason: "guard: no rm -rf" } : {}));
      api.on("Notification", (input) => ({ injectContext: `noted ${input.kind}` }));
    });
    expect(n).toBe(2);
    expect(engine.has("PreToolUse")).toBe(true);
    expect(engine.has("Notification")).toBe(true);
    expect(await engine.run({ event: "PreToolUse", toolName: "Bash", input: { command: "rm -rf /tmp/x" } }, ctx)).toEqual([{ block: true, reason: "guard: no rm -rf" }]);
    expect(await engine.run({ event: "PreToolUse", toolName: "Edit", input: {} }, ctx)).toEqual([{}]);
    expect(await engine.run({ event: "Notification", kind: "max_turns", message: "" }, ctx)).toEqual([{ injectContext: "noted max_turns" }]);
  });
});

describe("hooks v2: the new events fire at their seams", () => {
  test("PermissionRequest lets a hook answer in the person's place; StopFailure fires when the verifier blocks; Notification fires on a non-success end", async () => {
    const fired: HookInput[] = [];
    const hooks = new HookEngine();
    hooks.register(new FunctionHook("rec", ["PermissionRequest", "StopFailure", "Notification", "PostCompact"], (input) => {
      fired.push(input);
      if (input.event === "PermissionRequest") return { decision: "allow" };
      return {};
    }));
    let stops = 0;
    hooks.register(new FunctionHook("verifier", ["Stop"], () => (stops++ === 0 ? { block: true, reason: "tests not run", verdict: "FAIL" } : { verdict: "PASS" })));
    let turn = 0;
    const model: ModelClient = {
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        turn += 1;
        return turn === 1 ? toolUse("Bash", { command: "echo hi" }) : textDone("done");
      },
    };
    const sess = new AgentSession({
      agentId: "ag",
      sessionId: "s-hooks2",
      workspace: "w",
      cwd,
      model: "m",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: model,
      canUseTool: createPolicy({ mode: "manual" }), // manual mode ASKS for Bash: the hook answers
      maxTokens: 100,
      hooks,
    });
    const events = await drain(sess.run({ text: "go" }));
    expect(events.find((e) => e.type === "tool_result" && "content" in e && String(e.content).includes("hi"))).toBeTruthy();
    const perm = fired.find((f) => f.event === "PermissionRequest");
    expect(perm).toMatchObject({ event: "PermissionRequest", toolName: "Bash" });
    const stopFail = fired.find((f) => f.event === "StopFailure");
    expect(stopFail).toMatchObject({ event: "StopFailure", reason: "tests not run", verdict: "FAIL", continuations: 1 });
    expect(fired.find((f) => f.event === "Notification")).toBeUndefined(); // the run succeeded

    const sess2 = new AgentSession({
      agentId: "ag",
      sessionId: "s-hooks2-max",
      workspace: "w",
      cwd,
      model: "m",
      systemPrompt: "t",
      tools: defaultRegistry(),
      store: new LocalStore(root),
      model_client: { async *stream(): AsyncGenerator<never, ModelResult, void> { return toolUse("Bash", { command: "echo loop" }); } },
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTokens: 100,
      maxTurns: 2,
      hooks,
    });
    await drain(sess2.run({ text: "loop" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(fired.find((f) => f.event === "Notification")).toMatchObject({ event: "Notification", kind: "max_turns" });
  });

  test("PostCompact fires after a manual compaction; SubagentStart fires from the Task tool", async () => {
    const fired: HookInput[] = [];
    const hooks = new HookEngine();
    hooks.register(new FunctionHook("rec", ["PostCompact", "SubagentStart"], (input) => (fired.push(input), {})));
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        if (req.system?.includes("compress a coding session")) return textDone("SUMMARY");
        return textDone("ok");
      },
    };
    const sess = new AgentSession({ agentId: "ag", sessionId: "s-hooks2-compact", workspace: "w", cwd, model: "m", systemPrompt: "t", tools: defaultRegistry(), store: new LocalStore(root), model_client: model, canUseTool: createPolicy({ mode: "autopilot" }), maxTokens: 100, hooks });
    await drain(sess.run({ text: "one" }));
    await sess.compact();
    expect(fired.find((f) => f.event === "PostCompact")).toMatchObject({ event: "PostCompact", trigger: "manual", summaryChars: 7 });

    const tool = createTaskTool(async () => ({ text: "child done", sessionId: "child" }), [], undefined, { hooks });
    const r = await tool.call({ description: "find the bug", prompt: "p" } as never, { cwd: "/w", sessionId: "s", runId: "r1" } as never);
    expect(String(r.content)).toContain("child done");
    expect(fired.find((f) => f.event === "SubagentStart")).toMatchObject({ event: "SubagentStart", description: "find the bug", background: false });
  });
});
