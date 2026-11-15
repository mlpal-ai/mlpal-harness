/**
 * MCP tool names are `mcp__<server>__<tool>`, the server part as mcpToolPrefix writes it: a character outside
 * [A-Za-z0-9_-] becomes `_`, and `-` is kept. Authors spell the server part both ways (`cascade-planner-tools`, and
 * `cascade_planner_tools` as other harnesses do), and a rule spelled the other way used to match nothing, silently
 * (BREAKAGES #72). Every place a tool name is matched compares canonical forms, in which `-` and `_` are one character
 * in the server part. Two servers whose names differ only there would then share their tools' names, so they are
 * refused (McpManager.connect, the HOP loader): the equivalence never lets a rule name a second server's tools.
 * The tool part is never changed.
 */

/** A server key (or the server part of a tool name or pattern) in its canonical spelling. */
export function canonicalMcpServer(server: string): string {
  return server.replace(/[^a-zA-Z0-9_*-]/g, "_").replace(/-/g, "_");
}

// The server part runs to the first `__` after `mcp__`, or to the end of a pattern that has none (`mcp__cascade-*`);
// the lazy split is the one every other reader of these names uses.
const MCP_NAME = /^mcp__(.+?)(__.*)?$/s;

/** A tool name, or a rule's tool pattern, with its MCP server part canonical; any other name as it is. */
export function canonicalToolName(name: string): string {
  const m = MCP_NAME.exec(name);
  return m ? `mcp__${canonicalMcpServer(m[1]!)}${m[2] ?? ""}` : name;
}

/** The server part of an `mcp__<server>__<tool>` name or pattern, as written; undefined when there is none. */
export function mcpServerOf(name: string): string | undefined {
  return /^mcp__(.+?)__/s.exec(name)?.[1];
}

/** Server names that would share tool names (they differ only by `-`/`_` or by characters a tool name cannot hold),
 *  grouped by their canonical spelling; empty when there are none. */
export function mcpServerCollisions(names: Iterable<string>): string[][] {
  const groups = new Map<string, Set<string>>();
  for (const n of names) {
    const key = canonicalMcpServer(n);
    groups.set(key, (groups.get(key) ?? new Set()).add(n));
  }
  return [...groups.values()].filter((g) => g.size > 1).map((g) => [...g].sort());
}
