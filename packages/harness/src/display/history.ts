import type { ConversationEntry } from "@mlpal/harness-protocol";

/** Show's own name (show.ts imports this module, so the name is repeated here rather than imported). */
const SHOW_TOOL_NAME = "Show";

/** What Show needs from the session's record: each block's last revision (from tool results and from the displays
 *  settled on run results) and every tool call made, folded from the store (not the model's compacted context), after rewinds (pass effective entries). */
export interface DisplayHistory {
  revisions: ReadonlyMap<string, number>;
  toolUseIds: ReadonlySet<string>;
  /** The calls a source may be verified against: those whose result came back without an error before the assistant
   *  message holding this Show (a call in the same message, or one that failed, proves nothing). Absent: none. */
  verifiableIds?: ReadonlySet<string>;
  /** Of those, the ones since the person's last message (Show's own excluded), by name: a source named after a tool
   *  that completed exactly once there is mapped to that call. Absent: no mapping. */
  recentCalls?: ReadonlyArray<{ id: string; name: string }>;
}

/** `showToolUseId`: the Show call being checked; only what the record held before its message can verify it. */
export function foldDisplayHistory(entries: ConversationEntry[], showToolUseId?: string): DisplayHistory {
  const revisions = new Map<string, number>();
  const toolUseIds = new Set<string>();
  const names = new Map<string, string>();
  const verifiableIds = new Set<string>();
  let recentCalls: Array<{ id: string; name: string }> = [];
  let frozen = false;
  const seen = (displays: ReadonlyArray<{ block_id: string; revision: number }> | undefined) => {
    for (const d of displays ?? []) revisions.set(d.block_id, Math.max(revisions.get(d.block_id) ?? 0, d.revision));
  };
  for (const { payload } of entries) {
    if (payload.type === "assistant") {
      const content = payload.message.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b.type !== "tool_use") continue;
        toolUseIds.add(b.id);
        names.set(b.id, b.name);
        if (b.id === showToolUseId) frozen = true;
      }
    } else if (payload.type === "user") {
      if (!frozen && payload.author?.type !== "system") recentCalls = [];
    } else if (payload.type === "result") {
      // a block settled at a run's end took a revision too; a later engine must not reuse it
      seen(payload.display);
    } else if (payload.type === "tool_result") {
      seen(payload.display);
      const name = names.get(payload.toolUseId);
      if (frozen || payload.isError || name === undefined) continue;
      verifiableIds.add(payload.toolUseId);
      if (name !== SHOW_TOOL_NAME) recentCalls.push({ id: payload.toolUseId, name });
    }
  }
  return { revisions, toolUseIds, verifiableIds, recentCalls };
}
