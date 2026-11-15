import { ruleTool } from "../permission/engine";
import { classEntryTool } from "../permission/safety-envelope";
import { canonicalMcpServer, mcpServerCollisions, mcpServerNameProblem, mcpServerOf } from "../tools/tool-name";
import type { Profile } from "./types";

/**
 * Every place a HOP names a tool (permissions.allow/deny, tools.include, safety.toolClasses), checked against the MCP
 * servers the HOP declares, so a rule can never silently match nothing (BREAKAGES #72: rules spelled
 * `mcp__cascade_planner_tools__…` for a server named `cascade-planner-tools` matched nothing, and a destructive class
 * that must ask every time never asked). Matching itself is canonical (tools/tool-name.ts); what is left to catch is a
 * server the HOP does not declare, a name that is not a tool name at all, and two declared servers that would share
 * tool names. The loader throws on the fail-closed ones and carries the rest as warnings; `yodex hop lint` fails on
 * every one.
 */

export type ToolRuleField = "permissions.allow" | "permissions.deny" | "tools.include" | `safety.toolClasses.${"readOnly" | "mutative" | "consequential" | "destructive"}`;

export interface ToolRuleIssue {
  field: ToolRuleField | "requires.mcp";
  entry: string;
  message: string;
  /** The loader refuses the HOP (a safety class must never fail open); otherwise a load warning and a lint error. */
  failsLoad: boolean;
  /** Not wrong on its face, but it may match nothing at run time: a lint warning only (the host judges it once the
   *  server's tools are known). */
  advisory?: true;
}

/** One tool-naming entry of a HOP: where it is, as written, and the tool (or tool pattern) it names. */
export interface ToolRuleEntry {
  field: ToolRuleField;
  entry: string;
  /** The tool part; null when an allow/deny rule does not parse at all. */
  tool: string | null;
}

/** The server key the memory rung is served under (the host's `memory` entry; a keyring's memory rung is that server).
 *  `requires.memory` declares it, as `requires.mcp: [{name: memory}]` does. */
export const MEMORY_RUNG_SERVER = "memory";

/** The MCP servers a HOP declares: `requires.mcp` (local, org or hosted-bound servers), `processes.mcp_stdio`, and the
 *  memory server when it requires the memory rung. */
export function declaredMcpServers(p: Pick<Profile, "requires" | "processes">): string[] {
  return [
    ...new Set([
      ...(p.requires?.mcp ?? []).map((m) => m.name),
      ...(p.processes?.mcp_stdio ?? []).map((s) => s.name),
      ...(p.requires?.memory ? [MEMORY_RUNG_SERVER] : []),
    ]),
  ];
}

const CLASS_FIELDS = ["readOnly", "mutative", "consequential", "destructive"] as const;

/** Every entry of the HOP that names a tool. A bare toolClasses command glob (`kubectl delete*`) names commands and is
 *  not listed. */
export function toolRuleEntries(p: Pick<Profile, "permissions" | "tools" | "safety">): ToolRuleEntry[] {
  const out: ToolRuleEntry[] = [];
  for (const entry of p.permissions.allow) out.push({ field: "permissions.allow", entry, tool: ruleTool(entry, "allow") });
  for (const entry of p.permissions.deny) out.push({ field: "permissions.deny", entry, tool: ruleTool(entry, "deny") });
  for (const entry of p.tools.include ?? []) out.push({ field: "tools.include", entry, tool: entry });
  for (const cls of CLASS_FIELDS) {
    for (const entry of p.safety?.toolClasses[cls] ?? []) {
      const tool = classEntryTool(entry);
      if (tool !== null) out.push({ field: `safety.toolClasses.${cls}`, entry, tool });
    }
  }
  return out;
}

/** What is wrong with a HOP's tool rules, given the servers it declares. Empty when every rule can match. */
export function toolRuleIssues(p: Pick<Profile, "permissions" | "tools" | "safety" | "requires" | "processes">): ToolRuleIssue[] {
  const declared = declaredMcpServers(p);
  const issues: ToolRuleIssue[] = [
    ...mcpServerCollisions(declared).map((group) => ({
      field: "requires.mcp" as const,
      entry: group.join(", "),
      message: `MCP servers ${group.map((n) => `"${n}"`).join(" and ")} would share tool names (rules read - and _ as one): rename one`,
      failsLoad: true,
    })),
    ...declared.flatMap((name) => {
      const problem = mcpServerNameProblem(name);
      return problem === null ? [] : [{ field: "requires.mcp" as const, entry: name, message: `MCP server ${problem}: rename it`, failsLoad: true }];
    }),
  ];
  const known = new Set(declared.map(canonicalMcpServer));
  for (const e of toolRuleEntries(p)) {
    // a safety class that matches nothing fails open, so it refuses the load; any other rule only warns
    const isClass = e.field.startsWith("safety.");
    if (e.tool === null) {
      issues.push({ field: e.field, entry: e.entry, message: `"${e.entry}" is not a rule (Tool or Tool(pattern), the tool part ${e.field === "permissions.allow" ? "[A-Za-z0-9_:.-] with no wildcard" : "[A-Za-z0-9_*:.-]"}): it can never match a call`, failsLoad: isClass });
      continue;
    }
    if (!e.tool.startsWith("mcp__")) continue;
    const server = mcpServerOf(e.tool);
    if (server === undefined) {
      // `mcp__*` or `mcp__cascade-*` (a glob over servers) names tools; `mcp__cascade-planner-tools` alone names none.
      if (!e.tool.includes("*")) issues.push({ field: e.field, entry: e.entry, message: `"${e.tool}" names no tool: an MCP tool is mcp__<server>__<tool>`, failsLoad: isClass });
      continue;
    }
    if (server.includes("*") || known.has(canonicalMcpServer(server))) {
      // A class reads a call's `command` or `path` argument (the host's actionFor); an MCP tool that takes neither is
      // never matched by `Tool(pattern)`, which the host can only tell once the server's tools are listed (review S7).
      if (isClass && e.entry !== e.tool) issues.push({ field: e.field, entry: e.entry, message: `"${e.entry}" is matched against the call's command or path argument only: on an MCP tool that takes neither it never matches (the host then fails the server closed)`, failsLoad: false, advisory: true });
      continue;
    }
    issues.push({
      field: e.field,
      entry: e.entry,
      message: `"${e.entry}" names MCP server "${server}", which the HOP does not declare (requires.mcp or processes.mcp_stdio${declared.length ? `; declared: ${declared.join(", ")}` : ""})`,
      failsLoad: isClass,
    });
  }
  return issues;
}
