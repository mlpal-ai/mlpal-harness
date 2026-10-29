/**
 * A publication's `approvals_required` entries (P7 1.7, W6 D-15) are matched by the deny path (`withApprovals` builds
 * one manual deny policy per entry): the tool part is a glob over P7's grammar, `*` the only wildcard, case-sensitive;
 * the argument part as before (Bash per sub-command). A deny rule that matched before matches the same.
 */
import { describe, expect, test } from "bun:test";
import { createPolicy, parseApprovalEntry } from "../src/permission/engine";

const fires = async (rule: string, toolName: string, input: Record<string, unknown> = {}) => {
  const d = await createPolicy({ mode: "manual", deny: [rule] })({ toolName, input } as never);
  return d.behavior === "deny" && (d as { source?: string }).source === "deny_rule";
};

describe("the tool part is a glob (`*` only, case-sensitive)", () => {
  test("Deploy* names DeployProd and Deploy, not deployProd or Deplo", async () => {
    expect(await fires("Deploy*", "DeployProd")).toBe(true);
    expect(await fires("Deploy*", "Deploy")).toBe(true);
    expect(await fires("Deploy*", "deployProd")).toBe(false);
    expect(await fires("Deploy*", "Deplo")).toBe(false);
  });

  test("MCP names (digits, `:`, `.`, `-`) and an MCP server's every tool", async () => {
    expect(await fires("mcp__github__create_pr", "mcp__github__create_pr")).toBe(true);
    expect(await fires("mcp__github__*", "mcp__github__create_pr")).toBe(true);
    expect(await fires("mcp__github__*", "mcp__gitlab__create_pr")).toBe(false);
    expect(await fires("mcp__k8s-v2__apply.dry", "mcp__k8s-v2__apply.dry")).toBe(true);
    expect(await fires("mcp__k8s-v2__apply.dry", "mcp__k8s-v2__applyXdry")).toBe(false);
  });

  test("an exact name still matches exactly; the argument side is as before", async () => {
    expect(await fires("Bash", "Bash", { command: "ls" })).toBe(true);
    expect(await fires("Bash", "BashOutput")).toBe(false);
    expect(await fires("Bash(git push*)", "Bash", { command: "git push origin main" })).toBe(true);
    expect(await fires("Bash(git push*)", "Bash", { command: "git pull" })).toBe(false);
    expect(await fires("Bash(git push*)", "Bash", { command: "git status && git push origin main" })).toBe(true);
    expect(await fires("Bash(echo destroy-probe*)", "Bash", { command: "echo destroy-probe 1" })).toBe(true);
    expect(await fires("Bash(echo destroy-probe*)", "Bash", { command: "echo probe" })).toBe(false);
    expect(await fires("Edit(src/*.py)", "Edit", { path: "src/a.py" })).toBe(true);
    expect(await fires("Edit(src/*.py)", "Edit", { path: "lib/a.py" })).toBe(false);
  });
});

describe("parseApprovalEntry: P7's grammar, strictly", () => {
  test("Tool or Tool(<glob>): the parts, or null", () => {
    expect(parseApprovalEntry("Deploy*")).toEqual({ tool: "Deploy*" });
    expect(parseApprovalEntry("Bash(git push*)")).toEqual({ tool: "Bash", pattern: "git push*" });
    for (const bad of ["Bash()", "Bash(a(b)", "Ba sh", " Bash", "Bash(x\ty)"]) expect(parseApprovalEntry(bad)).toBeNull();
  });
});
