/**
 * Deterministic safety authority — the *deny* backstop that no mode, allow-rule, or model
 * decision can override. Two layers:
 *   1. A catastrophic-command denylist (rm -rf /, mkfs, dd to a raw device, fork bombs…).
 *   2. Content-safety write blocks (git internals, private keys / cloud credentials).
 * Plus a shell-aware splitter so `git status && rm -rf /` is inspected per sub-command
 * rather than matched as one opaque string. This is where yodex is deterministically safer
 * than an LLM-classifier boundary: allow is earned; deny here is absolute.
 */

import { homedir } from "node:os";
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
  const p = path.replace(/\\/g, "/");
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
  for (const c of [command, ...splitShellCommands(command)]) {
    for (const rule of PROTECTED_READ) if (rule.test.test(c)) return `blocked: ${rule.reason} is not for commands`;
  }
  return null;
}

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

/** Whether a path segment, possibly a pattern, could name ".yodex" or ".mlpal" (a leading * or ? never matches a dot
 *  name, as in bash and zsh by default). */
function couldName(segment: string): boolean {
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

export interface ReachContext {
  /** The person's home (default os.homedir()). */
  home?: string;
  /** The folder the command runs in, for a relative path (`../..`); absent: a relative path is the project's. */
  cwd?: string;
}

/** A home directory, by its normal form: the person's own, any /home/<u> or /Users/<u>, or /root. */
const isHome = (p: string, home: string): boolean => p === home || /^\/(?:home|Users)\/[^/]+$/.test(p) || p === "/root";
/** The path is the home's .yodex or .mlpal, or inside one. Group 1: the state directory. */
const inState = (p: string, home: string): string | null => {
  for (const name of STATE_NAMES) {
    if (p === `${home}/${name}` || p.startsWith(`${home}/${name}/`)) return `${home}/${name}`;
  }
  const m = /^(\/(?:home|Users)\/[^/]+\/\.(?:yodex|mlpal)|\/root\/\.(?:yodex|mlpal))(?:\/|$)/.exec(p);
  return m ? m[1]! : null;
};
/** The path is a state directory or one of its ancestors: what a recursive reader pointed there reaches. */
const holdsState = (p: string, home: string): boolean => p === "/" || p === "/home" || p === "/Users" || isHome(p, home) || inState(p, home) === p;

/**
 * REVIEW-4: a path word in its normal form, resolved lexically as the shell and the kernel would find it: `~`, `$HOME`
 * and `${HOME…}` expanded, `~user` as /home/<user>, `/proc/self|<pid>/root/…` as `/…`, `/proc/…/cwd/…` and a leading
 * `.`/`..` against the command's folder, `//`, `/./` and `..` collapsed. `literal` is the longest prefix with no glob,
 * brace or run-time value; `pattern` says whether the rest has one. Null for a word that is not a path into the
 * filesystem from a known place (a plain relative path, a flag, a URL).
 */
export function normalWord(word: string, ctx: Required<Pick<ReachContext, "home">> & ReachContext): { path: string; literal: string; pattern: boolean } | null {
  let w = word;
  const tilde = /^~([A-Za-z0-9_.-]*)(?=\/|$)/.exec(w);
  if (tilde) w = (tilde[1] ? `/home/${tilde[1]}` : ctx.home) + w.slice(tilde[0].length);
  else if (/^(?:\$HOME|\$\{HOME[^}]*\})(?=\/|$)/.test(w)) w = w.replace(/^(?:\$HOME|\$\{HOME[^}]*\})/, ctx.home);
  const proc = /^\/proc\/(?:self|thread-self|\d+)\/(root|cwd)(?=\/|$)/.exec(w);
  if (proc) {
    if (proc[1] === "root") w = `/${w.slice(proc[0].length)}`;
    else if (ctx.cwd) w = ctx.cwd + w.slice(proc[0].length);
    else return null;
  }
  if (!w.startsWith("/")) {
    if (!ctx.cwd || !/^\.\.?(?:\/|$)/.test(w)) return null;
    w = `${ctx.cwd}/${w}`;
  }
  const at = w.search(PATTERN_CHARS);
  if (at < 0) return { path: posix.normalize(w).replace(/(.)\/$/, "$1"), literal: posix.normalize(w).replace(/(.)\/$/, "$1"), pattern: false };
  const cut = w.lastIndexOf("/", at);
  const literal = posix.normalize(w.slice(0, cut + 1) || "/").replace(/(.)\/$/, "$1");
  return { path: `${literal === "/" ? "" : literal}/${w.slice(cut + 1)}`, literal, pattern: true };
}

/** Why a word could reach the home's .yodex or .mlpal without naming a file there, or null. */
function reachWithoutNaming(word: string, ctx: Required<Pick<ReachContext, "home">> & ReachContext): string | null {
  if (/^~[A-Za-z0-9_.-]+(?:\/|$)/.test(word)) return `${word.slice(0, 40)} names a home by its user`;
  const n = normalWord(word, ctx);
  if (!n && !ctx.cwd && /^\.\.\//.test(word) && PATTERN_CHARS.test(word) && (/yodex|mlpal/.test(word) || word.split("/").some((s) => couldName(s)))) {
    return `${word.slice(0, 60)} climbs out of the folder towards a home's .yodex or .mlpal`;
  }
  if (!n || !n.pattern) return null;
  // A pattern inside a state directory, or one whose literal part is a home (or above) and whose next segment could
  // name one, reaches files there no rule can name.
  if (inState(n.literal, ctx.home)) return `${word.slice(0, 60)} is a pattern inside ${inState(n.literal, ctx.home)}`;
  if (holdsState(n.literal, ctx.home)) {
    const rest = n.path.slice(n.literal === "/" ? 1 : n.literal.length + 1);
    const [first = "", ...more] = rest.split("/");
    const named = isHome(n.literal, ctx.home) ? couldName(first) : /yodex|mlpal/.test(rest) || (n.literal === "/home" || n.literal === "/Users" ? more.some((s) => couldName(s)) : false);
    if (named) return `${word.slice(0, 60)} is a pattern that can reach a home's .yodex or .mlpal`;
  }
  return null;
}

/**
 * REVIEW-3/4: a command that could reach the secret files without naming them is asked, in every mode, never run
 * unasked. Every path word is first put in its normal form (normalWord: `//`, `/./`, `..`, `~`, `$HOME`, `~user`,
 * `/proc/self/root`). Asked: a glob, brace or variable whose literal part is inside the home's .yodex or .mlpal, or a
 * home (or above) whose next segment could name one (~/.yod*, ~/.yodex/*, $HOME/.y?dex, /home/x/.yodex/p*); a home named
 * by its user (~user); and a recursive reader (find, grep -r, rg, tar, cp -r, zip -r, rsync, du, ls -R) pointed at a
 * state directory or any of its ancestors (/, /home, a home, ~/.yodex itself). Words come from the engine's decomposer
 * (quotes removed, each simple command apart); a line it cannot decompose is judged on its raw words. An exact path
 * under ~/.yodex (a skill script, YODEX.md) and a recursive read of one of its subfolders (~/.yodex/skills) are not
 * asked.
 */
export function protectedReachAsk(command: string, context: ReachContext = {}): string | null {
  const ctx = { home: context.home ?? homedir(), ...(context.cwd ? { cwd: context.cwd } : {}) };
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
      const why = reachWithoutNaming(w, ctx);
      if (why) return `this command could reach the person's keys without naming them: ${why}`;
    }
    const tool = name.split("/").pop()!;
    const recursive = Object.hasOwn(SWEEPS, tool) ? SWEEPS[tool] : undefined;
    if (recursive === undefined || (recursive !== null && !args.some((w) => recursive.test(w)))) continue;
    const target = args.map((w) => normalWord(w, ctx)).find((n) => n !== null && !n.pattern && holdsState(n.path, ctx.home));
    if (target) return `${tool} over ${target.path} reaches the person's keys: name the folder you mean`;
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
