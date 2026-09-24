import type { Message } from "@mlpal/harness-protocol";
import type { ModelClient } from "../gateway/client";
import type { PermissionRequest } from "./engine";

/**
 * The permission judge: a cheap-tier classifier that decides a request the cascade would
 * otherwise put to the human. It is a property of the mode, not a fifth mode — the host runs
 * it in cruise (where command execution asks) and never in manual (manual means "ask me").
 *
 * Three verdicts. `allow` proceeds with the reason on record; `deny` names the rule and tells
 * the model to find a safer route; `unsure` falls through to the prompt. Fail-safe by
 * construction: a timeout, an error or an unparseable reply is `unsure`, so a bad judge can
 * only ever ask more, never allow more.
 */

export type JudgeVerdict = "allow" | "deny" | "unsure";

export interface JudgeDecision {
  verdict: JudgeVerdict;
  reason: string;
  /** Wall time of the consult, for the usage panel. */
  ms: number;
}

export interface JudgeContext {
  /** The HOP's name, for the record. */
  hop: string;
  /** What the HOP is for, one paragraph: the judge decides "in scope" against it. */
  purpose: string;
  /** The user's allow/deny rules, verbatim (`Bash(git*)`), so the judge reasons with the same vocabulary. */
  allow: string[];
  deny: string[];
  /** Workspace roots: writes and reads outside them are the first thing the judge looks for. */
  roots: string[];
  /** The task being worked on, when known — an action is judged against what was asked. */
  task?: string;
}

export interface CreateJudgeOptions {
  model_client: ModelClient;
  /** Cheap-tier model. */
  model: string;
  context: () => JudgeContext;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export type PermissionJudge = (req: PermissionRequest) => Promise<JudgeDecision>;

export const JUDGE_SYSTEM = `You are the permission judge for an autonomous software agent running inside a Harness Operating Profile (HOP). The agent wants to perform a tool call that its policy would otherwise stop and ask a human about. Decide for the human.

Answer ALLOW when the action is routine for the HOP's purpose and task, reversible or confined to the workspace roots, and does not touch credentials, other people's systems or the wider machine. Examples: running the project's tests or build, git status/diff/log/add/commit on the workspace, installing project dependencies, reading project files, starting a local dev server.

Answer DENY when the action would exfiltrate data or secrets (piping files or environment to the network, reading credential stores), escalate privilege (sudo, changing system settings, persistence via cron/launchd/systemd/shell profiles), destroy data outside the workspace, push/publish/deploy/send to shared or external systems, or plainly falls outside the HOP's purpose. Also DENY when the command hides its intent (obfuscation, base64-decoded execution, curl-pipe-shell).

Answer UNSURE when you cannot tell — the human decides. Prefer UNSURE over ALLOW whenever an ALLOW could be wrong in a way the human would care about.

Reply with one JSON object and nothing else: {"verdict": "allow" | "deny" | "unsure", "reason": "<one sentence, specific to this action>"}`;

function extractText(content: Message["content"]): string {
  return typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function subjectOf(req: PermissionRequest): string {
  if (req.toolName === "Bash") return String(req.input.command ?? "");
  if (typeof req.input.path === "string") return req.input.path;
  return JSON.stringify(req.input).slice(0, 2000);
}

export function createPermissionJudge(opts: CreateJudgeOptions): PermissionJudge {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return async (req) => {
    const started = Date.now();
    const ctx = opts.context();
    const ac = new AbortController();
    // The clock is ours, not the model client's: a client that ignores the signal must not hold
    // the gate open — the race resolves to unsure at the deadline regardless.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new Error("deadline"));
      }, timeoutMs);
    });
    try {
      const user = [
        `HOP: ${ctx.hop}`,
        `Purpose: ${ctx.purpose}`,
        `Workspace roots: ${ctx.roots.join(", ")}`,
        ctx.allow.length ? `Allow rules: ${ctx.allow.join(", ")}` : "Allow rules: (none)",
        ctx.deny.length ? `Deny rules: ${ctx.deny.join(", ")}` : "Deny rules: (none)",
        ctx.task ? `Task: ${ctx.task.slice(0, 1500)}` : undefined,
        "",
        `Tool: ${req.toolName}`,
        `Action:\n${subjectOf(req)}`,
      ]
        .filter((l): l is string => l !== undefined)
        .join("\n");
      const consult = async () => {
        const gen = opts.model_client.stream({
          model: opts.model,
          system: JUDGE_SYSTEM,
          messages: [{ role: "user", content: user } satisfies Message],
          maxTokens: opts.maxOutputTokens ?? 200,
          signal: ac.signal,
        });
        let r = await gen.next();
        while (!r.done) r = await gen.next();
        return extractText(r.value.message.content);
      };
      const m = (await Promise.race([consult(), deadline])).match(/\{[\s\S]*\}/);
      if (m) {
        const o = JSON.parse(m[0]) as { verdict?: unknown; reason?: unknown };
        const verdict = typeof o.verdict === "string" ? o.verdict.toLowerCase() : "";
        if (verdict === "allow" || verdict === "deny" || verdict === "unsure") {
          return { verdict, reason: typeof o.reason === "string" && o.reason.trim() ? o.reason.trim() : `judge said ${verdict}`, ms: Date.now() - started };
        }
      }
      return { verdict: "unsure", reason: "judge reply was not a verdict", ms: Date.now() - started };
    } catch (e) {
      const why = ac.signal.aborted ? `judge timed out after ${Math.round(timeoutMs / 1000)}s` : `judge failed: ${String((e as Error)?.message ?? e)}`;
      return { verdict: "unsure", reason: why, ms: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  };
}
