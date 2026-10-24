import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GatewayClient, GatewayError } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { describeProfile } from "../src/profile/describe";
import { loadProfile } from "../src/profile/load";
import { globToRegExp, ModelAccessError, modelRefusal, pinnedModels, pinsOutsidePolicy, policyAllows, policyIsOpen } from "../src/profile/model-policy";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";

describe("model policy globs (the gateway's semantics, locally)", () => {
  test("globs: *, ?, classes, literal dots; deny wins; absent, [] and [*] are open", () => {
    expect(globToRegExp("claude-*").test("claude-opus-5-5")).toBe(true);
    expect(globToRegExp("claude-*").test("gpt-6-sol")).toBe(false);
    expect(globToRegExp("gpt-6-?una").test("gpt-6-luna")).toBe(true);
    expect(globToRegExp("gpt-6-[ls]*").test("gpt-6-sol")).toBe(true);
    expect(globToRegExp("gpt-6-[ls]*").test("gpt-6-juno")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
    expect(policyIsOpen(undefined)).toBe(true);
    expect(policyIsOpen({ allow: [], deny: [] })).toBe(true);
    expect(policyIsOpen({ allow: ["*"], deny: [] })).toBe(true);
    expect(policyIsOpen({ allow: ["*"], deny: ["gpt-*"] })).toBe(false);
    expect(policyIsOpen({ allow: ["gpt-6-luna"], deny: [] })).toBe(false);
    const p = { allow: ["gpt-6-*", "claude-opus-5-5"], deny: ["gpt-6-sol"] };
    expect(policyAllows(p, "gpt-6-luna")).toBe(true);
    expect(policyAllows(p, "gpt-6-sol")).toBe(false); // deny wins over the allow glob
    expect(policyAllows(p, "claude-opus-5-5")).toBe(true);
    expect(policyAllows(p, "claude-sonnet-5-5")).toBe(false);
    expect(policyAllows({ allow: [], deny: ["gpt-*"] }, "claude-opus-5-5")).toBe(true);
    expect(policyAllows(undefined, "anything")).toBe(true);
  });

  test("pinned models are the composed literal ids, never tier aliases or tier names", () => {
    const profile = {
      model: { main: "fast", subagents: { readOnly: "cheap", verify: "claude-haiku-5-5" }, allowInvokeAny: true, tiers: { fast: { primary: "gpt-6-luna", fallbacks: ["gpt-6-sol"] } } },
      verification: { agent: { tier: "mid" } },
    } as never;
    expect(pinnedModels(profile).sort()).toEqual(["claude-haiku-5-5", "gpt-6-luna", "gpt-6-sol"]);
    expect(pinsOutsidePolicy({ ...(profile as object), modelPolicy: { allow: ["gpt-6-*"], deny: [] } } as never)).toEqual(["claude-haiku-5-5"]);
    expect(pinsOutsidePolicy({ ...(profile as object), modelPolicy: undefined } as never)).toEqual([]);
  });

  test("the refusal names the model and the HOP, with one code", () => {
    const r = modelRefusal("gpt-6-sol", "reviewer", "hop_policy");
    expect(r).toEqual({ code: "model_access_denied", model: "gpt-6-sol", hop: "reviewer", reason: "hop_policy", message: "HOP reviewer does not allow gpt-6-sol here" });
    // Rule 7: every reason names the model and the HOP.
    expect(modelRefusal("x", "h", "key_policy").message).toBe("HOP h cannot use x here (the key's own policy narrows it)");
    expect(modelRefusal("x", "h", "not_served").message).toBe("HOP h cannot use x here (not served by this gateway)");
    expect(new ModelAccessError(modelRefusal("x", "h", "gateway")).message).toBe("HOP h cannot use x here (the gateway refused it)");
  });
});

describe("hop.yaml model_policy", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yx-mp-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const hop = (name: string, body: string) => {
    const dir = join(home, ".yodex", "hops", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hop.yaml"), `spec: mlpal/hop-v1\nname: ${name}\nversion: 1.0.0\ndescription: t\n${body}`);
  };

  test("loads onto the profile, is not inherited, and describes as data", () => {
    hop("luna-only", "model_policy:\n  allow: [gpt-6-luna]\n");
    const p = loadProfile("luna-only", { cwd: "/nonexistent", home });
    expect(p.modelPolicy).toEqual({ allow: ["gpt-6-luna"], deny: [] });
    expect(describeProfile(p).modelPolicy).toEqual({ allow: ["gpt-6-luna"], deny: [] });
    hop("child", "extends: luna-only\n");
    expect(loadProfile("child", { cwd: "/nonexistent", home }).modelPolicy).toBeUndefined();
    expect(loadProfile("coding", { cwd: "/nonexistent", home }).modelPolicy).toBeUndefined();
  });

  test("a pin outside the HOP's own policy is a load error (rule 6); a tier alias is not a pin", () => {
    hop("bad", "model_policy:\n  allow: [gpt-6-luna]\nmodel:\n  main: mine\n  tiers:\n    mine:\n      primary: gpt-6-sol\n");
    expect(() => loadProfile("bad", { cwd: "/nonexistent", home })).toThrow(/pins gpt-6-sol but its model_policy denies it/);
    hop("ok", "model_policy:\n  deny: [gpt-6-sol]\nmodel:\n  main: frontier\n");
    expect(loadProfile("ok", { cwd: "/nonexistent", home }).modelPolicy).toEqual({ allow: [], deny: ["gpt-6-sol"] });
  });
});

describe("the gateway's model_access_denied", () => {
  test("a 403 with error.code and model becomes a typed GatewayError; the loop ends the run with the refusal on its result", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ error: { type: "forbidden", code: "model_access_denied", model: "gpt-6-sol", message: "model not allowed for this key" } }), { status: 403 }),
    });
    const root = mkdtempSync(join(tmpdir(), "yx-mad-"));
    try {
      const client = new GatewayClient({ baseUrl: `http://localhost:${server.port}`, apiKey: "k" });
      let caught: unknown;
      try {
        const g = client.stream({ model: "gpt-6-sol", system: "s", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 10 });
        let r = await g.next();
        while (!r.done) r = await g.next();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(GatewayError);
      const ge = caught as GatewayError;
      expect(ge.status).toBe(403);
      expect(ge.code).toBe("model_access_denied");
      expect(ge.model).toBe("gpt-6-sol");
      expect(ge.modelAccessDenied).toBe(true);

      const store = new LocalStore(root);
      const session = new AgentSession({ agentId: "a", sessionId: "s", workspace: "w", cwd: root, model: "gpt-6-sol", systemPrompt: "t", tools: new ToolRegistry(), store, model_client: client, canUseTool: createPolicy({ mode: "autopilot" }), stamp: { hop: "reviewer@1.0.0", origin: "test", workspace: "w" } });
      const events = [];
      for await (const e of session.run({ text: "go" })) events.push(e);
      const result = events.find((e) => e.type === "result");
      expect(result).toMatchObject({ type: "result", subtype: "error", refusal: { code: "model_access_denied", model: "gpt-6-sol", hop: "reviewer", reason: "gateway" } });
      expect((result as { reason?: string }).reason).toBe("HOP reviewer cannot use gpt-6-sol here (the gateway refused it)");
      const persisted = (await store.conversation.read("s")).map((e) => e.payload).find((p) => p.type === "result");
      expect(persisted).toMatchObject({ refusal: { code: "model_access_denied" } });
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a foreground sub-agent refused for its model (R6)", () => {
  test("the Agent tool answers with a typed tool_result and the parent's stream carries refusal on the tool_result event", async () => {
    const { createTaskTool } = await import("../src/subagent/task");
    const { BackgroundAgents } = await import("../src/subagent/background");
    const refusal = modelRefusal("gpt-6-sol", "reviewer", "hop_policy");
    const run = async () => {
      throw new ModelAccessError(refusal);
    };
    const tool = createTaskTool(run, [], new BackgroundAgents(0));
    const direct = await tool.call({ description: "study", prompt: "p", model: "gpt-6-sol" }, { cwd: "/tmp", sessionId: "parent" });
    expect(direct.isError).toBe(true);
    expect(direct.meta?.refusal).toEqual(refusal);
    // Through the loop: the ToolResultEvent on the parent's stream carries the refusal (0.20.5).
    const root = mkdtempSync(join(tmpdir(), "yx-fg-"));
    try {
      const store = new LocalStore(root);
      const tools = new ToolRegistry();
      tools.register(tool);
      let i = 0;
      const scripts = [
        { model: "test", message: { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "tu_1", name: "Agent", input: { description: "study", prompt: "p", model: "gpt-6-sol" } }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use" as const },
        { model: "test", message: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok, another model then" }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" as const },
      ];
      const session = new AgentSession({ agentId: "a", sessionId: "p", workspace: "w", cwd: root, model: "test", systemPrompt: "t", tools, store, model_client: { async *stream() { return scripts[i++]!; } }, canUseTool: createPolicy({ mode: "autopilot" }), stamp: { hop: "reviewer@1.0.0", origin: "test", workspace: "w" } });
      const events = [];
      for await (const e of session.run({ text: "go" })) events.push(e);
      const tr = events.find((e) => e.type === "tool_result") as { refusal?: unknown; isError: boolean } | undefined;
      expect(tr?.isError).toBe(true);
      expect(tr?.refusal).toEqual(refusal);
      expect((events.find((e) => e.type === "result") as { subtype: string }).subtype).toBe("success"); // the parent went on
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
