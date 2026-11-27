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

/** `showToolUseId`: the Show call being checked; only what the record held before its message can verify it. Without
 *  it, or when it is not stored yet, the record freezes at the last assistant message that called tools, which is
 *  where a Show running now was asked for. */
export function foldDisplayHistory(entries: ConversationEntry[], showToolUseId?: string): DisplayHistory {
  const revisions = new Map<string, number>();
  const toolUseIds = new Set<string>();
  const names = new Map<string, string>();
  const verifiableIds = new Set<string>();
  let recentCalls: Array<{ id: string; name: string }> = [];
  const freezeAt = freezePoint(entries, showToolUseId);
  const seen = (displays: ReadonlyArray<{ block_id: string; revision: number }> | undefined) => {
    for (const d of displays ?? []) revisions.set(d.block_id, Math.max(revisions.get(d.block_id) ?? 0, d.revision));
  };
  entries.forEach(({ payload }, i) => {
    const frozen = i >= freezeAt;
    if (payload.type === "assistant") {
      for (const b of toolUses(payload.message.content)) {
        toolUseIds.add(b.id);
        names.set(b.id, b.name);
      }
    } else if (payload.type === "user") {
      if (!frozen && payload.author?.type !== "system") recentCalls = [];
    } else if (payload.type === "result") {
      // a block settled at a run's end took a revision too; a later engine must not reuse it
      seen(payload.display);
    } else if (payload.type === "tool_result") {
      seen(payload.display);
      const name = names.get(payload.toolUseId);
      // a Show's own result shows a block; it proves no source
      if (frozen || payload.isError || name === undefined || name === SHOW_TOOL_NAME) return;
      verifiableIds.add(payload.toolUseId);
      recentCalls.push({ id: payload.toolUseId, name });
    }
  });
  return { revisions, toolUseIds, verifiableIds, recentCalls };
}

type ToolUse = { type: "tool_use"; id: string; name: string };
function toolUses(content: unknown): ToolUse[] {
  return Array.isArray(content) ? content.filter((b): b is ToolUse => (b as { type?: unknown }).type === "tool_use") : [];
}

/** The index of the assistant message holding the Show (or, failing that, the last one that called tools); entries
 *  from there on verify nothing. No such message: nothing is frozen. */
function freezePoint(entries: ConversationEntry[], showToolUseId: string | undefined): number {
  let last = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const p = entries[i]!.payload;
    if (p.type !== "assistant") continue;
    const uses = toolUses(p.message.content);
    if (showToolUseId !== undefined && uses.some((b) => b.id === showToolUseId)) return i;
    if (uses.length > 0) last = i;
  }
  return last;
}
