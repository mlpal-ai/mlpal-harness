import type { ConversationEntry, Message } from "@mlpal/harness-protocol";
import { attachedDocumentName } from "../context/attachments";
import { EVENTS_HEADER } from "../events/inbox";
import type { SessionRecord, Store } from "./types";
import { effectiveEntries } from "../loop/messages";

/**
 * Resume helpers over the unified store. Sessions live in one place; we filter by `cwd`
 * to show "this project's" sessions (a per-project session list),
 * but the data is global so you can also list/resume across projects and steer any of
 * them via the inter-agent layer.
 */
export interface SessionInfo {
  record: SessionRecord;
  /** First user message, trimmed — for the resume picker. */
  preview: string;
  /** Last assistant reply, trimmed — what the session is up to. Empty when none. */
  lastReply: string;
}

/** How long a title or a reply preview may be (protocol SessionSummary: "trimmed"). */
const CLIP_CHARS = 72;

/** Whitespace collapsed, cut to CLIP_CHARS with an ellipsis, and well-formed: half a character (a cut inside a surrogate
 *  pair, or a lone one in the text) is JSON no parser after us builds a string of, so the session store would fold the
 *  record that carries it as one without data. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= CLIP_CHARS) return flat.toWellFormed();
  const high = flat.charCodeAt(CLIP_CHARS - 1);
  return `${flat.slice(0, high >= 0xd800 && high <= 0xdbff ? CLIP_CHARS - 1 : CLIP_CHARS).toWellFormed()}…`;
}

/** The page-context data block a hosted serve puts ahead of a prompt (yodex page-context.ts, protocol 0.26.0 C2): what
 *  the browser said about the page, never the person's words. */
const PAGE_CONTEXT_BLOCK = /<page_context>[\s\S]*?<\/page_context>\n*/g;

/**
 * A user turn as a listing titles it: the person's words, trimmed, without the page-context block or the text files
 * attached to the turn (E-23: a file is not a title); else the names of those files; else what an attachment-only turn
 * holds (`[image, document]`). "" for a turn with nothing in it.
 */
export function userTurnTitle(content: Message["content"]): string {
  if (typeof content === "string") return clip(content.replace(PAGE_CONTEXT_BLOCK, ""));
  const words: string[] = [];
  const files: string[] = [];
  const kinds = new Set<string>();
  for (const b of content) {
    if (b.type !== "text") {
      kinds.add(b.type);
      continue;
    }
    const file = attachedDocumentName(b.text);
    if (file === undefined) words.push(b.text.replace(PAGE_CONTEXT_BLOCK, ""));
    else if (file) files.push(file);
    else kinds.add("document");
  }
  return clip(words.join(" ")) || clip(files.join(", ")) || (kinds.size ? `[${[...kinds].join(", ")}]` : "");
}

/** An assistant reply as a listing previews it: its text, trimmed; "" for a reply of tool calls alone. */
export function replyPreview(content: Message["content"]): string {
  return clip(typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join(" "));
}

/** What a listing shows of a session's conversation: the first user turn's title (undefined before there is one, ""
 *  when it held nothing) and the last assistant reply that has text ("" before one). */
export interface ConversationSummary {
  title: string | undefined;
  lastReply: string;
}

export const EMPTY_SUMMARY: ConversationSummary = { title: undefined, lastReply: "" };

/** The summary of a conversation's effective entries (a rewind takes back what it rewound). */
export function summarizeConversation(entries: ConversationEntry[]): ConversationSummary {
  let s = EMPTY_SUMMARY;
  for (const e of effectiveEntries(entries)) s = summaryAfter(s, e, entries);
  return s;
}

/**
 * The summary once `entry` is appended, incrementally: `entries` is the whole log with `entry` already in it, read only
 * when a rewind changes what is effective. The same answer as summarizeConversation over that log. An entry read from a
 * remote log without a payload or a message (another writer's) changes nothing: opening the session never fails on it.
 */
export function summaryAfter(s: ConversationSummary, entry: ConversationEntry, entries: ConversationEntry[]): ConversationSummary {
  const p = entry.payload as ConversationEntry["payload"] | undefined;
  if (p?.type === "rewind") return summarizeConversation(entries);
  if (p?.type === "user" && p.message && s.title === undefined) return { ...s, title: userTurnTitle(p.message.content) };
  if (p?.type === "assistant" && p.message) {
    const reply = replyPreview(p.message.content);
    if (reply) return { ...s, lastReply: reply };
  }
  return s;
}

/** A session's first user message and last assistant reply, trimmed: its title and what it is up to. */
export async function sessionPreviews(store: Store, sessionId: string): Promise<{ first: string; last: string }> {
  const s = summarizeConversation(await store.conversation.read(sessionId));
  return { first: s.title || "(empty)", last: s.lastReply };
}

export async function recentSessions(
  store: Store,
  opts: { cwd?: string; limit?: number } = {},
): Promise<SessionInfo[]> {
  let records = await store.registry.listSessions();
  if (opts.cwd) records = records.filter((r) => r.cwd === opts.cwd);
  records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (opts.limit) records = records.slice(0, opts.limit);
  return Promise.all(
    records.map(async (record) => {
      const p = await sessionPreviews(store, record.sessionId);
      return { record, preview: p.first, lastReply: p.last };
    }),
  );
}

/** Resolve a session reference: a full id, an id prefix (8+ chars), or a /rename'd name (exact,
 *  case-insensitive; the most recently updated wins). Undefined when nothing matches. */
export async function resolveSessionRef(store: Store, ref: string): Promise<string | undefined> {
  const records = await store.registry.listSessions();
  const exact = records.find((r) => r.sessionId === ref);
  if (exact) return exact.sessionId;
  const named = records.filter((r) => r.name && r.name.toLowerCase() === ref.toLowerCase()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (named[0]) return named[0].sessionId;
  if (ref.length >= 8) {
    const prefixed = records.filter((r) => r.sessionId.startsWith(ref));
    if (prefixed.length === 1) return prefixed[0]!.sessionId;
  }
  return undefined;
}

export async function mostRecentSessionId(store: Store, cwd?: string): Promise<string | undefined> {
  // Prefer the newest HUMAN session: routine firings spawn sessions in the same cwd, and
  // "continue" must mean the user's own conversation, not last night's scheduled run.
  const all = await recentSessions(store, { cwd, limit: 20 });
  const human = all.find((s) => !s.record.origin);
  return (human ?? all[0])?.record.sessionId;
}

/** Flatten a user turn's content (string, or text blocks with attachments) to plain text. */
function userTurnText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: string }).text ?? "") : ""))
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Recent *distinct* human prompts for a project, oldest→newest, for Up-arrow recall across
 * sessions. Derived from the unified store (not a parallel file): the newest `sessions`
 * sessions for this cwd are read, human-authored user turns collected in time order, then
 * **fully de-duplicated — each distinct prompt kept once at its most-recent position** — so a
 * prompt typed across many sessions (e.g. "hi") doesn't recur down the history. Peer/agent-
 * and system-injected turns are excluded (only what the person typed). The result is capped to
 * `limit` most-recent entries so Up walks a short, clean list, not months of backlog. Reads are
 * bounded by `sessions` so startup cost stays small.
 */
export async function recentPrompts(
  store: Store,
  opts: { cwd?: string; sessions?: number; limit?: number } = {},
): Promise<string[]> {
  const sessionCap = opts.sessions ?? 25;
  const limit = opts.limit ?? 100;
  let records = await store.registry.listSessions();
  if (opts.cwd) records = records.filter((r) => r.cwd === opts.cwd);
  records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)); // oldest→newest
  const recent = records.slice(-sessionCap);

  const collected: { ts: string; text: string }[] = [];
  for (const rec of recent) {
    const entries = effectiveEntries(await store.conversation.read(rec.sessionId));
    for (const e of entries) {
      if (e.payload.type !== "user") continue;
      // Only turns the person actually typed — not peer agents' or system-injected turns.
      if (e.payload.author && e.payload.author.type !== "human") continue;
      const text = userTurnText(e.payload.message.content);
      // Event-reaction seeds ride as human turns but are machine text — keep them out of Up-arrow.
      if (text && !text.startsWith(EVENTS_HEADER)) collected.push({ ts: e.payload.ts ?? e.ts, text });
    }
  }
  collected.sort((a, b) => a.ts.localeCompare(b.ts));

  // Full dedup, most-recent-wins: walk newest→oldest, keep first sighting of each prompt.
  const seen = new Set<string>();
  const newestFirst: string[] = [];
  for (let i = collected.length - 1; i >= 0; i--) {
    const text = collected[i]!.text;
    if (seen.has(text)) continue;
    seen.add(text);
    newestFirst.push(text);
    if (newestFirst.length >= limit) break;
  }
  return newestFirst.reverse(); // back to oldest→newest for the editor to walk backward
}
