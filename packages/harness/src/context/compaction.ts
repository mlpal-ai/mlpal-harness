import type { ContentBlock, Message } from "@mlpal/harness-protocol";
import { EVENTS_HEADER } from "../events/inbox";

/**
 * Context management. When the working message set approaches the model's context
 * window, summarize the older portion and keep recent turns verbatim. Token counting
 * is char/4 estimation — provider-neutral and good enough for the *decision* (exact
 * counts come from the gateway usage). Compaction is boundary-safe: it never cuts
 * between an assistant tool_use and its user tool_result (which would orphan the
 * result and break the next model call). See docs/05 §5.4.
 */

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function blockText(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "thinking":
      return `(thinking) ${b.thinking}`;
    case "tool_use":
      return `(tool:${b.name} ${JSON.stringify(b.input)})`;
    case "tool_result":
      return `(result) ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}`;
    case "image":
      // An image is ~1.6k tokens, not the 2 that "(image)" would score — undercounting it
      // let a multi-image context sail past the real window into a fatal 400. Pad so char/4
      // lands near the real cost.
      return "x".repeat(6400);
    case "document":
      return "x".repeat(4000);
    default:
      return "";
  }
}

export function renderTranscript(messages: Message[]): string {
  return messages
    .map(
      (m) =>
        `${m.role}: ${typeof m.content === "string" ? m.content : m.content.map(blockText).join("\n")}`,
    )
    .join("\n\n");
}

export function estimateMessagesTokens(messages: Message[], system?: string): number {
  return estimateTokens((system ?? "") + "\n" + renderTranscript(messages));
}

export interface CompactionOptions {
  contextWindow: number;
  /** Output headroom to reserve for the response. */
  maxOutputTokens: number;
  /** Fraction of the window that triggers compaction (default 0.8). */
  threshold?: number;
  /** Recent messages kept verbatim (default 6). */
  keepRecentTurns?: number;
  summarize: (older: Message[]) => Promise<string>;
  /** Fired once when compaction is about to happen (over budget), before any mutation.
   *  The PreCompact lifecycle hook rides on this. */
  onBeforeCompact?: () => Promise<void>;
  /** Tokens the char/4 estimate can't see: the tool-schema block and fixed request overhead.
   *  Added to every occupancy estimate so compaction accounts for them. */
  overheadTokens?: number;
  /** The real input_tokens the gateway reported for the LAST request this turn. Messages only
   *  grow within a turn, so it's a lower bound on true occupancy — used to correct a
   *  systematic char/4 underestimate (code is ~3.3 chars/token) so compaction never fires
   *  too late and hits the model's hard limit. */
  knownFloorTokens?: number;
}

/** Effective occupancy: the larger of the char/4 estimate (+overhead) and the last real
 *  input count the gateway measured — the floor can't be undershot by an optimistic estimate. */
function occupancy(messages: Message[], system: string | undefined, opts: CompactionOptions): number {
  const est = estimateMessagesTokens(messages, system) + (opts.overheadTokens ?? 0);
  return Math.max(est, opts.knownFloorTokens ?? 0);
}

export interface CompactionResult {
  messages: Message[];
  compacted: boolean;
  /** The summary text, when compacted — persisted as a CompactEvent boundary. */
  summary?: string;
  summaryTokens?: number;
  /** How many messages the summary replaced (for reporting). */
  replaced?: number;
}

/** The synthetic user turn a summary becomes — shared by live compaction and reload. */
export function summaryHeader(summary: string): string {
  return `[Summary of earlier conversation]\n${summary}\n[End summary — continuing below]`;
}

/**
 * Largest cut index ≤ maxCut where `recent` begins with an assistant message. Cutting
 * before an assistant is always safe: an assistant message back-references nothing, and
 * any tool_results it triggers live in `recent` (so no tool_result is orphaned). The
 * prepended summary is a user message, giving a valid user→assistant→… alternation.
 * This works even in long autonomous runs that have no intermediate genuine user turns.
 */
function findCut(messages: Message[], maxCut: number): number {
  for (let i = Math.min(maxCut, messages.length - 1); i >= 1; i--) {
    if (messages[i]!.role === "assistant") return i;
  }
  return 0;
}

function prependSummary(recent: Message[], summary: string): Message[] {
  return [{ role: "user", content: summaryHeader(summary) }, ...recent];
}

/**
 * Microcompaction: the cheapest first line of defense. Old tool results are the bulkiest,
 * lowest-value tokens — replace their content (outside the recent window) with a stub
 * before resorting to whole-turn summarization. Returns new messages; no model call.
 */
export function microcompact(messages: Message[], keepRecentTurns: number, minChars = 600): Message[] {
  const cutoff = Math.max(0, messages.length - keepRecentTurns);
  return messages.map((m, i) => {
    if (i >= cutoff || m.role !== "user") return m;
    // Background-event batches are transient: outside the recent window the feed is stale (the
    // model's reaction is what persists), so stub them regardless of size — and since micro
    // always runs before summarization, they never leak into the summary either.
    if (typeof m.content === "string") {
      return m.content.startsWith(EVENTS_HEADER)
        ? { ...m, content: "[old background events cleared]" }
        : m;
    }
    const content = m.content.map((b) => {
      if (b.type === "text" && b.text.startsWith(EVENTS_HEADER)) {
        return { ...b, text: "[old background events cleared]" };
      }
      if (b.type !== "tool_result" || typeof b.content !== "string" || b.content.length < minChars) return b;
      return { ...b, content: `[old tool result cleared — ${b.content.length} chars]` };
    });
    return { ...m, content };
  });
}

export async function maybeCompact(
  messages: Message[],
  system: string | undefined,
  opts: CompactionOptions,
): Promise<CompactionResult> {
  const budget = Math.floor(opts.contextWindow * (opts.threshold ?? 0.8)) - opts.maxOutputTokens;
  if (budget <= 0) return { messages, compacted: false };
  if (occupancy(messages, system, opts) <= budget) return { messages, compacted: false };

  // Over budget → compaction will happen. Let the PreCompact hook observe/save first.
  await opts.onBeforeCompact?.();

  // Over budget: microcompact first — often enough, and costs no model call.
  const original = messages;
  const micro = microcompact(messages, opts.keepRecentTurns ?? 6);
  if (occupancy(micro, system, opts) <= budget) {
    return { messages: micro, compacted: true, summary: undefined, replaced: 0 };
  }
  const microShrank = micro !== original && occupancy(micro, system, opts) < occupancy(original, system, opts);

  const keep = opts.keepRecentTurns ?? 6;
  let cut = findCut(micro, micro.length - keep);
  // No safe cut with the default recent window (a short session whose recent turns alone
  // blow the budget — several big file reads). Shrink the recent window to find a cut that
  // ACTUALLY gets the kept portion under budget, rather than discarding the microcompaction
  // and riding into the model's hard limit. Only accept a shrunk cut that fits — if even a
  // single recent message exceeds budget, summarizing can't help.
  if (cut <= 0) {
    for (let k = keep - 1; k >= 1; k--) {
      const c = findCut(micro, micro.length - k);
      if (c > 0 && occupancy(micro.slice(c), system, opts) <= budget) {
        cut = c;
        break;
      }
    }
  }
  if (cut <= 0) {
    // Nothing safe/useful to summarize (e.g. one enormous single message) — still adopt the
    // micro shrink if it helped, rather than returning the un-shrunk original.
    return microShrank
      ? { messages: micro, compacted: true, summary: undefined, replaced: 0 }
      : { messages: original, compacted: false };
  }

  const older = micro.slice(0, cut);
  const recent = micro.slice(cut);
  const summary = await opts.summarize(older);
  return {
    messages: prependSummary(recent, summary),
    compacted: true,
    summary,
    summaryTokens: estimateTokens(summary),
    replaced: older.length,
  };
}
