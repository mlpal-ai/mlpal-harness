import type { ConversationEntry } from "@mlpal/harness-protocol";

/** Show's own name (show.ts imports this module, so the name is repeated here rather than imported). */
const SHOW_TOOL_NAME = "Show";

/** What Show needs from the session's record: each block's last revision and every tool call made, folded from the
 *  store (not the model's compacted context), after rewinds (pass effective entries). */
export interface DisplayHistory {
  revisions: ReadonlyMap<string, number>;
  toolUseIds: ReadonlySet<string>;
  /** The tool calls since the person's last message (Show's own excluded), by name: a source named after a tool
   *  called exactly once there is mapped to that call. Absent: no mapping. */
  recentCalls?: ReadonlyArray<{ id: string; name: string }>;
}

export function foldDisplayHistory(entries: ConversationEntry[]): DisplayHistory {
  const revisions = new Map<string, number>();
  const toolUseIds = new Set<string>();
  let recentCalls: Array<{ id: string; name: string }> = [];
  for (const { payload } of entries) {
    if (payload.type === "assistant") {
      const content = payload.message.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type !== "tool_use") continue;
        toolUseIds.add(b.id);
        if (b.name !== SHOW_TOOL_NAME) recentCalls.push({ id: b.id, name: b.name });
      }
    } else if (payload.type === "user") {
      if (payload.author?.type !== "system") recentCalls = [];
    } else if (payload.type === "tool_result") {
      for (const d of payload.display ?? []) revisions.set(d.block_id, Math.max(revisions.get(d.block_id) ?? 0, d.revision));
    }
  }
  return { revisions, toolUseIds, recentCalls };
}
