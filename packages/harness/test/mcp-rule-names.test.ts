import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { HUMAN } from "@mlpal/harness-protocol";
import { createPolicy, parseApprovalEntry, type PermissionRequest, ruleMatch } from "../src/permission/engine";
import { classifyAction, evaluateSafety, type SafetyAction } from "../src/permission/safety-envelope";
import { McpManager } from "../src/mcp/manager";
import { loadProfile } from "../src/profile/load";
import { toolRuleIssues } from "../src/profile/tool-rules";
import type { SafetyPolicy } from "../src/profile/types";
import { ToolRegistry } from "../src/tools/registry";
import { canonicalToolName, mcpServerCollisions } from "../src/tools/tool-name";

/**
 * BREAKAGES #72: the engine names a server's tools `mcp__<server>__<tool>` keeping the server's `-`
 * (`mcp__cascade-planner-tools__decide_order`); a HOP wrote its rules with `_`, and every
 * tool-specific rule (deny, allow, the destructive class, the include list) silently matched nothing.
 * Matching is now canonical in the server part, two servers that would then share tool names are
 * refused, and a rule naming a server the HOP does not declare is caught at load.
 */

const HYPHEN = "mcp__cascade-planner-tools__";
const UNDERSCORE = "mcp__cascade_planner_tools__";
const SPELLINGS = [
  ["rule _, tool -", UNDERSCORE, HYPHEN],
  ["rule -, tool _", HYPHEN, UNDERSCORE],
  ["rule -, tool -", HYPHEN, HYPHEN],
] as const;

const call = (toolName: string, input: Record<string, unknown> = {}): PermissionRequest => ({ toolName, input, readOnly: false, isEdit: false, principal: HUMAN });

describe("canonical tool names", () => {
  test("only the server part is canonical; the tool part and other names are as written", () => {
    expect(canonicalToolName("mcp__cascade-planner-tools__decide_order")).toBe("mcp__cascade_planner_tools__decide_order");
    expect(canonicalToolName("mcp__srv__get-weather")).toBe("mcp__srv__get-weather");
    expect(canonicalToolName("mcp__cascade-*")).toBe("mcp__cascade_*");
    expect(canonicalToolName("mcp__plugin:pack:srv__x")).toBe("mcp__plugin_pack_srv__x");
    expect(canonicalToolName("Bash")).toBe("Bash");
    expect(canonicalToolName("my-tool")).toBe("my-tool");
  });

  test("collisions are the server names that differ only by - and _ (or by a character a tool name cannot hold)", () => {
    expect(mcpServerCollisions(["cascade-planner-tools", "cascade_planner_tools", "other"])).toEqual([["cascade-planner-tools", "cascade_planner_tools"]]);
    expect(mcpServerCollisions(["plugin:a:b", "plugin_a_b"])).toEqual([["plugin:a:b", "plugin_a_b"]]);
    expect(mcpServerCollisions(["a-b", "a-c", "memory"])).toEqual([]);
  });
});

describe("permissions.deny", () => {
  for (const [label, rule, tool] of SPELLINGS) {
    test(`${label}: the deny refuses the call`, async () => {
      const policy = createPolicy({ mode: "autopilot", deny: [`${rule}send_risk_alert`] });
      expect(await policy(call(`${tool}send_risk_alert`))).toMatchObject({ behavior: "deny", source: "deny_rule" });
      expect((await policy(call(`${tool}get_orders`))).behavior).toBe("allow");
    });
  }

  test("a server glob and an argument pattern are canonical too", async () => {
    const policy = createPolicy({ mode: "autopilot", deny: [`${UNDERSCORE}*`, 'mcp__cascade-*__get_orders({"region":"eu*)'] });
    expect((await policy(call(`${HYPHEN}anything`))).behavior).toBe("deny");
    const scoped = createPolicy({ mode: "autopilot", deny: ['mcp__cascade_planner_tools__get_orders({"region":"eu*)'] });
    expect((await scoped(call(`${HYPHEN}get_orders`, { region: "eu-west-1" }))).behavior).toBe("deny");
    expect((await scoped(call(`${HYPHEN}get_orders`, { region: "us-east-1" }))).behavior).toBe("allow");
  });

  test("it never widens to another server or another tool", async () => {
    const policy = createPolicy({ mode: "autopilot", deny: [`${UNDERSCORE}send_risk_alert`, "mcp__srv__get-weather"] });
    expect((await policy(call("mcp__cascade-planner-tool__send_risk_alert"))).behavior).toBe("allow");
    expect((await policy(call("mcp__cascade-planner-toolsx__send_risk_alert"))).behavior).toBe("allow");
    expect((await policy(call("mcp__srv__get_weather"))).behavior).toBe("allow");
  });

  test("an approval entry (P7) is matched the same way", () => {
    const entry = parseApprovalEntry(`${UNDERSCORE}decide_order`)!;
    expect(ruleMatch(entry.tool, call(`${HYPHEN}decide_order`))).toBe("");
  });
});

describe("permissions.allow", () => {
  for (const [label, rule, tool] of SPELLINGS) {
    test(`${label}: the allow admits the call without asking`, async () => {
      const policy = createPolicy({ mode: "manual", allow: [`${rule}get_orders`] });
      expect((await policy(call(`${tool}get_orders`))).behavior).toBe("allow");
      expect((await policy(call(`${tool}decide_order`))).behavior).toBe("ask");
    });
  }

  test("a tool name with digits and - parses (before #72 it was silently inert), with an argument pattern too", async () => {
    const policy = createPolicy({ mode: "manual", allow: ["mcp__s3-tools__list_buckets", 'mcp__s3-tools__get({"bucket":"logs*)'] });
    expect((await policy(call("mcp__s3-tools__list_buckets"))).behavior).toBe("allow");
    expect((await policy(call("mcp__s3_tools__get", { bucket: "logs-2026" }))).behavior).toBe("allow");
    expect((await policy(call("mcp__s3-tools__get", { bucket: "secrets" }))).behavior).toBe("ask");
  });

  test("an allow has no wildcard tool part: it admits nothing (the loader warns and lint fails it)", async () => {
    const policy = createPolicy({ mode: "manual", allow: [`${HYPHEN}*`] });
    expect((await policy(call(`${HYPHEN}get_orders`))).behavior).toBe("ask");
  });
});

describe("safety.toolClasses", () => {
  const safety = (classes: Partial<SafetyPolicy["toolClasses"]>): SafetyPolicy => ({
    toolClasses: { readOnly: [], mutative: [], consequential: [], destructive: [], ...classes },
    preApply: { requirePlanArtifact: false, hash: [] },
    blastRadius: {},
    approval: { destructive: "always", outOfScope: "always" },
    identities: { neverSelfGrant: true },
  });
  const action = (toolName: string, command = ""): SafetyAction => ({ toolName, command, tags: {} });

  for (const [label, rule, tool] of SPELLINGS) {
    test(`${label}: a destructive entry parks every call`, () => {
      const s = safety({ destructive: [`${rule}decide_order`], readOnly: [`${rule}get_orders`] });
      expect(classifyAction(s, action(`${tool}decide_order`))).toBe("destructive");
      expect(evaluateSafety(s, action(`${tool}decide_order`))).toMatchObject({ outcome: "park", reason: "needs_approval" });
      expect(classifyAction(s, action(`${tool}get_orders`))).toBe("readOnly");
      expect(classifyAction(s, action(`${tool}other`))).toBe("unknown");
    });
  }

  test("a Tool(pattern) entry on an MCP tool named with - parses and matches by its command", () => {
    const s = safety({ destructive: [`${UNDERSCORE}run(drop *)`] });
    expect(classifyAction(s, action(`${HYPHEN}run`, "drop table orders"))).toBe("destructive");
    expect(classifyAction(s, action(`${HYPHEN}run`, "select 1"))).toBe("unknown");
  });

  test("an mcp__ entry with a wildcard classes every tool of the server", () => {
    const s = safety({ consequential: [`${UNDERSCORE}*`] });
    expect(classifyAction(s, action(`${HYPHEN}send_risk_alert`))).toBe("consequential");
    expect(classifyAction(s, action("mcp__other__send_risk_alert"))).toBe("unknown");
  });
});

describe("McpManager refuses servers that would share tool names", () => {
  const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.mjs");
  test("the second of two servers differing only by - and _ is refused, named, and registers nothing", async () => {
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      expect(await mcp.connect("cascade-planner-tools", { command: "node", args: [SERVER] }, reg)).toBe(1);
      expect(await mcp.connect("cascade_planner_tools", { command: "node", args: [SERVER] }, reg)).toBe(0);
      const refused = mcp.status().find((s) => s.server === "cascade_planner_tools")!;
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain('"cascade-planner-tools"');
      expect(reg.list().map((t) => t.name)).toEqual(["mcp__cascade-planner-tools__greet"]);
      // a reconnect of the first is not a collision with itself
      expect(await mcp.connect("cascade-planner-tools", { command: "node", args: [SERVER] }, reg)).toBe(1);
    } finally {
      await mcp.close();
    }
  }, 20_000);
});

describe("the HOP loader", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-rule-names-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const opts = { cwd: dir, home: join(dir, "home") };
  const load = (name: string, body: string[]) => {
    const pdir = join(dir, name);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "hop.yaml"), ["spec: mlpal/hop-v1", `name: ${name}`, "version: 1.0.0", "extends: coding", ...body, ""].join("\n"));
    return () => loadProfile(pdir, opts);
  };
  const SAFETY = (entry: string) => ["permissions: { defaultMode: cruise }", "safety:", "  preApply: { requirePlanArtifact: false }", "  toolClasses:", `    destructive: ['${entry}']`];

  test("a safety class naming a server the HOP does not declare fails the load (a class that matches nothing fails open)", () => {
    expect(load("undeclared-class", SAFETY(`${UNDERSCORE}decide_order`))).toThrow(
      /safety\.toolClasses\.destructive: "mcp__cascade_planner_tools__decide_order" names MCP server "cascade_planner_tools", which the HOP does not declare/,
    );
  });

  test("declared with the other spelling, it loads; the class matches the engine's name", () => {
    const p = load("declared-class", ["requires: { mcp: [{ name: cascade-planner-tools }] }", ...SAFETY(`${UNDERSCORE}decide_order`)])();
    expect(p.warnings ?? []).not.toContainEqual(expect.stringContaining("does not declare"));
    expect(classifyAction(p.safety!, { toolName: `${HYPHEN}decide_order`, command: "", tags: {} })).toBe("destructive");
  });

  test("a process server declares its name too", () => {
    expect(load("process-class", ["processes: { mcp_stdio: [{ name: cascade-planner-tools, argv: [srv] }] }", ...SAFETY(`${UNDERSCORE}decide_order`)])().name).toBe("process-class");
  });

  test("two declared servers that would share tool names fail the load", () => {
    expect(load("collision", ["requires: { mcp: [{ name: cascade-planner-tools }] }", "processes: { mcp_stdio: [{ name: cascade_planner_tools, argv: [srv] }] }"])).toThrow(
      /MCP servers "cascade-planner-tools" and "cascade_planner_tools" would share tool names/,
    );
  });

  test("allow, deny and include naming an undeclared server load with a warning each", () => {
    const p = load("undeclared-rules", [
      `permissions: { allow: ['${UNDERSCORE}get_orders'], deny: ['${UNDERSCORE}send_risk_alert'] }`,
      `tools: { include: [Read, '${UNDERSCORE}get_orders'] }`,
    ])();
    const w = (p.warnings ?? []).filter((x) => x.includes("does not declare"));
    expect(w.map((x) => x.split(":")[0]).sort()).toEqual(["permissions.allow", "permissions.deny", "tools.include"]);
  });

  test("toolRuleIssues: every way a rule can match nothing, and none for a sound HOP", () => {
    const base = { permissions: { defaultMode: "manual" as const, allow: [], deny: [] }, tools: {}, requires: { binaries: [], mcp: [{ name: "cascade-planner-tools" }] } };
    expect(toolRuleIssues({ ...base, permissions: { ...base.permissions, allow: [`${UNDERSCORE}get_orders`, "Bash(git status*)"], deny: [`${HYPHEN}*`, "Write"] }, tools: { include: ["Read", `${HYPHEN}get_orders`] } })).toEqual([]);
    const bad = toolRuleIssues({
      ...base,
      permissions: { ...base.permissions, allow: [`${HYPHEN}*`, "mcp__elsewhere__x"], deny: ["mcp__cascade-planner-tools"] },
      tools: { include: ["mcp__elsewhere__y"] },
    });
    expect(bad.map((i) => [i.field, i.failsLoad])).toEqual([
      ["permissions.allow", false],
      ["permissions.allow", false],
      ["permissions.deny", false],
      ["tools.include", false],
    ]);
    expect(bad[0]!.message).toContain("can never match a call");
    expect(bad[2]!.message).toContain("names no tool");
  });
});
