/**
 * Deterministic safety authority — the *deny* backstop that no mode, allow-rule, or model
 * decision can override. Two layers:
 *   1. A catastrophic-command denylist (rm -rf /, mkfs, dd to a raw device, fork bombs…).
 *   2. Content-safety write blocks (git internals, private keys / cloud credentials).
 * Plus a shell-aware splitter so `git status && rm -rf /` is inspected per sub-command
 * rather than matched as one opaque string. This is where yodex is deterministically safer
 * than an LLM-classifier boundary: allow is earned; deny here is absolute.
 */

import { posix } from "node:path";

/**
 * Split a shell command into its constituent simple-commands across operators and
 * substitutions (`&&`, `||`, `;`, `|`, newlines, `$( … )`, backticks). Not a full parser —
 * a robust approximation that surfaces the pieces a denylist must see. Quotes are respected
 * so `echo "a; b"` is not split on the quoted `;`.
 */
/** Index of the `)` that closes the `(` at `open`, honoring nesting; -1 if unbalanced.
 *  `indexOf(")")` stopped at the first inner `)` and mis-sliced nested substitutions. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

export function splitShellCommands(command: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  const push = () => {
    const t = buf.trim();
    if (t) parts.push(t);
    buf = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    const prev = command[i - 1];
    if (quote) {
      if (c === quote) quote = null;
      else buf += c;
      // keep the char inside the buffer for context, but not the closing/opening quote
      if (c !== quote) {
        /* already appended */
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    // A backslash escapes the next char (so `\;` is a literal, not a separator).
    if (c === "\\" && next !== undefined) {
      buf += c + next;
      i++;
      continue;
    }
    // operators that separate commands
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
      push();
      i++;
      continue;
    }
    // A single `&` backgrounds a command — a real separator (a deny rule must still catch
    // the sub-command after it). But `&` also appears in redirects (`2>&1`, `&>file`,
    // `>&2`), which are NOT separators; the surrounding `>` disambiguates.
    if (c === "&" && prev !== ">" && next !== ">") {
      push();
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") {
      push();
      continue;
    }
    // process substitution `<( … )` / `>( … )` runs a command; recurse like `$( … )`.
    if ((c === "<" || c === ">") && next === "(") {
      const end = matchParen(command, i + 1);
      if (end > 0) {
        for (const sub of splitShellCommands(command.slice(i + 2, end))) parts.push(sub);
        i = end;
        continue;
      }
    }
    // command substitution: recurse into `$( … )` and backticks
    if (c === "$" && next === "(") {
      const end = matchParen(command, i + 1);
      if (end > 0) {
        for (const sub of splitShellCommands(command.slice(i + 2, end))) parts.push(sub);
        i = end;
        continue;
      }
    }
    if (c === "`") {
      const end = command.indexOf("`", i + 1);
      if (end > 0) {
        for (const sub of splitShellCommands(command.slice(i + 1, end))) parts.push(sub);
        i = end;
        continue;
      }
    }
    buf += c;
  }
  push();
  return parts;
}

// Each rule: a matcher over a single simple-command and the reason to deny.
const CATASTROPHIC: Array<{ test: RegExp; reason: string }> = [
  // rm -rf targeting a filesystem/home root (any flag order, incl. --no-preserve-root)
  {
    test: /\brm\b[^|;&]*\s-[a-z]*r[a-z]*f|\brm\b[^|;&]*\s-[a-z]*f[a-z]*r/i,
    reason: "recursive-force rm",
  },
  { test: /\bmkfs\b|\bmke2fs\b/i, reason: "filesystem format (mkfs)" },
  { test: /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|disk|hd|vd)/i, reason: "dd writing to a raw disk device" },
  { test: />\s*\/dev\/(sd|nvme|disk|hd|vd)[a-z0-9]/i, reason: "redirect overwriting a raw disk device" },
  { test: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  {
    test: /\bchmod\b[^|;&]*\s-[a-z]*R[^|;&]*\s\/(\s|$|\*)|\bchown\b[^|;&]*\s-[a-z]*R[^|;&]*\s\/(\s|$|\*)/i,
    reason: "recursive chmod/chown on the filesystem root",
  },
];

/** Where `~`, `~/…`, `$HOME` and `${HOME}` point, for matching: a marker, so it reads as the home folder whatever
 *  the host's HOME is (the host's own HOME is matched too). */
const HOME_MARK = "/~home";
/** A system folder and everything in it. */
const SYSTEM_TREE = /^\/(bin|sbin|etc|usr|var|lib|lib64|boot|dev|proc|sys|root|opt|System|Library)(\/|$|\*)/;
/** The folder that holds the homes, or one user's home. A project inside a home is not one. */
const HOME_ROOT = /^\/(home|Users)(\/[^/]+)?$/;
const GLOB = /[*?[]/;

export const RM_ROOT_REASON = "blocked: recursive-force rm targeting a system/home root";
export const RM_SESSION_ROOT_REASON = "blocked: recursive-force rm targeting the session's own folder";

/** Where the guard resolves a command's relative paths, and the folders it must never let rm -rf take. */
export interface RmGuardContext {
  /** The folder the command runs in (resolved as the shell resolves it). Without it, relative operands are not judged. */
  cwd?: string;
  /** The session's folders: refused as an rm -rf target, as `<root>/*`, and as any folder that contains one. */
  roots?: readonly string[];
}

/** An rm operand as an absolute, normalized path (`//`, `.` and `..` resolved, no trailing `/`), or undefined when it
 *  is relative and no cwd is known. Quotes are dropped; the home spellings become HOME_MARK. */
function normalizeOperand(raw: string, cwd: string | undefined): string | undefined {
  let t = raw.replace(/^(['"])(.*)\1$/, "$2");
  t = t.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, HOME_MARK);
  if (!t.startsWith("/")) {
    if (cwd === undefined) return undefined;
    t = `${cwd}/${t}`;
  }
  const n = posix.normalize(t);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/** `p` without a trailing `/*` or `/.*`: the folder a glob of its contents empties. */
function globbedFolder(p: string): string {
  const m = /^(.*)\/\.?\*$/.exec(p);
  return m ? m[1] || "/" : p;
}

function globRegExp(p: string): RegExp {
  const body = p.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

/** `root` and every folder above it, down to `/`. */
function selfAndAncestors(root: string): string[] {
  const out: string[] = [];
  for (let p = posix.normalize(root); ; p = posix.dirname(p)) {
    out.push(p);
    if (p === "/") return out;
  }
}

/** Which rule an rm -rf of `target` (normalized) breaks, if any. */
function rmTargetDeny(target: string, ctx: RmGuardContext): string | null {
  const folder = globbedFolder(target);
  const home = process.env.HOME ? posix.normalize(process.env.HOME) : undefined;
  if (folder === "/" || folder === HOME_MARK || folder === home || SYSTEM_TREE.test(folder) || HOME_ROOT.test(folder)) {
    return RM_ROOT_REASON;
  }
  if (folder.startsWith(`${HOME_MARK}/`)) {
    // `~/…`: judged as the real home's path when known, else only `~` itself was a root.
    if (!home) return null;
    return rmTargetDeny(home + folder.slice(HOME_MARK.length) + target.slice(folder.length), ctx);
  }
  const protectedFolders = (ctx.roots ?? []).flatMap((r) => selfAndAncestors(r));
  if (protectedFolders.length === 0) return null;
  if (GLOB.test(folder)) {
    const re = globRegExp(folder);
    return protectedFolders.some((p) => re.test(p)) ? RM_SESSION_ROOT_REASON : null;
  }
  return protectedFolders.includes(folder) ? RM_SESSION_ROOT_REASON : null;
}

/** The deny reason for an rm -rf whose target is the filesystem root, a system folder, a home folder itself, or (with
 *  `ctx.roots`) one of the session's folders or a folder containing one; a project folder inside them is allowed.
 *  A backstop on literal spellings, not a boundary: `find -delete`, `xargs rm` or a path held in a variable are not
 *  seen here. */
function rootRmDeny(cmd: string, ctx: RmGuardContext): string | null {
  if (!/\brm\b/i.test(cmd) || !/-[a-z]*r/i.test(cmd) || !/-[a-z]*f/i.test(cmd)) return null;
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const at = tokens.findIndex((t) => /^\\?rm$/i.test(t.split("/").pop() ?? ""));
  const operands = tokens.slice(at + 1).filter((t) => !t.startsWith("-"));
  for (const raw of operands) {
    const target = normalizeOperand(raw, ctx.cwd);
    const reason = target === undefined ? null : rmTargetDeny(target, ctx);
    if (reason) return reason;
  }
  return null;
}

/** Returns a deny reason if the command is catastrophic, else null.
 *  - The rm rule is OPERAND-based, so it runs per sub-command only (checking the whole
 *    chain would false-positive on a `/` operand belonging to a different command).
 *  - The regex rules are self-anchored (mkfs/dd/fork-bomb/chmod), so they run against the
 *    whole command AND each sub-command — catching a fork bomb (spans operators) and a
 *    destructive command hidden in a `&&`/`;` chain alike.
 *  - `ctx` (optional): the folder the command runs in and the session's folders, for the rm rule. */
export function catastrophicDeny(command: string, ctx: RmGuardContext = {}): string | null {
  const subs = splitShellCommands(command);
  for (const sub of subs) {
    const rm = rootRmDeny(sub, ctx);
    if (rm) return rm;
  }
  for (const c of [command, ...subs]) {
    for (const rule of CATASTROPHIC) {
      if (rule.reason === "recursive-force rm") continue; // handled above
      if (rule.test.test(c)) return `blocked: ${rule.reason}`;
    }
  }
  return null;
}

// Paths that must never be written by the agent (bypass-immune), matched against a
// normalized path. Reading is fine; writing/corrupting these is the risk.
const PROTECTED_WRITE = [
  { test: /(^|\/)\.git\/(?!info\/exclude$)/, reason: "git internals (.git/)" },
  { test: /(^|\/)\.ssh\/(id_|.*_key$|authorized_keys$)/, reason: "SSH keys (.ssh/)" },
  { test: /(^|\/)\.aws\/credentials$/, reason: "AWS credentials" },
  { test: /(^|\/)\.(npmrc|pypirc|netrc)$/, reason: "package/registry credentials" },
  { test: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/, reason: "private key" },
];

/** Returns a deny reason if writing this path is unsafe, else null. */
export function contentSafetyDeny(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  for (const rule of PROTECTED_WRITE) {
    if (rule.test.test(p)) return `blocked: write to ${rule.reason} is not allowed`;
  }
  return null;
}

/** A file redirect target in a shell command, if any (`> path`, `>> path`, `tee path`). */
export function redirectTargets(command: string): string[] {
  const out: string[] = [];
  const re = /(?:>>?|(?:^|\s)tee(?:\s+-a)?)\s+("[^"]+"|'[^']+'|[^\s|;&]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) out.push(m[1]!.replace(/^["']|["']$/g, ""));
  return out;
}
