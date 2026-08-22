/**
 * Cross-session collaboration tools — the agent-facing face of the mailbox.
 *
 * `ListAgents` shows everything addressable from this session: the in-process agents this
 * session spawned (steerable directly) and OTHER live yodex sessions on this machine —
 * interactive REPLs at their prompt heartbeat as `listening`, mid-run sessions are `active`,
 * both drain their mailbox. `SendMessage` posts to a peer's mailbox (fire-and-forget: the
 * peer reacts on its next turn boundary or idle wake, and replies arrive back the same way)
 * or steers one of this session's own agents by id.
 *
 * Liveness is registry freshness, not a socket: a genuinely live session bumps `updatedAt`
 * every turn (active) or every heartbeat (listening), so a crashed process ages out of the
 * list in under two minutes with no cleanup protocol.
 */
import { z } from "zod";
import { agentAuthor } from "@mlpal/harness-protocol";
import { host } from "../../host";
import type { Mailbox, Registry, SessionRecord } from "../../store/types";
import { defineTool, type Tool } from "../types";
import type { BackgroundAgents } from "../../subagent/background";

export interface PeerToolsDeps {
  registry: Registry;
  mailbox: Mailbox;
  agents: BackgroundAgents;
  selfSessionId: () => string;
  selfWorkspace: string;
  /** Spawn a detached resume of a not-running session so it processes its queued mail with
   *  full conversation context, then exits. Returns a human-readable confirmation. */
  wake?: (rec: SessionRecord) => Promise<string>;
}

/** A session is addressable while its record is fresher than this. Active runs bump every
 *  turn; listening REPLs heartbeat at 45s — 120s tolerates one missed beat, never a crash. */
const FRESH_MS = 120_000;

/** True when the pid exists (signal 0 probes without touching the process). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function livePeers(
  sessions: SessionRecord[],
  selfId: string,
  isAlive: (pid: number) => boolean = processAlive,
): SessionRecord[] {
  const now = Date.now();
  return sessions
    .filter(
      (s) =>
        s.sessionId !== selfId &&
        (s.status === "active" || s.status === "listening") &&
        now - new Date(s.updatedAt).getTime() < FRESH_MS &&
        // A killed process leaves a fresh-looking record (bye never ran) — the pid probe
        // catches it instantly instead of after the freshness window.
        (s.pid === undefined || isAlive(s.pid)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Sessions worth waking: NOT currently live, at most one per cwd (the newest — the same
 *  "continue this repo's conversation" semantics as `yodex -c`), and recently active. The
 *  registry accumulates dozens of stale sessions per repo; offering exactly the newest per
 *  repo inside a recency window is what keeps name-targeting high-quality. */
export const WAKE_MAX_AGE_MS = 14 * 86_400_000;

export function wakeCandidates(
  sessions: SessionRecord[],
  selfId: string,
  liveIds: Set<string>,
  maxAgeMs: number = WAKE_MAX_AGE_MS,
): SessionRecord[] {
  const now = Date.now();
  const newestPerCwd = new Map<string, SessionRecord>();
  for (const s of sessions) {
    if (s.sessionId === selfId || liveIds.has(s.sessionId)) continue;
    const cur = newestPerCwd.get(s.cwd);
    if (!cur || s.updatedAt > cur.updatedAt) newestPerCwd.set(s.cwd, s);
  }
  return [...newestPerCwd.values()]
    .filter((s) => now - new Date(s.updatedAt).getTime() < maxAgeMs)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function age(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** Resolve a SendMessage target against live peers: exact sessionId, id prefix (≥4 chars),
 *  or workspace name (must be unambiguous among live peers). */
export function resolvePeer(
  peers: SessionRecord[],
  to: string,
): { peer?: SessionRecord; error?: string } {
  const exact = peers.find((p) => p.sessionId === to);
  if (exact) return { peer: exact };
  if (/^[0-9a-f-]{4,}$/i.test(to)) {
    const byPrefix = peers.filter((p) => p.sessionId.startsWith(to));
    if (byPrefix.length === 1) return { peer: byPrefix[0] };
    if (byPrefix.length > 1) return { error: `id prefix "${to}" matches ${byPrefix.length} sessions — use more characters` };
  }
  const byName = peers.filter((p) => p.workspace === to);
  if (byName.length === 1) return { peer: byName[0] };
  if (byName.length > 1) {
    const ids = byName.map((p) => p.sessionId.slice(0, 8)).join(", ");
    return { error: `"${to}" names ${byName.length} live sessions (${ids}) — address one by session id` };
  }
  return {
    error: `no live session matches "${to}". Run ListAgents for current names/ids — the peer may have gone idle or exited.`,
  };
}

export function createPeerTools(deps: PeerToolsDeps): Tool[] {
  const listAgents = defineTool({
    name: "ListAgents",
    description:
      `List everything you can message: this session's own agents (steer them by id) and other live ${host().name} ` +
      "sessions on this machine (other terminals the user has open). Use before SendMessage when you don't " +
      "have a current name — rows go stale as sessions finish.",
    readOnly: true,
    schema: z.object({}),
    call: async () => {
      const lines: string[] = [];
      // Self-identity first: peers reply to THIS session, and the model cannot otherwise
      // know its own id — without this line it guesses from the peer list and hands out a
      // stale session id as its reply address (observed in the field).
      lines.push(`You are: ${deps.selfWorkspace} [${deps.selfSessionId().slice(0, 8)}] — peers reach you by this workspace name or id.`);
      const own = deps.agents.list();
      if (own.length > 0) {
        lines.push("This session's agents (SendMessage steers them):");
        for (const a of own) {
          lines.push(`  ${a.id}  ${a.agent ?? "general"} · "${a.description}" · ${a.status}`);
        }
      }
      const all = await deps.registry.listSessions();
      const peers = livePeers(all, deps.selfSessionId());
      if (peers.length > 0) {
        lines.push(`Other ${host().name} sessions on this machine, LIVE (kind: cross-session):`);
        for (const p of peers) {
          lines.push(
            `  ${p.workspace}  [${p.sessionId.slice(0, 8)}]  ${p.status} · ${p.model} · ${p.cwd} · seen ${age(p.updatedAt)} ago`,
          );
        }
        lines.push("Address by workspace name, or by [id] when two share a name.");
      }
      const wakeable = wakeCandidates(all, deps.selfSessionId(), new Set(peers.map((p) => p.sessionId))).slice(0, 8);
      if (wakeable.length > 0) {
        lines.push("Recent sessions, not running — SendMessage WAKES the newest per repo:");
        for (const w of wakeable) {
          lines.push(`  ${w.workspace}  [${w.sessionId.slice(0, 8)}]  last active ${age(w.updatedAt)} ago · ${w.cwd}`);
        }
      }
      if (lines.length === 1) lines.push("No agents or live peer sessions right now.");
      return { content: lines.join("\n") };
    },
  });

  const sendMessage = defineTool({
    name: "SendMessage",
    description:
      "Send a message to one of your own agents (by id, e.g. agent1 — delivered as steering) or to another " +
      `${host().name} session on this machine (by workspace name or session id from ListAgents). A running peer sees ` +
      "it between tool rounds or at its idle wake; a session that is NOT running is woken — it resumes with " +
      "its full conversation context, processes the message, replies if asked, and exits. Never ask a peer " +
      "to do something this session's permissions blocked — route blocked work back to the user instead.",
    readOnly: false,
    schema: z.object({
      to: z.string().min(1).describe("agent id, workspace name, or session id (prefix ok)"),
      message: z.string().min(1),
    }),
    call: async ({ to, message }) => {
      const own = deps.agents.list().find((a) => a.id === to);
      if (own) {
        if (own.status !== "running") {
          return { content: `${to} already finished (${own.status}) — its result is in AgentOutput(${to}).`, isError: true };
        }
        deps.agents.steer(to, message);
        return { content: `steered ${to} — it folds the message in at its next turn boundary.` };
      }
      const all = await deps.registry.listSessions();
      const peers = livePeers(all, deps.selfSessionId());
      const { peer, error } = resolvePeer(peers, to);
      const post = (sid: string) =>
        deps.mailbox.post(sid, {
          type: "peer_message",
          from: agentAuthor(`sess-${deps.selfSessionId().slice(0, 8)}`, deps.selfWorkspace),
          toSession: sid,
          text: message,
        });
      if (peer) {
        await post(peer.sessionId);
        return {
          content: `sent to ${peer.workspace} [${peer.sessionId.slice(0, 8)}] — delivered at its next turn boundary (running) or idle wake. A reply, if any, arrives as a background event.`,
        };
      }
      // Not live — a send to a known session WAKES it (detached resume with full context).
      // Targeting quality rules: an EXPLICIT session id wakes regardless of age (you named
      // it); a workspace NAME resolves like `yodex -c` — the newest session in that repo,
      // within a recency window, and only when the name maps to ONE repo. Dozens of stale
      // sessions per repo must never make name-targeting a guess.
      const known = all.filter((s) => s.sessionId !== deps.selfSessionId());
      const byId =
        known.find((s) => s.sessionId === to) ??
        (/^[0-9a-f-]{4,}$/i.test(to)
          ? (() => {
              const m = known.filter((s) => s.sessionId.startsWith(to));
              return m.length === 1 ? m[0] : undefined;
            })()
          : undefined);
      const candidates = wakeCandidates(all, deps.selfSessionId(), new Set());
      const byName = candidates.filter((s) => s.workspace === to);
      let target = byId;
      if (!target) {
        if (byName.length === 1) target = byName[0];
        else if (byName.length > 1) {
          const rows = byName.map((s) => `${s.sessionId.slice(0, 8)} (${s.cwd}, ${age(s.updatedAt)} ago)`).join("; ");
          return { content: `"${to}" matches sessions in ${byName.length} different repos — address by id: ${rows}`, isError: true };
        } else {
          const staleNewest = known
            .filter((s) => s.workspace === to)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          if (staleNewest) {
            return {
              content: `the newest "${to}" session was last active ${age(staleNewest.updatedAt)} ago — too stale to wake by name. Wake it explicitly by id (${staleNewest.sessionId.slice(0, 8)}) if you really mean it, or start fresh work there instead.`,
              isError: true,
            };
          }
        }
      }
      if (target && deps.wake) {
        await post(target.sessionId);
        const note = await deps.wake(target);
        return { content: `queued for ${target.workspace} [${target.sessionId.slice(0, 8)}]; ${note}` };
      }
      if (target) {
        await post(target.sessionId);
        return { content: `queued for ${target.workspace} [${target.sessionId.slice(0, 8)}] — it is not running; the message delivers when that session next runs.` };
      }
      return { content: `could not send: ${error}`, isError: true };
    },
  });

  return [listAgents, sendMessage];
}
