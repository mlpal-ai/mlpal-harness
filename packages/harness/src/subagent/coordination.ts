import { z } from "zod";
import { defineTool, type Tool } from "../tools/types";
import { host } from "../host";

/**
 * Cross-repo agent coordination. yodex keeps every session in ONE global store, so an
 * agent working in repo A can discover an agent in repo B and hand it work — the flagship
 * differentiator over single-repo agents. Two tools, both with host-injected runners so the
 * engine stays decoupled from process/spawn concerns:
 *
 *   ListPeers   — discover other agents/sessions across repos (who's working where).
 *   HandoffTask — delegate a task to another repo and get its result back. The host either
 *                 routes to a live agent there (mailbox round-trip) or dispatches a fresh
 *                 agent in that repo (spawn); either way the caller blocks until a result.
 */

export interface PeerInfo {
  sessionId: string;
  workspace: string;
  cwd: string;
  status: "active" | "idle" | "done" | "error";
  model: string;
  updatedAt: string;
}

export type ListPeers = () => Promise<PeerInfo[]>;

export type HandoffRun = (
  args: { repo: string; task: string },
  signal?: AbortSignal,
) => Promise<{ text: string; sessionId: string; via: "live-agent" | "dispatch" }>;

export function createListPeersTool(list: ListPeers): Tool<Record<string, never>> {
  const norm = (p: string) => p.replace(/\/+$/, "");
  return defineTool({
    name: "ListPeers",
    description:
      `List ${host().name} agents/sessions in OTHER repositories (their workspace, working directory, status, and model). Use this to see what work is happening elsewhere before handing off a cross-repo change with HandoffTask.`,
    readOnly: true,
    schema: z.object({}),
    async call(_input, ctx) {
      // Peers = sessions in a different working directory (this repo's own sessions aren't peers).
      // Bounded: newest session per repo, active-or-recent only — the registry holds hundreds of
      // finished sessions, and dumping them (once 1,699 lines) buries the useful rows.
      const RECENT_MS = 7 * 86_400_000;
      const newestPerCwd = new Map<string, PeerInfo>();
      for (const p of (await list()).filter((p) => norm(p.cwd) !== norm(ctx.cwd))) {
        const cur = newestPerCwd.get(norm(p.cwd));
        if (!cur || p.updatedAt > cur.updatedAt) newestPerCwd.set(norm(p.cwd), p);
      }
      const peers = [...newestPerCwd.values()]
        .filter((p) => p.status === "active" || Date.now() - new Date(p.updatedAt).getTime() < RECENT_MS)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 25);
      if (peers.length === 0) {
        return {
          content:
            "No agents/sessions in other repos yet. HandoffTask can still dispatch a fresh agent into another repo by absolute path.",
        };
      }
      const lines = peers.map(
        (p) =>
          `• ${p.workspace} [${p.status}] — session ${p.sessionId.slice(0, 8)}, ${p.model}\n    cwd: ${p.cwd}`,
      );
      return { content: `Agents/sessions in other repos:\n${lines.join("\n")}` };
    },
  });
}

export function createHandoffTool(run: HandoffRun): Tool<{ repo: string; task: string }> {
  return defineTool({
    name: "HandoffTask",
    description:
      "Hand off a self-contained code change to another repository and get the result back. Use when the current task needs work in a DIFFERENT repo. `repo` is a workspace name (from ListPeers) or an absolute path to the target repo. `task` is complete, standalone instructions — the other agent does not see this conversation. If an agent is already working in that repo, the task is routed to it; otherwise a fresh agent is dispatched there. Blocks until the other repo reports back.",
    readOnly: false,
    schema: z.object({
      repo: z.string().describe("target repo: a workspace name from ListPeers, or an absolute path"),
      task: z.string().describe("complete, standalone instructions for the other repo's agent"),
    }),
    async call(input, ctx) {
      try {
        const { text, via } = await run({ repo: input.repo, task: input.task }, ctx.signal);
        const tag = via === "live-agent" ? "the agent already working there" : "a freshly dispatched agent";
        return { content: `[Handoff to ${input.repo}, handled by ${tag}]\n\n${text || "(no result returned)"}` };
      } catch (e) {
        return { content: `Handoff to ${input.repo} failed: ${(e as Error).message}`, isError: true };
      }
    },
  });
}
