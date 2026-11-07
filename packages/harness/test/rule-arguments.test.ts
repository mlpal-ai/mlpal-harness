/**
 * What a rule's argument pattern is judged against. A builtin file tool is judged by its path. Any other tool is judged
 * by its whole input, in canonical form, and an MCP tool only by the arguments its server declares: a call carrying
 * anything else cannot be judged, so no allow admits it and every deny and approval entry with a pattern names it.
 */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { HUMAN } from "@mlpal/harness-protocol";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { wrapMcpTool } from "../src/mcp/manager";
import { canonicalInput, createPolicy, type PermissionRequest, ruleMatch, undeclaredArgs } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";

const TOOL = "mcp__mail__send";

function call(input: Record<string, unknown>, undeclared: string[] = [], toolName = TOOL): PermissionRequest {
  return { toolName, input, readOnly: false, isEdit: false, principal: HUMAN, ...(undeclared.length ? { undeclaredArgs: undeclared } : {}) };
}

const decide = async (rules: { allow?: string[]; deny?: string[] }, req: PermissionRequest) => (await createPolicy({ mode: "manual", ...rules })(req)).behavior;

describe("an MCP tool's rules read its arguments, not a path", () => {
  test("an allow does not match on input.path, declared or not", async () => {
    const rule = { allow: [`${TOOL}(ok*)`] };
    expect(await decide(rule, call({ to: "a", path: "ok" }, ["path"]))).toBe("ask");
    expect(await decide(rule, call({ to: "a", path: "ok" }))).toBe("ask");
  });

  test("an allow matches the whole input, in either key order", async () => {
    const rule = { allow: [`${TOOL}({"to":"a",*)`] };
    expect(await decide(rule, call({ to: "a", subject: "s" }))).toBe("allow");
    const canonical = { allow: [`${TOOL}({"subject":"s","to":"a"})`] };
    expect(await decide(canonical, call({ to: "a", subject: "s" }))).toBe("allow");
    expect(await decide(rule, call({ to: "b", subject: "s" }))).toBe("ask");
  });

  test("an allow never admits a call with an undeclared argument", async () => {
    expect(await decide({ allow: [`${TOOL}({"subject":"s",*)`] }, call({ subject: "s", to: "a", extra: 1 }, ["extra"]))).toBe("ask");
  });

  test("a deny with a pattern fires on an undeclared argument, whatever the pattern", async () => {
    const d = await createPolicy({ mode: "autopilot", deny: [`${TOOL}(*"never":*)`] })(call({ to: "a", path: "x" }, ["path"]));
    expect(d.behavior).toBe("deny");
    expect((d as { reason: string }).reason).toContain("path");
  });

  test("a deny reads the whole input whatever a path says, and key order cannot hide a key", async () => {
    const rule = { deny: [`${TOOL}(*"cc":*)`], allow: [TOOL] };
    expect(await decide(rule, call({ to: "a", cc: ["b"], path: "x" }))).toBe("deny");
    expect(await decide(rule, call({ cc: ["b"], to: "a" }))).toBe("deny");
    expect(await decide({ deny: [`${TOOL}({"a":1,*)`] }, call({ b: 2, a: 1 }))).toBe("deny");
  });

  test("a deny written for the order a call was sent in still fires", async () => {
    expect(await decide({ deny: [`${TOOL}({"to":"a",*)`] }, call({ to: "a", subject: "s" }))).toBe("deny");
  });

  test("a deny on a server's declared path keeps firing", async () => {
    expect(await decide({ deny: ["mcp__fs__write(/etc/*)"] }, call({ path: "/etc/x", content: "c" }, [], "mcp__fs__write"))).toBe("deny");
    expect(await decide({ deny: ["mcp__fs__write(/etc/*)"] }, call({ path: "/tmp/x", content: "c" }, [], "mcp__fs__write"))).toBe("ask");
  });

  test("a rule with no argument pattern is unaffected by undeclared arguments", async () => {
    expect(await decide({ allow: [TOOL] }, call({ extra: 1 }, ["extra"]))).toBe("allow");
    expect(ruleMatch(TOOL, call({ extra: 1 }, ["extra"]))).toBe("");
  });

  test("a publication's approval entry names a call the same way", () => {
    const entry = `${TOOL}(*"cc":*)`;
    expect(ruleMatch(entry, call({ to: "a", cc: ["b"], path: "x" }))).toBe("");
    expect(ruleMatch(entry, call({ to: "a", path: "x" }, ["path"]))).toContain("path");
    expect(ruleMatch(entry, call({ to: "a" }))).toBeNull();
  });
});

describe("the builtin file tools are still judged by path", () => {
  for (const toolName of ["Read", "Write", "Edit", "Glob", "Grep", "List", "Lsp"]) {
    test(`${toolName}: allow and deny`, async () => {
      const input = { path: "src/a.ts", content: "src/secret" };
      expect(await decide({ allow: [`${toolName}(src/*)`] }, call(input, [], toolName))).toBe("allow");
      expect(await decide({ deny: [`${toolName}(src/*)`] }, call(input, [], toolName))).toBe("deny");
      expect(await decide({ deny: [`${toolName}(*secret*)`] }, call(input, [], toolName))).toBe("ask");
    });
  }

  test("a tool outside the set is judged by its input, not a path", async () => {
    expect(await decide({ allow: ["Deploy(staging*)"] }, call({ path: "staging", target: "prod" }, [], "Deploy"))).toBe("ask");
  });
});

describe("canonicalInput", () => {
  test("sorts keys at every depth and keeps array order", () => {
    expect(canonicalInput({ b: 1, a: { d: [2, 1], c: 0 } })).toBe('{"a":{"c":0,"d":[2,1]},"b":1}');
  });
});

describe("what an MCP tool declares", () => {
  const wrap = (inputSchema: unknown) => wrapMcpTool("mail", {} as Parameters<typeof wrapMcpTool>[1], { name: "send", inputSchema } as Parameters<typeof wrapMcpTool>[2]);

  test("properties are its arguments; anything else is undeclared", () => {
    const tool = wrap({ type: "object", properties: { to: {}, subject: {} }, additionalProperties: false });
    expect(undeclaredArgs(tool, { to: "a", path: "x" })).toEqual(["path"]);
    expect(undeclaredArgs(tool, { to: "a" })).toEqual([]);
  });

  test("a schema silent on additionalProperties is closed: the server may drop what it does not declare", () => {
    expect(undeclaredArgs(wrap({ type: "object", properties: { to: {} } }), { x: 1 })).toEqual(["x"]);
  });

  test("a schema with no top-level properties declares nothing", () => {
    expect(undeclaredArgs(wrap({ type: "object" }), { x: 1 })).toEqual(["x"]);
    expect(undeclaredArgs(wrap({ allOf: [{ properties: { x: {} } }] }), { x: 1 })).toEqual(["x"]);
  });

  test("a schema that accepts additional properties takes every key as an argument", () => {
    expect(undeclaredArgs(wrap({ type: "object", properties: {}, additionalProperties: true }), { x: 1 })).toEqual([]);
    expect(undeclaredArgs(wrap({ type: "object", additionalProperties: { type: "string" } }), { x: "1" })).toEqual([]);
  });

  test("a tool that is not an MCP tool has nothing undeclared", () => {
    expect(undeclaredArgs(undefined, { x: 1 })).toEqual([]);
  });
});

describe("through the loop", () => {
  const client = (seen: unknown[]) => ({
    callTool: async (req: { arguments?: unknown }) => {
      seen.push(req.arguments);
      return { content: [{ type: "text", text: "sent" }] };
    },
  });
  const model = (input: Record<string, unknown>): ModelClient => {
    let calls = 0;
    return {
      async *stream(): AsyncGenerator<never, ModelResult, void> {
        calls += 1;
        const content = calls === 1 ? [{ type: "tool_use", id: "t1", name: TOOL, input }] : [{ type: "text", text: "done" }];
        return { model: "m", message: { role: "assistant", content }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: calls === 1 ? "tool_use" : "end_turn" } as unknown as ModelResult;
      },
    } as unknown as ModelClient;
  };

  async function run(input: Record<string, unknown>, rules: { allow?: string[]; deny?: string[] }): Promise<unknown[]> {
    const root = join(tmpdir(), `rule-args-${crypto.randomUUID()}`);
    const seen: unknown[] = [];
    const tools = new ToolRegistry();
    tools.register(wrapMcpTool("mail", client(seen) as unknown as Parameters<typeof wrapMcpTool>[1], { name: "send", inputSchema: { type: "object", properties: { to: {}, subject: {} } } } as Parameters<typeof wrapMcpTool>[2]));
    const session = new AgentSession({ agentId: "a", sessionId: "s", workspace: "w", cwd: root, model: "m", systemPrompt: "t", tools, store: new LocalStore(root), model_client: model(input), canUseTool: createPolicy({ mode: "autopilot", ...rules }), maxTokens: 100 });
    try {
      for await (const _ of session.run({ text: "go" })) void _;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return seen;
  }

  test("a call the rules can judge reaches the server as it was judged", async () => {
    expect(await run({ to: "a", subject: "s" }, { deny: [`${TOOL}(*"cc":*)`] })).toEqual([{ to: "a", subject: "s" }]);
  });

  test("a call with an undeclared argument never reaches a server a deny pattern guards", async () => {
    expect(await run({ to: "a", other: "b" }, { deny: [`${TOOL}(*"cc":*)`] })).toEqual([]);
  });
});
