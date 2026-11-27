import type { ConversationEntry } from "@mlpal/harness-protocol";

/** What Show needs from the session's record: each block's last revision and every tool call made, folded from the
 *  store (not the model's compacted context), after rewinds (pass effective entries). */
export interface DisplayHistory {
  revisions: ReadonlyMap<string, number>;
  toolUseIds: ReadonlySet<string>;
}

export function foldDisplayHistory(entries: ConversationEntry[]): DisplayHistory {
  const revisions = new Map<string, number>();
  const toolUseIds = new Set<string>();
  for (const { payload } of entries) {
    if (payload.type === "assistant") {
      const content = payload.message.content;
      if (Array.isArray(content)) for (const b of content) if (b.type === "tool_use") toolUseIds.add(b.id);
    } else if (payload.type === "tool_result") {
      for (const d of payload.display ?? []) revisions.set(d.block_id, Math.max(revisions.get(d.block_id) ?? 0, d.revision));
    }
  }
  return { revisions, toolUseIds };
}
