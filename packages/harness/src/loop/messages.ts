import type { ContentBlock, Message, ToolResultBlock } from "@mlpal/harness-protocol";
import { summaryHeader } from "../context/compaction";
import type { Store } from "../store/types";

/**
 * Reconstruct the Anthropic `messages` array from the persisted conversation DAG.
 * Tool-result events are folded into user-role messages with tool_result blocks
 * (Anthropic's contract), grouped per assistant turn. This is how a resumed session
 * — or a peer agent reading another's transcript — rebuilds context. See docs/05 §5.
 *
 * Compaction-aware: replay starts at the LAST persisted compaction boundary, seeded with
 * its summary as a synthetic user turn. This bounds what a long/resumed session reloads —
 * everything before the boundary is represented by the summary, not replayed.
 */
export async function loadMessages(store: Store, sessionId: string): Promise<Message[]> {
  const entries = await store.conversation.read(sessionId);
  const messages: Message[] = [];
  let pending: ToolResultBlock[] = [];

  // Find the most recent compaction boundary; replay only from there.
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.payload.type === "compact") {
      start = i + 1;
      const payload = entries[i]!.payload;
      if (payload.type === "compact") {
        messages.push({ role: "user", content: summaryHeader(payload.summary) });
      }
      break;
    }
  }

  const flush = () => {
    if (pending.length) {
      messages.push({ role: "user", content: pending as ContentBlock[] });
      pending = [];
    }
  };

  for (const { payload } of entries.slice(start)) {
    if (payload.type === "user") {
      // A steer/note persisted right after tool results (mid-loop steering, see agent.ts) folds
      // into the same user turn — two consecutive user messages would break role alternation, and
      // the live loop appended it to that turn too, so replay must reproduce the single turn.
      if (pending.length) {
        const c = payload.message.content;
        const blocks: ContentBlock[] = typeof c === "string" ? [{ type: "text", text: c }] : c;
        messages.push({ role: "user", content: [...(pending as ContentBlock[]), ...blocks] });
        pending = [];
      } else {
        messages.push({ role: "user", content: payload.message.content });
      }
    } else if (payload.type === "assistant") {
      flush();
      messages.push({ role: "assistant", content: payload.message.content });
    } else if (payload.type === "tool_result") {
      pending.push({
        type: "tool_result",
        tool_use_id: payload.toolUseId,
        content: payload.blocks ?? payload.content,
        is_error: payload.isError,
      });
    }
  }
  flush();
  return healInterruptedTools(messages);
}

/**
 * Give every `tool_use` a matching `tool_result`.
 *
 * A run interrupted mid-tool (Ctrl-C, a crash, a closed terminal) persists the assistant's tool_use
 * but never its result. Replayed verbatim, that produces a messages array the API rejects — every
 * tool_use must be answered in the following user turn — so the *next* message in a resumed session
 * fails before it starts. We synthesize the missing results instead, marked as interrupted, which is
 * both truthful and lets the conversation continue.
 */
function healInterruptedTools(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const ids = m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
    if (ids.length === 0) {
      out.push(m);
      continue;
    }
    const next = messages[i + 1];
    const answered = new Set<string>();
    if (next?.role === "user" && Array.isArray(next.content)) {
      for (const b of next.content) {
        if (b.type === "tool_result") answered.add((b as { tool_use_id: string }).tool_use_id);
      }
    }
    const missing = ids.filter((id) => !answered.has(id));
    out.push(m);
    if (missing.length === 0) continue;
    const synthesized: ToolResultBlock[] = missing.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "[no result recorded — the previous run was interrupted before this tool finished]",
      is_error: true,
    }));
    if (next?.role === "user" && Array.isArray(next.content)) {
      // Merge into the existing results turn so the pairing stays in one user message.
      out.push({ role: "user", content: [...synthesized, ...next.content] as ContentBlock[] });
      i += 1; // consumed
    } else {
      out.push({ role: "user", content: synthesized as ContentBlock[] });
    }
  }
  return out;
}
