/**
 * How a HOP's `tools.describe` text meets a tool's own description. For a tool that acts on the
 * world or sends data off the machine, the HOP may only ADD context: the engine's description stays
 * first, so no HOP can tell the model such a tool is harmless. That is decided from the tool, not a
 * list of names: every tool that is not read-only, every MCP tool, the tools that send data out
 * (WebFetch, WebSearch, Research, AskModel), and ExitPlanMode (it changes the permission mode).
 * Memorize is the one exception: base words it for a person, and its engine-owned removal path
 * (`descriptionTail`) still follows. Any other tool's description is the HOP's.
 */

/** Read-only by flag, but they send queries, URLs or conversation off the machine. */
const EGRESS = new Set(["WebFetch", "WebSearch", "Research", "AskModel"]);
/** Read-only by flag, but it changes the permission mode. */
const MODE = new Set(["ExitPlanMode"]);
/** Not read-only, but its description is a HOP's to word (memory writes; the tail keeps the engine's rule). */
const REPLACEABLE_WRITES = new Set(["Memorize"]);

/** Whether a HOP's description for this tool is appended to the engine's rather than replacing it. */
export function describeIsAppendOnly(tool: { name: string; readOnly?: boolean }): boolean {
  if (REPLACEABLE_WRITES.has(tool.name)) return false;
  return tool.readOnly !== true || tool.name.startsWith("mcp__") || EGRESS.has(tool.name) || MODE.has(tool.name);
}

/** The description the model reads for `tool` under a HOP whose `tools.describe` gives `hopText`. */
export function describedText(tool: { name: string; description: string; readOnly?: boolean; descriptionTail?: string }, hopText: string): string {
  if (describeIsAppendOnly(tool)) return `${tool.description}\n\n${hopText}`;
  return tool.descriptionTail ? `${hopText}${tool.descriptionTail}` : hopText;
}
