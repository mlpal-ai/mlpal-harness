import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineEvent } from "@mlpal/harness-protocol";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import { FilteredHook, HookEngine, PromptHook } from "../src/hooks/engine";
import type { HookInput, HookResult } from "../src/hooks/types";
import { AgentSession, type AskContext } from "../src/loop/agent";
import type { Logger } from "../src/obs/logger";
import type { Metrics } from "../src/obs/metrics";
import { createPolicy, type PermissionRequest } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { defaultRegistry } from "../src/tools";

/**
 * A prompt hook (a cheap model judging an event against a rule) that gets no verdict out of its model must never
 * read as "allow". The gateway counted 57 of 98 gpt-6-luna calls at max_tokens 200 answering no text in one day: the
 * reasoning used the whole budget. Each case below is one way a verdict goes missing.
 */

let root: string;
let cwd: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "yodex-noverdict-"));
  cwd = mkdtempSync(join(tmpdir(), "yodex-noverdict-cwd-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const RULE = "block any git push to main";
const SECRET_COMMAND = "git push origin main --token=ghp_do_not_log";
const MODEL_PROSE = "Let me think about whether this push is allowed under the rule";
const ctx = { sessionId: "s", agentId: "a", cwd: "/w" };
const pushEvent = { event: "PreToolUse" as const, toolName: "Bash", input: { command: SECRET_COMMAND } };

type Content = Exclude<ModelResult["message"]["content"], string>;
const answer = (content: Content, stopReason: ModelResult["stopReason"] = "end_turn"): ModelResult => ({ model: "cheap", message: { role: "assistant", content }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason });
const text = (t: string, stopReason: ModelResult["stopReason"] = "end_turn"): ModelResult => answer([{ type: "text", text: t }], stopReason);

/** A logger that keeps every line, so a test can count the no-verdict lines and check none carries content. */
function recordingLogger(): Logger & { lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> } {
  const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const at =
    (level: string) =>
    (msg: string, fields: Record<string, unknown> = {}) =>
      void lines.push({ level, msg, fields });
  const logger = { log: (level: string, msg: string, fields?: Record<string, unknown>) => at(level)(msg, fields), debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => logger, lines } as unknown as Logger & { lines: typeof lines };
  return logger;
}

function hookWith(reply: (req: ModelRequest) => Promise<ModelResult> | ModelResult, extra: { timeoutMs?: number; metrics?: Metrics } = {}) {
  const logger = recordingLogger();
  const seen: ModelRequest[] = [];
  const client: Pick<ModelClient, "stream"> = {
    // biome-ignore lint/correctness/useYield: a model that answers in one piece
    async *stream(req) {
      seen.push(req);
      return reply(req);
    },
  };
  const hook = new PromptHook("cfg:PreToolUse#1", ["PreToolUse"], RULE, { client, model: "cheap", logger, ...extra });
  return { hook, logger, seen };
}

/** The one no-verdict line: its reason, and nothing of the model's answer, the event or the error's text. */
function expectOneNoVerdictLine(logger: ReturnType<typeof recordingLogger>, reason: string): void {
  const lines = logger.lines.filter((l) => l.msg.includes("no verdict"));
  expect(lines).toHaveLength(1);
  expect(lines[0]!.fields).toMatchObject({ hook: "cfg:PreToolUse#1", event: "PreToolUse", reason });
  const all = JSON.stringify(logger.lines);
  expect(all).not.toContain("ghp_do_not_log");
  expect(all).not.toContain(MODEL_PROSE);
  expect(all).not.toContain(RULE);
}

describe("a prompt hook's model gave no verdict: the hook says so, it never reads as allow", () => {
  test("a clear verdict is unchanged: block is a block, a clear no is no result", async () => {
    let reply = '{"block": true, "reason": "push to main is forbidden"}';
    const { hook, logger } = hookWith(() => text(reply));
    expect(await hook.run(pushEvent, ctx)).toEqual({ block: true, reason: "push to main is forbidden" });
    reply = '{"block": false, "reason": "a push to a branch"}';
    expect(await hook.run({ ...pushEvent, input: { command: "git push origin feat" } }, ctx)).toEqual({});
    expect(logger.lines.filter((l) => l.msg.includes("no verdict"))).toEqual([]);
  });

  test("empty: the model finished with no text (its reasoning only)", async () => {
    const { hook, logger } = hookWith(() => answer([{ type: "thinking", thinking: MODEL_PROSE }]));
    const r = await hook.run(pushEvent, ctx);
    expect(r.block).toBeUndefined();
    expect(r.noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "empty" });
    expect(r.reason).toContain("cfg:PreToolUse#1");
    expect(r.reason).toContain("no verdict");
    expectOneNoVerdictLine(logger, "empty");
  });

  test("cut off: the budget ran out in the reasoning, before any answer (the gpt-6-luna case)", async () => {
    const { hook, logger } = hookWith(() => answer([{ type: "thinking", thinking: MODEL_PROSE }], "max_tokens"));
    expect((await hook.run(pushEvent, ctx)).noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "cut_off" });
    expectOneNoVerdictLine(logger, "cut_off");
  });

  test("cut off: the budget ran out mid-answer", async () => {
    const { hook, logger } = hookWith(() => text('{"block": true, "reason": "push to ma', "max_tokens"));
    expect((await hook.run(pushEvent, ctx)).noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "cut_off" });
    expectOneNoVerdictLine(logger, "cut_off");
  });

  test("unparsable: prose, JSON that does not parse, or a block that is not a boolean", async () => {
    for (const reply of [MODEL_PROSE, "{block: yes}", '{"block": "true", "reason": "x"}', '{"reason": "no block field"}']) {
      const { hook, logger } = hookWith(() => text(reply));
      const r = await hook.run(pushEvent, ctx);
      expect(r.block).toBeUndefined();
      expect(r.noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "unparsable" });
      expectOneNoVerdictLine(logger, "unparsable");
    }
  });

  test("error: the model call throws", async () => {
    const { hook, logger } = hookWith(() => Promise.reject(new Error(`stream died while echoing ${SECRET_COMMAND}`)));
    expect((await hook.run(pushEvent, ctx)).noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "error" });
    expectOneNoVerdictLine(logger, "error");
  });

  test("error: the call times out, even against a client that ignores its signal", async () => {
    const { hook, logger } = hookWith(() => new Promise<ModelResult>(() => undefined), { timeoutMs: 50 });
    const started = Date.now();
    expect((await hook.run(pushEvent, ctx)).noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "error" });
    expect(Date.now() - started).toBeLessThan(2000);
    expectOneNoVerdictLine(logger, "error");
  });

  test("error: the gateway refuses (401), throttles (429) or fails (5xx); the line names the status, not the message", async () => {
    for (const status of [401, 429, 500, 503]) {
      const { hook, logger } = hookWith(() => Promise.reject(new GatewayError(`HTTP ${status}: request ${SECRET_COMMAND}`, status, "http")));
      expect((await hook.run(pushEvent, ctx)).noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "error" });
      expectOneNoVerdictLine(logger, "error");
      expect(logger.lines.find((l) => l.msg.includes("no verdict"))!.fields.status).toBe(status);
    }
  });

  test("unsure: the model says it cannot tell (block: null), as the prompt asks it to when in doubt", async () => {
    const { hook, logger, seen } = hookWith(() => text('{"block": null, "reason": "the rule may or may not cover a force push"}'));
    const r = await hook.run(pushEvent, ctx);
    expect(r.block).toBeUndefined();
    expect(r.noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "unsure" });
    expect(r.reason).toContain("could not tell");
    expectOneNoVerdictLine(logger, "unsure");
    // Doubt is never a clean "do not block": the model is told to answer null.
    expect(seen[0]!.system).toContain("null: you cannot tell whether it applies");
    expect(seen[0]!.system).not.toContain("when in doubt, do not block");
  });

  test("a result with no message is a no verdict, never a throw the engine would drop as no result", async () => {
    const { hook, logger } = hookWith(() => ({}) as ModelResult);
    expect((await hook.run(pushEvent, ctx)).noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "error" });
    expectOneNoVerdictLine(logger, "error");
  });

  test("the session's interrupt stops the call: the hook returns at once", async () => {
    const ac = new AbortController();
    const { hook } = hookWith(() => new Promise<ModelResult>(() => undefined), { timeoutMs: 60_000 });
    setTimeout(() => ac.abort(), 20);
    const started = Date.now();
    expect((await hook.run(pushEvent, { ...ctx, signal: ac.signal })).noVerdict?.reason).toBe("error");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("each no verdict counts once on hooks.prompt.no_verdict, by reason and event; a verdict counts nothing", async () => {
    const counted: Array<{ name: string; tags?: Record<string, string> }> = [];
    const metrics: Metrics = { increment: (name, _v, tags) => void counted.push({ name, ...(tags ? { tags } : {}) }), histogram: () => undefined };
    let reply = "";
    const { hook } = hookWith(() => text(reply), { metrics });
    await hook.run(pushEvent, ctx);
    reply = '{"block": false}';
    await hook.run(pushEvent, ctx);
    reply = '{"block": null}';
    await hook.run({ event: "UserPromptSubmit", prompt: "deploy" }, ctx);
    expect(counted).toEqual([
      { name: "hooks.prompt.no_verdict", tags: { reason: "empty", event: "PreToolUse", hook: "cfg:PreToolUse#1" } },
      { name: "hooks.prompt.no_verdict", tags: { reason: "unsure", event: "UserPromptSubmit", hook: "cfg:PreToolUse#1" } },
    ]);
    const throttled = hookWith(() => Promise.reject(new GatewayError("HTTP 429", 429, "http", undefined, "rate_limited")), { metrics });
    await throttled.hook.run(pushEvent, ctx);
    expect(counted.at(-1)!.tags).toEqual({ reason: "error", event: "PreToolUse", hook: "cfg:PreToolUse#1", status: "429", code: "rate_limited" });
  });

  test("the budget leaves a reasoning model room to answer (200 left none)", async () => {
    const { hook, seen } = hookWith(() => text('{"block": false}'));
    await hook.run(pushEvent, ctx);
    expect(seen[0]!.maxTokens).toBeGreaterThanOrEqual(1024);
  });

  test("a filtered prompt hook passes its no verdict through; one that does not match never asks its model", async () => {
    const { hook, seen } = hookWith(() => text(""));
    const filtered = new FilteredHook(hook, { toolName: "Bash" });
    expect((await filtered.run(pushEvent, ctx)).noVerdict?.reason).toBe("empty");
    expect(await filtered.run({ event: "PreToolUse", toolName: "Read", input: { path: "a" } }, ctx)).toEqual({});
    expect(seen).toHaveLength(1);
  });
});

// ---- the loop: what a no verdict does to the event ----

const toolUse = (name: string, input: Record<string, unknown>): ModelResult => ({ model: "m", message: { role: "assistant", content: [{ type: "tool_use", id: `tu_${crypto.randomUUID().slice(0, 6)}`, name, input }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use" });
async function drain(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}
const toolResults = (events: EngineEvent[]) => events.filter((e) => e.type === "tool_result") as Array<Extract<EngineEvent, { type: "tool_result" }>>;

/** The main model makes `calls` (one per turn), then says done; every judge call (a prompt hook) answers nothing. */
function scripted(calls: Array<{ name: string; input: Record<string, unknown> }>): ModelClient {
  let turn = 0;
  return {
    async *stream(req): AsyncGenerator<never, ModelResult, void> {
      if (req.system?.includes("policy check")) return answer([{ type: "thinking", thinking: MODEL_PROSE }], "max_tokens");
      const c = calls[turn++];
      return c ? toolUse(c.name, c.input) : text("done");
    },
  };
}

function undecidedHooks(model: ModelClient, events: Array<"PreToolUse" | "UserPromptSubmit" | "Stop"> = ["PreToolUse"]): HookEngine {
  const hooks = new HookEngine();
  for (const e of events) hooks.register(new PromptHook(`cfg:${e}#1`, [e], RULE, { client: model, model: "cheap" }));
  return hooks;
}

function session(id: string, o: { model: ModelClient; hooks: HookEngine; mode?: "autopilot" | "cruise" | "manual"; onAsk?: (req: PermissionRequest, ask: AskContext) => Promise<ReturnType<ReturnType<typeof createPolicy>> | null>; parkHeadless?: boolean | "every_ask"; deny?: string[] }) {
  return new AgentSession({
    agentId: "ag",
    sessionId: id,
    workspace: "w",
    cwd,
    model: "m",
    systemPrompt: "t",
    tools: defaultRegistry(),
    store: new LocalStore(root),
    model_client: o.model,
    canUseTool: createPolicy({ mode: o.mode ?? "autopilot", ...(o.deny ? { deny: o.deny } : {}) }),
    maxTokens: 100,
    hooks: o.hooks,
    ...(o.onAsk ? { onAsk: o.onAsk as never } : {}),
    ...(o.parkHeadless !== undefined ? { parkHeadless: o.parkHeadless } : {}),
  });
}

describe("the loop: an undecided policy check on a tool call is the person's to decide", () => {
  test("interactive: a call the mode would allow is asked, with the check's reason and the no-verdict mark; a decline leaves it unrun", async () => {
    const dir = join(cwd, "declined.dir");
    const model = scripted([{ name: "Bash", input: { command: `mkdir ${dir}` } }]);
    const asks: Array<{ tool: string; ask: AskContext }> = [];
    const sess = session("s-nv-ask", { model, hooks: undecidedHooks(model), onAsk: async (req, ask) => (asks.push({ tool: req.toolName, ask }), { behavior: "deny", reason: "denied by user" }) });
    const events = await drain(sess.run({ text: "go" }));
    expect(asks).toHaveLength(1);
    expect(asks[0]!.ask.noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "cut_off" });
    expect(asks[0]!.ask.reason).toContain("cfg:PreToolUse#1");
    expect(asks[0]!.ask.safetyReason).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
    expect(toolResults(events)[0]).toMatchObject({ isError: true, content: expect.stringContaining("denied by user") });
  });

  test("interactive: the person's allow runs the call", async () => {
    const dir = join(cwd, "allowed.dir");
    const model = scripted([{ name: "Bash", input: { command: `mkdir ${dir}` } }]);
    const sess = session("s-nv-allow", { model, hooks: undecidedHooks(model), onAsk: async () => ({ behavior: "allow" }) });
    await drain(sess.run({ text: "go" }));
    expect(existsSync(dir)).toBe(true);
  });

  test("an ask the mode already raised keeps its reason and gains the check's", async () => {
    const model = scripted([{ name: "Bash", input: { command: "mkdir x-manual.dir" } }]);
    const asks: AskContext[] = [];
    const sess = session("s-nv-manual", { model, hooks: undecidedHooks(model), mode: "manual", onAsk: async (_r, ask) => (asks.push(ask), { behavior: "deny", reason: "no" }) });
    await drain(sess.run({ text: "go" }));
    expect(asks[0]!.noVerdict?.reason).toBe("cut_off");
    expect(asks[0]!.reason).toContain("cfg:PreToolUse#1");
  });

  test("unattended (no one to ask): the call is denied, and the denial names the check that could not decide", async () => {
    const dir = join(cwd, "unattended.dir");
    const model = scripted([{ name: "Bash", input: { command: `mkdir ${dir}` } }]);
    const events = await drain(session("s-nv-headless", { model, hooks: undecidedHooks(model) }).run({ text: "go" }));
    expect(existsSync(dir)).toBe(false);
    const r = toolResults(events)[0]!;
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Permission denied");
    expect(r.content).toContain("cfg:PreToolUse#1");
    expect(r.content).toContain("no verdict");
  });

  test("a turn resumed with nobody attached (every_ask) parks for the person instead of running", async () => {
    const dir = join(cwd, "parked.dir");
    const model = scripted([{ name: "Bash", input: { command: `mkdir ${dir}` } }]);
    const events = await drain(session("s-nv-park", { model, hooks: undecidedHooks(model), parkHeadless: "every_ask" }).run({ text: "go" }));
    expect(existsSync(dir)).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "needs_approval" });
    // The approval card says which check went undecided, not only "approval required".
    const pending = (events.at(-1) as Extract<EngineEvent, { type: "result" }>).pendingApproval!;
    expect(pending.reason).toBe("approval_required");
    expect(pending.noVerdict).toEqual({ hook: "cfg:PreToolUse#1", reason: "cut_off" });
    expect(pending.detail).toContain("cfg:PreToolUse#1");
    expect(pending.detail).toContain("reached no verdict");
  });

  test("a PermissionRequest hook is told the call's policy check never ran", async () => {
    const model = scripted([{ name: "Bash", input: { command: "mkdir told.dir" } }]);
    const hooks = undecidedHooks(model);
    const seen: HookInput[] = [];
    hooks.register({ id: "answerer", events: ["PermissionRequest"], run: async (input): Promise<HookResult> => (seen.push(input), {}) });
    await drain(session("s-nv-permreq", { model, hooks, onAsk: async () => ({ behavior: "deny", reason: "no" }) }).run({ text: "go" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: "PermissionRequest", toolName: "Bash", noVerdict: { hook: "cfg:PreToolUse#1", reason: "cut_off" } });
  });

  test("a turn cancelled while the check ran asks nobody and runs nothing", async () => {
    const dir = join(cwd, "cancelled.dir");
    const ac = new AbortController();
    let turn = 0;
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        if (req.system?.includes("policy check")) {
          ac.abort(); // the person presses Ctrl-C while the check waits on its model
          return new Promise<never>(() => undefined);
        }
        return turn++ === 0 ? toolUse("Bash", { command: `mkdir ${dir}` }) : text("done");
      },
    };
    const asks: string[] = [];
    const hooks = new HookEngine();
    hooks.register(new PromptHook("cfg:PreToolUse#1", ["PreToolUse"], RULE, { client: model, model: "cheap" }));
    const sess = new AgentSession({ agentId: "ag", sessionId: "s-nv-cancel", workspace: "w", cwd, model: "m", systemPrompt: "t", tools: defaultRegistry(), store: new LocalStore(root), model_client: model, canUseTool: createPolicy({ mode: "autopilot" }), maxTokens: 100, hooks, signal: ac.signal, onAsk: async (req) => (asks.push(req.toolName), { behavior: "allow" }) });
    await drain(sess.run({ text: "go" }));
    expect(asks).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  test("a harmless read is never asked because of it: a read-only call runs as the mode decides", async () => {
    const model = scripted([
      { name: "Read", input: { path: join(cwd, "nothing-here.txt") } },
      { name: "Bash", input: { command: "ls" } },
    ]);
    const asks: string[] = [];
    const events = await drain(session("s-nv-read", { model, hooks: undecidedHooks(model), onAsk: async (req) => (asks.push(req.toolName), { behavior: "deny", reason: "no" }) }).run({ text: "go" }));
    expect(asks).toEqual([]);
    expect(toolResults(events).map((r) => String(r.content))).not.toContainEqual(expect.stringContaining("Permission denied"));
  });

  test("a call the policy denies stays denied; nobody is asked", async () => {
    const model = scripted([{ name: "Bash", input: { command: "mkdir denied.dir" } }]);
    const asks: string[] = [];
    const events = await drain(session("s-nv-deny", { model, hooks: undecidedHooks(model), deny: ["Bash(mkdir*)"], onAsk: async (req) => (asks.push(req.toolName), { behavior: "allow" }) }).run({ text: "go" }));
    expect(asks).toEqual([]);
    expect(toolResults(events)[0]).toMatchObject({ isError: true, content: expect.stringContaining('denied by rule "Bash(mkdir*)"') });
  });

  test("a clear block still wins over another hook's no verdict", async () => {
    const model = scripted([{ name: "Bash", input: { command: "mkdir blocked.dir" } }]);
    const hooks = undecidedHooks(model);
    hooks.register({ id: "guard", events: ["PreToolUse"], run: async (): Promise<HookResult> => ({ block: true, reason: "guard says no" }) });
    const asks: string[] = [];
    const events = await drain(session("s-nv-block", { model, hooks, onAsk: async (req) => (asks.push(req.toolName), { behavior: "allow" }) }).run({ text: "go" }));
    expect(asks).toEqual([]);
    expect(toolResults(events)[0]).toMatchObject({ isError: true, content: "Blocked by hook: guard says no" });
  });
});

describe("the loop: an undecided policy check on the other blocking events", () => {
  test("UserPromptSubmit: the prompt is not run, and the result names the check", async () => {
    const model = scripted([]);
    const events = await drain(session("s-nv-prompt", { model, hooks: undecidedHooks(model, ["UserPromptSubmit"]) }).run({ text: "deploy it" }));
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "error" });
    expect((events.at(-1) as { reason?: string }).reason).toContain("cfg:UserPromptSubmit#1");
  });

  test("UserPromptSubmit: a model that could not tell does not refuse the person's prompt (it would refuse it every time)", async () => {
    let turns = 0;
    const model: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        if (req.system?.includes("policy check")) return text('{"block": null, "reason": "unclear"}');
        turns += 1;
        return text("done");
      },
    };
    const events = await drain(session("s-nv-prompt-unsure", { model, hooks: undecidedHooks(model, ["UserPromptSubmit"]) }).run({ text: "deploy it" }));
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    expect(turns).toBe(1);
  });

  test("Stop: a block there means keep working, so an undecided check lets the run finish (advisory)", async () => {
    const model = scripted([]);
    const events = await drain(session("s-nv-stop", { model, hooks: undecidedHooks(model, ["Stop"]) }).run({ text: "go" }));
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });
  });
});

describe("personOnlyAsk: which asks no judge, grant or mode raise may answer", () => {
  test("a safety edge and an undecided policy check are the person's; an ordinary ask is not", async () => {
    // Loaded here so the file still runs (and every case above still reports) on an engine without the helper.
    const { personOnlyAsk } = (await import("../src/loop/agent")) as { personOnlyAsk: (ask: AskContext | undefined) => boolean };
    expect(personOnlyAsk({ safetyReason: "needs_approval" })).toBe(true);
    expect(personOnlyAsk({ reason: "r", noVerdict: { hook: "cfg:PreToolUse#1", reason: "empty" } })).toBe(true);
    expect(personOnlyAsk({ reason: "command execution asks in cruise" })).toBe(false);
    expect(personOnlyAsk(undefined)).toBe(false);
  });
});
