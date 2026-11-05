/**
 * C1 §7.4 (managed-v1): a HOP marks an abusive turn with `[[mlpal:abuse reason=<token>]]`. It should be the reply's last
 * line, but a model sometimes writes it inline, so the engine is tolerant: every occurrence, anywhere in the reply's
 * text, is stripped from the assistant message the loop records (and from the next call's history), and the first
 * well-formed reason rides the run's result, so a turn raises at most one flag. A malformed marker is stripped and
 * raises nothing. A host streaming deltas holds back any tail that may be the start of a marker (MarkerHoldback), so no
 * marker, whole or split across chunks, reaches the person.
 */
import type { Message } from "@mlpal/harness-protocol";

export const ABUSE_MARKER_PREFIX = "[[mlpal:abuse";
/** A marker, closed, or unclosed at the very end of the text; with the spaces around it. */
const MARKER = /[ \t]*\[\[mlpal:abuse\b[^\]\n]*(?:\]\]|$)[ \t]*/g;
const WELL_FORMED = /^\[\[mlpal:abuse reason=([a-z0-9_]{1,32})\]\]$/;
/** Past this many characters an unclosed `[[mlpal:abuse` is not a marker the stream waits for. */
const MAX_HELD = 256;

/** `text` without its markers, and the first well-formed marker's reason (null when none is). */
function strip(text: string): { text: string; reason: string | null; found: boolean } {
  let reason: string | null = null;
  let found = false;
  const out = text.replace(MARKER, (m, offset: number, whole: string) => {
    found = true;
    reason ??= WELL_FORMED.exec(m.trim())?.[1] ?? null;
    // A marker between words leaves one space; at a line's edge, none.
    const before = whole[offset - 1];
    const after = whole[offset + m.length];
    return before && after && before !== "\n" && after !== "\n" ? " " : "";
  });
  return { text: found ? out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim() : text, reason, found };
}

/** The message without any abuse marker in its text blocks, and the first well-formed reason (null when there is
 *  none, or every marker is malformed). The message is returned as given when it holds no marker. */
export function stripAbuseMarker<M extends Message>(message: M): { message: M; reason: string | null } {
  const content = message.content;
  if (typeof content === "string" || content.length === 0) return { message, reason: null };
  let reason: string | null = null;
  let found = false;
  const next = content.map((b) => {
    if (b.type !== "text") return b;
    const s = strip(b.text);
    if (!s.found) return b;
    found = true;
    reason ??= s.reason;
    return { ...b, text: s.text };
  });
  return found ? { message: { ...message, content: next }, reason } : { message, reason: null };
}

/** The start of a tail that is, or may become, a marker: `[`, `[[`, `[[m`… up to an unclosed `[[mlpal:abuse…`. */
function markerTail(s: string): number {
  for (let i = Math.max(0, s.length - MAX_HELD); i < s.length; i++) {
    if (s[i] !== "[") continue;
    const tail = s.slice(i);
    if (ABUSE_MARKER_PREFIX.startsWith(tail)) return i;
    if (tail.startsWith(ABUSE_MARKER_PREFIX) && !tail.includes("]]") && !tail.includes("\n")) return i;
  }
  return -1;
}

/** Text deltas with every marker removed, and a tail that may be the start of one held back until it is known. */
export class MarkerHoldback {
  private held = "";

  /** What may be shown now. */
  push(text: string): string {
    const all = removeMarkers(this.held + text);
    const at = markerTail(all);
    if (at < 0) {
      this.held = "";
      return all;
    }
    this.held = all.slice(at);
    return all.slice(0, at);
  }

  /** The stream's text ended (another kind of event, or the message): what was held, unless it is an unclosed marker
   *  (the recorded message drops that too). */
  flush(): string {
    const h = this.held;
    this.held = "";
    return h.startsWith(ABUSE_MARKER_PREFIX) ? "" : h;
  }

  /** The stream restarted (a `reset` delta): what was held is stale. */
  reset(): void {
    this.held = "";
  }
}

/** Closed markers out of streamed text, keeping the text's own spacing otherwise (a delta is not a whole reply). */
function removeMarkers(s: string): string {
  return s.replace(/\[\[mlpal:abuse\b[^\]\n]*\]\]/g, "");
}
