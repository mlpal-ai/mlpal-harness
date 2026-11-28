/**
 * Deterministic safety authority — the *deny* backstop that no mode, allow-rule, or model
 * decision can override. Two layers:
 *   1. A catastrophic-command denylist (rm -rf /, mkfs, dd to a raw device, fork bombs…).
 *   2. Content-safety write blocks (git internals, private keys / cloud credentials).
 * Plus a shell-aware splitter so `git status && rm -rf /` is inspected per sub-command
 * rather than matched as one opaque string. This is where yodex is deterministically safer
 * than an LLM-classifier boundary: allow is earned; deny here is absolute.
 */

import { foldName } from "./names";
import { posix } from "node:path";
import { decomposeBash } from "./shell-decompose";

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
  // matched as a case-insensitive, normalising file system resolves the name: `.GIT/config` is `.git/config` on APFS
  const p = foldName(path.replace(/\\/g, "/"));
  for (const rule of PROTECTED_WRITE) {
    if (rule.test.test(p)) return `blocked: write to ${rule.reason} is not allowed`;
  }
  return null;
}

/**
 * REVIEW-3 (corrected ruling on RQ-6(a)), modelled on the workspace image's guard file
 * (mlpal-workspace-image config/permissions/workspace-guard.json): name the secret files and deny them; catch what could
 * reach them without naming them and ask; leave everything else under ~/.yodex alone, because the skills of installed
 * HOPs, packs and the person (~/.yodex/hops, plugins, skills) are run from there by path.
 *
 * Denied in every mode, bypass-immune: a command that names the person's stored keys, MCP sign-ins, consents and
 * trust records, or the engine's credentials file. With a kernel sandbox the same files are on DEFAULT_UNREADABLE
 * (sandbox/spec.ts); this holds where commands run unconfined, as in the workspace.
 */
const PROTECTED_READ = [
  { test: /person-secrets\.json/, reason: "the person's stored keys (~/.yodex/person-secrets.json)" },
  { test: /\.yodex\/+mcp-auth\b|(^|[\s'"=])mcp-auth\//, reason: "the person's MCP sign-ins (~/.yodex/mcp-auth)" },
  { test: /plugin-hooks\.json|hooks-trust\.json|variable-grants\.json/, reason: "the person's consents and grants (~/.yodex)" },
  { test: /\.yodex\/+(trust|credentials)\.json/, reason: "the engine's trust records and credentials (~/.yodex)" },
];

/** A deny reason when the command names a file of PROTECTED_READ, else null. */
export function protectedReadDeny(command: string): string | null {
  // matched as a case-insensitive, normalising file system resolves names (review-media R8): `~/.YODEX` is `~/.yodex`
  for (const c of [command, ...splitShellCommands(command)].map(foldName)) {
    for (const rule of PROTECTED_READ) if (rule.test.test(c)) return `blocked: ${rule.reason} is not for commands`;
  }
  return null;
}

/** A home directory as a command can spell it: ~ (and ~user), $HOME, ${HOME…}, /home/<u>, /Users/<u>, /root, or ../
 *  out of the workspace (which sits in the home). Group 1: the rest of the path. */
const HOME_WORD = /^(?:~[A-Za-z0-9_.-]*|\$HOME|\$\{HOME[^}]*\}|\/home\/[^/]+|\/Users\/[^/]+|\/root|(?:\.\.?\/+)*\.\.)(\/.*)?$/;
const PATTERN_CHARS = /[*?[\]{}$]/;
const STATE_NAMES = [".yodex", ".mlpal"];
/** Commands that read a whole tree they are pointed at, and the flag that makes them recursive when they need one. */
const SWEEPS: Record<string, RegExp | null> = {
  find: null,
  rg: null,
  tar: null,
  rsync: null,
  du: null,
  zip: /^-[a-zA-Z]*r/,
  grep: /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/,
  egrep: /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/,
  cp: /^(-[a-zA-Z]*[rRa][a-zA-Z]*|--recursive|--archive)$/,
  ls: /^-[a-zA-Z]*R[a-zA-Z]*$/,
  scp: /^-[a-zA-Z]*r/,
};
/** The home itself or the filesystem root, as an operand. */
const SWEEP_ROOT = /^(?:~[A-Za-z0-9_.-]*|\$HOME|\$\{HOME[^}]*\}|\/home\/[^/]+|\/Users\/[^/]+|\/root|\/)\/?$/;

/** Whether a path segment, possibly a pattern, could name ".yodex" or ".mlpal" (a leading * or ? never matches a dot
 *  name, as in bash and zsh by default). */
function couldName(raw: string): boolean {
  // folded as a case-insensitive, normalising file system resolves it (review-media R8): `.YODEX` is `.yodex`
  const segment = foldName(raw);
  if (!PATTERN_CHARS.test(segment)) return STATE_NAMES.includes(segment);
  if (segment.startsWith("*") || segment.startsWith("?")) return false;
  let re = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*" || c === "$") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "{" || c === "[") {
      const close = segment.indexOf(c === "{" ? "}" : "]", i);
      re += ".*";
      if (close > i) i = close;
    } else re += c.replace(/[.+^()|\\\]}]/g, "\\$&");
  }
  const r = new RegExp(`^${re}$`);
  return STATE_NAMES.some((n) => r.test(n));
}

/** Why a word could reach the home's .yodex or .mlpal without naming a file there, or null. */
function reachWithoutNaming(word: string): string | null {
  const m = HOME_WORD.exec(word);
  if (!m) return null;
  if (/^~[A-Za-z0-9_.-]+/.test(word)) return `${word.slice(0, 40)} names a home by its user`;
  const rest = posix.normalize(m[1] ?? "/").replace(/^\/+/, "");
  if (!rest || rest === "." || rest.startsWith("..")) return null;
  const [first, ...more] = rest.split(/\/+/);
  if (!couldName(first!)) return null;
  if (PATTERN_CHARS.test(first!) || more.some((x) => PATTERN_CHARS.test(x))) return `${word.slice(0, 60)} is a pattern under the home's ${first}`;
  return null;
}

/**
 * REVIEW-3: a command that could reach the secret files without naming them is asked, in every mode, never run
 * unasked: a glob, brace or variable in a path under the home's .yodex or .mlpal (~/.yod*, ~/.yodex/*, $HOME/.y?dex),
 * a home named by its user (~user), and a whole-home sweep (find, grep -r, rg, tar, cp -r, zip -r, rsync, du, ls -R on
 * ~, $HOME, /home/<u> or /). Words come from the engine's decomposer (quotes removed, each simple command apart); a line
 * it cannot decompose is judged on its raw words. An exact path under ~/.yodex (a skill script, YODEX.md) is not asked.
 */
export function protectedReachAsk(command: string): string | null {
  let lines: string[][];
  try {
    const d = decomposeBash(command);
    lines = d.opaque !== null ? [command.split(/\s+/)] : d.commands.map((c) => (c.forms[0] ?? "").split(" "));
  } catch {
    lines = [command.split(/\s+/)];
  }
  for (const raw of lines) {
    const words = raw.map((w) => w.replace(/^['"]+|['"]+$/g, ""));
    const [name = "", ...args] = words;
    for (const w of words) {
      const why = reachWithoutNaming(w);
      if (why) return `this command could reach the person's keys without naming them: ${why}`;
    }
    const tool = name.split("/").pop()!;
    const recursive = Object.hasOwn(SWEEPS, tool) ? SWEEPS[tool] : undefined;
    if (recursive !== undefined && args.some((w) => SWEEP_ROOT.test(w)) && (recursive === null || args.some((w) => recursive.test(w)))) {
      return `${tool} over the whole home reaches the person's keys: name the folder you mean`;
    }
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
