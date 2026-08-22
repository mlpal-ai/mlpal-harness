import type { Author } from "@mlpal/harness-protocol";
import { catastrophicDeny, contentSafetyDeny, redirectTargets, splitShellCommands } from "./safety";

/**
 * Permission engine: a deny → allow → mode-default cascade. Pure data + string
 * matching, no model coupling. The `principal`
 * field distinguishes a human turn from a peer-agent-injected turn so peer actions
 * can be governed differently once inter-agent collaboration lands. See docs/05 §6/§7.
 */

/**
 * Autonomy levels, escalating by how much the agent does without asking:
 *   recon     — read-only; can read/search but not edit or run commands
 *   manual    — ask before every change (the safe default)
 *   cruise    — auto-approve file edits; still ask before running commands
 *   autopilot — allow everything, no prompts (sandboxes / CI / autonomous runs)
 */
export type PermissionMode = "recon" | "manual" | "cruise" | "autopilot";

export type Decision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; reason?: string };

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  readOnly: boolean;
  /** A file edit (Write/Edit) — auto-approved in accept-edits mode. */
  isEdit: boolean;
  principal: Author;
}

export interface PermissionConfig {
  mode: PermissionMode;
  /** Rules like "Read", "Bash", or "Bash(git*)" — trailing * is a wildcard. */
  allow?: string[];
  deny?: string[];
}

export type CanUseTool = (req: PermissionRequest) => Decision | Promise<Decision>;

export function createPolicy(config: PermissionConfig): CanUseTool {
  const deny = config.deny ?? [];
  const allow = config.allow ?? [];
  return (req) => {
    // Layer 0: the deterministic safety authority. Bypass-immune — no mode, allow-rule,
    // or model choice can override it. This is the whole point: allow is earned, deny is absolute.
    const hard = hardDeny(req);
    if (hard) return { behavior: "deny", reason: hard };

    for (const rule of deny) {
      if (denyMatches(rule, req)) return { behavior: "deny", reason: `denied by rule "${rule}"` };
    }
    for (const rule of allow) {
      if (ruleMatches(rule, req)) return { behavior: "allow" };
    }
    return defaultForMode(config.mode, req);
  };
}

/** The bypass-immune deny checks: catastrophic commands + protected-path writes. */
function hardDeny(req: PermissionRequest): string | null {
  if (req.toolName === "Bash") {
    const command = String(req.input.command ?? "");
    const cat = catastrophicDeny(command);
    if (cat) return cat;
    for (const target of redirectTargets(command)) {
      const cs = contentSafetyDeny(target);
      if (cs) return cs;
    }
    return null;
  }
  // File-writing tools: block protected paths (git internals, private keys, credentials).
  if ((req.toolName === "Write" || req.toolName === "Edit") && typeof req.input.path === "string") {
    return contentSafetyDeny(req.input.path);
  }
  return null;
}

/** The decision a mode makes for a request on its own — before allow/deny rules. Exported so the
 *  interactive gate can re-evaluate against the *live* mode: the session's policy captured the mode
 *  at run start, so raising autonomy mid-run (Shift+Tab) must be re-applied here to take effect. By
 *  the time a prompt fires, rules have already been consulted (a deny/allow rule resolves before the
 *  gate), so the live mode's own decision is the whole answer. */
export function defaultForMode(mode: PermissionMode, req: PermissionRequest): Decision {
  switch (mode) {
    case "autopilot":
      // allow everything, no prompts (sandboxes, CI, autonomous runs).
      return { behavior: "allow" };
    case "cruise":
      // reads + file edits go through; command execution and anything else (Bash, MCP,
      // web) still asks — that's where irreversible damage lives.
      return req.readOnly || req.isEdit ? { behavior: "allow" } : { behavior: "ask" };
    case "recon":
      return req.readOnly
        ? { behavior: "allow" }
        : { behavior: "deny", reason: "recon mode is read-only: changes are blocked" };
    default: // manual
      return req.readOnly ? { behavior: "allow" } : { behavior: "ask" };
  }
}

function ruleMatches(rule: string, req: PermissionRequest): boolean {
  const m = rule.match(/^([A-Za-z_]+)(?:\((.*)\))?$/);
  if (!m) return false;
  const tool = m[1]!;
  const pattern = m[2];
  if (tool !== req.toolName) return false;
  if (pattern === undefined) return true;
  return globMatch(pattern, representativeArg(req));
}

/** Deny matching is sub-command aware for Bash: a rule fires if ANY simple-command in a
 *  chain matches, so `Bash(rm*)` catches `git status && rm x`. (Allow stays whole-command,
 *  so a partial match can never auto-approve a compound command.) */
function denyMatches(rule: string, req: PermissionRequest): boolean {
  const m = rule.match(/^([A-Za-z_]+)(?:\((.*)\))?$/);
  if (!m) return false;
  if (m[1] !== req.toolName) return false;
  const pattern = m[2];
  if (pattern === undefined) return true;
  if (req.toolName === "Bash") {
    return splitShellCommands(String(req.input.command ?? "")).some((sub) => globMatch(pattern, sub));
  }
  return globMatch(pattern, representativeArg(req));
}

/** The arg a rule pattern is matched against, per tool. */
function representativeArg(req: PermissionRequest): string {
  if (req.toolName === "Bash") return String(req.input.command ?? "");
  if (typeof req.input.path === "string") return req.input.path;
  return JSON.stringify(req.input);
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );
  return re.test(value);
}
