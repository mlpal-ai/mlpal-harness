import { EVENTS_HEADER } from "../events/inbox";
import type { SessionRecord, Store } from "./types";

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
}

async function firstUserPreview(store: Store, sessionId: string): Promise<string> {
  const entries = await store.conversation.read(sessionId);
  const turn = entries.find((e) => e.payload.type === "user");
  if (!turn || turn.payload.type !== "user") return "(empty)";
  const content = turn.payload.message.content;
  const text = typeof content === "string" ? content : "[content]";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 72 ? `${flat.slice(0, 72)}…` : flat || "(empty)";
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
    records.map(async (record) => ({ record, preview: await firstUserPreview(store, record.sessionId) })),
  );
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
    const entries = await store.conversation.read(rec.sessionId);
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
