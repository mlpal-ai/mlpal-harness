/**
 * C1 §7.4 (managed-v1): a HOP marks an abusive turn by ending its reply with one line, `[[mlpal:abuse reason=<token>]]`.
 * It needs no tool, so a tool-less HOP can raise it. The line never reaches the person: the loop strips it from the
 * assistant message it records and reports the reason on the run's result; a host streaming deltas holds a trailing
 * `[[mlpal:` line back until it knows (MarkerHoldback). A malformed marker is stripped and raises nothing.
 */
import type { Message } from "@mlpal/harness-protocol";

export const ABUSE_MARKER_PREFIX = "[[mlpal:abuse";
const TRAILING_MARKER = /(?:^|\n)[ \t]*\[\[mlpal:abuse\b[^\n]*\]\][ \t\n]*$/;
const WELL_FORMED = /^\[\[mlpal:abuse reason=([a-z0-9_]{1,32})\]\]$/;

/** The message without its trailing abuse marker, and the marker's reason (null when there is none, or it is
 *  malformed). Only the last line of the last text block counts. The message is returned as given when unmarked. */
export function stripAbuseMarker<M extends Message>(message: M): { message: M; reason: string | null } {
  const content = message.content;
  if (typeof content === "string" || content.length === 0) return { message, reason: null };
  const last = content[content.length - 1]!;
  if (last.type !== "text") return { message, reason: null };
  const m = TRAILING_MARKER.exec(last.text);
  if (!m) return { message, reason: null };
  const reason = WELL_FORMED.exec(m[0].trim())?.[1] ?? null;
  const text = last.text.slice(0, m.index).replace(/[ \t\n]+$/, "");
  return { message: { ...message, content: [...content.slice(0, -1), { ...last, text }] }, reason };
}

/** Text deltas with a trailing line that is, or may become, `[[mlpal:…` held back until it is complete. */
export class MarkerHoldback {
  private held = "";

  /** What may be shown now. */
  push(text: string): string {
    const all = this.held + text;
    const lineStart = all.lastIndexOf("\n") + 1;
    const tail = all.slice(lineStart);
    if (tail.length > 0 && ("[[mlpal:".startsWith(tail) || tail.startsWith("[[mlpal:"))) {
      this.held = tail;
      return all.slice(0, lineStart);
    }
    this.held = "";
    return all;
  }

  /** The stream's text ended (another kind of event, or the message): what was held, unless it is an abuse marker. */
  flush(): string {
    const h = this.held;
    this.held = "";
    return h.trim().startsWith(ABUSE_MARKER_PREFIX) && h.trim().endsWith("]]") ? "" : h;
  }

  /** The stream restarted (a `reset` delta): what was held is stale. */
  reset(): void {
    this.held = "";
  }
}
