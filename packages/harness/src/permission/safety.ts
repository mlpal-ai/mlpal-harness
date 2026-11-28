/**
 * Deterministic safety authority — the *deny* backstop that no mode, allow-rule, or model
 * decision can override. Two layers:
 *   1. A catastrophic-command denylist (rm -rf /, mkfs, dd to a raw device, fork bombs…).
 *   2. Content-safety write blocks (git internals, private keys / cloud credentials).
 * Plus a shell-aware splitter so `git status && rm -rf /` is inspected per sub-command
 * rather than matched as one opaque string. This is where yodex is deterministically safer
 * than an LLM-classifier boundary: allow is earned; deny here is absolute.
 */

import { statSync } from "node:fs";
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
  /** The folder the command runs in; absent or unknown: see protectedReachAsk. */
  cwd?: string;
}

type Ctx = { home: string; cwd?: string };

/** A home directory, by its normal form: the person's own, any /home/<u> or /Users/<u>, or /root. */
const isHome = (p: string, home: string): boolean => p === home || /^\/(?:home|Users)\/[^/]+$/.test(p) || p === "/root";
/** The state directory (the home's .yodex or .mlpal) that holds the path, or null. */
const inState = (p: string, home: string): string | null => {
  for (const name of STATE_NAMES) {
    if (p === `${home}/${name}` || p.startsWith(`${home}/${name}/`)) return `${home}/${name}`;
  }
  const m = /^(\/(?:home|Users)\/[^/]+\/\.(?:yodex|mlpal)|\/root\/\.(?:yodex|mlpal))(?:\/|$)/.exec(p);
  return m ? m[1]! : null;
};
/** A directory above a state directory: what a many-file reader pointed there reaches. */
const aboveState = (p: string, home: string): boolean => p === "/" || p === "/home" || p === "/Users" || isHome(p, home);
/** The trees under ~/.yodex that HOPs, packs and the person's skills run from: readable as any folder is. */
const OPEN_TREES = ["hops", "plugins", "skills"];

/** REVIEW-5 R5-2(a): a path inside a state directory that is the directory itself or a directory in it other than the
 *  skills, HOPs and plugins trees (a file there, ~/.yodex/YODEX.md, is not). */
function stateDirectory(p: string, home: string): boolean {
  const root = inState(p, home);
  if (!root) return false;
  if (p === root) return true;
  const first = p.slice(root.length + 1).split("/")[0]!;
  if (root.endsWith("/.yodex") && OPEN_TREES.includes(first)) return false;
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * REVIEW-4/5: a path word in its normal form, resolved lexically as the shell and the kernel would find it: `~`,
 * `$HOME`/`${HOME…}` and (with a known folder) `$PWD`/`${PWD}` expanded, `~user` as /home/<user>,
 * `/proc/self|<pid>/root/…` as `/…`, `/proc/…/cwd/…` and every relative word against the command's folder, `//`, `/./`
 * and `..` collapsed. `literal` is the longest prefix with no glob, brace or run-time value; `pattern` says whether the
 * rest has one. Null for a word that is not a path from a known place (a flag, a URL, a relative word or `$PWD` with
 * the folder unknown).
 */
/**
 * REVIEW-6 R6-1: the shell's leading tilde and folder variables, one helper for every reader of a word: `~` and
 * `$HOME`/`${HOME…}` are the home; `~user` is /home/<user>; `~+` and `$PWD`/`${PWD}` are the command's folder (null
 * when it is unknown); `~-`, `$OLDPWD`/`${OLDPWD}` are known only at run time (null, `runtime`). A word with none of
 * these comes back as it is. (The decomposer marks a word that starts with an unquoted `~`; this is what it expands to.)
 */
export function expandLeading(word: string, ctx: { home: string; cwd?: string }): { word: string } | { runtime: true } | null {
  const t = /^~(?:([+-])|([A-Za-z0-9_][A-Za-z0-9_.-]*))?(?=\/|$)/.exec(word);
  if (t) {
    if (t[1] === "+") return ctx.cwd ? { word: ctx.cwd + word.slice(2) } : null;
    if (t[1] === "-") return { runtime: true };
    return { word: (t[2] ? `/home/${t[2]}` : ctx.home) + word.slice(t[0].length) };
  }
  const v = /^(?:\$(HOME|PWD|OLDPWD)|\$\{(HOME|PWD|OLDPWD)(?:[:\-+=?][^}]*)?\})(?=\/|$)/.exec(word);
  if (!v) return { word };
  const name = v[1] ?? v[2];
  if (name === "HOME") return { word: ctx.home + word.slice(v[0].length) };
  if (name === "PWD") return ctx.cwd ? { word: ctx.cwd + word.slice(v[0].length) } : null;
  return { runtime: true };
}

export function normalWord(word: string, ctx: Ctx): { path: string; literal: string; pattern: boolean } | null {
  if (word === "" || word.startsWith("-") || word.includes("://") || word.startsWith("&")) return null;
  const lead = expandLeading(word, ctx);
  if (lead === null || "runtime" in lead) return null;
  let w = lead.word;
  const proc = /^\/proc\/(?:self|thread-self|\d+)\/(root|cwd)(?=\/|$)/.exec(w);
  if (proc) {
    if (proc[1] === "root") w = `/${w.slice(proc[0].length)}`;
    else if (ctx.cwd) w = ctx.cwd + w.slice(proc[0].length);
    else return null;
  }
  if (!w.startsWith("/")) {
    if (!ctx.cwd || w.startsWith("$")) return null;
    w = `${ctx.cwd}/${w}`;
  }
  const at = w.search(PATTERN_CHARS);
  const tidy = (p: string) => posix.normalize(p).replace(/(.)\/$/, "$1");
  if (at < 0) return { path: tidy(w), literal: tidy(w), pattern: false };
  const cut = w.lastIndexOf("/", at);
  const literal = tidy(w.slice(0, cut + 1) || "/");
  return { path: `${literal === "/" ? "" : literal}/${w.slice(cut + 1)}`, literal, pattern: true };
}

/** Why a word could reach the home's .yodex or .mlpal without naming a file there, or null. */
function reachWithoutNaming(word: string, ctx: Ctx): string | null {
  if (/^~[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/|$)/.test(word)) return `${word.slice(0, 40)} names a home by its user`;
  const n = normalWord(word, ctx);
  if (!n) {
    const segs = word.split("/");
    const reachable = /yodex|mlpal/.test(word) || segs.some((s) => couldName(s));
    // ~- and $OLDPWD are known only at run time: the rest of the word decides.
    const lead = expandLeading(word, ctx);
    if (lead && "runtime" in lead && (reachable || segs.includes("..") || PATTERN_CHARS.test(word.slice(2)))) return `${word.slice(0, 60)} starts at a folder known only at run time`;
    // The folder is unknown (or held in $PWD): a word that climbs (a `..` segment) toward a state directory asks.
    if (segs.includes("..") && (reachable || PATTERN_CHARS.test(word))) return `${word.slice(0, 60)} climbs from an unknown folder toward a home's .yodex or .mlpal`;
    return null;
  }
  if (!n.pattern) return null;
  // A pattern inside a state directory, or one whose literal part is a home (or above) and whose next segment could
  // name one, reaches files there no rule can name.
  if (inState(n.literal, ctx.home)) return `${word.slice(0, 60)} is a pattern inside ${inState(n.literal, ctx.home)}`;
  if (aboveState(n.literal, ctx.home)) {
    const rest = n.path.slice(n.literal === "/" ? 1 : n.literal.length + 1);
    const [first = "", ...more] = rest.split("/");
    const named = isHome(n.literal, ctx.home) ? couldName(first) : /yodex|mlpal/.test(rest) || more.some((s) => couldName(s));
    if (named) return `${word.slice(0, 60)} is a pattern that can reach a home's .yodex or .mlpal`;
  }
  return null;
}

/** REVIEW-5 R5-2(b): the tools that read many files from a folder they are given, and when (args) they do. */
function readsMany(tool: string, args: string[]): boolean {
  switch (tool) {
    case "find":
    case "rg":
    case "tar":
    case "rsync":
    case "du":
    case "ag":
    case "ack":
    case "fd":
    case "fdfind":
    case "tree":
    case "ugrep":
    case "ug":
      return true;
    case "grep":
    case "egrep":
    case "fgrep":
      return args.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || /^-[a-zA-Z]*d/.test(w) || /^--(?:recursive|dereference-recursive|directories)/.test(w));
    case "git":
      return args.includes("grep") && args.includes("--no-index");
    case "cp":
    case "scp":
      return args.some((w) => /^-[a-zA-Z]*[rRa]/.test(w) || w === "--recursive" || w === "--archive");
    case "zip":
      return args.some((w) => /^-[a-zA-Z]*r/.test(w));
    case "ls":
      return args.some((w) => /^-[a-zA-Z]*R/.test(w) || w === "--recursive");
    default:
      return false;
  }
}

/**
 * REVIEW-3/4/5: a command that could reach the secret files without naming them is asked, in every mode, never run
 * unasked. Words come from the engine's decomposer (quotes removed, each simple command apart), in line order; a
 * literal `cd`/`pushd` moves the folder the later words resolve against (one whose target is not literal makes it
 * unknown). Every word is put in its normal form (normalWord). Asked:
 * - a glob, brace or run-time value whose literal part is inside the home's .yodex or .mlpal, or a home (or /, /home)
 *   whose next segment could name one; a home named by its user (~user); a word that climbs (`..`) from an unknown
 *   folder toward one;
 * - any command, whatever the tool, with an operand that is a state directory itself or a directory inside one other
 *   than ~/.yodex/hops, plugins and skills (R5-2a);
 * - a tool that reads many files (readsMany) with an operand above a state directory: a home, /home or / (R5-2b).
 * `ls ~`, `cd ~`, an exact file under ~/.yodex (YODEX.md, a skill script) and the open trees are not asked.
 */
/** REVIEW-6 R6-2: a redirection operator glued to its file (`<f`, `2>f`, `&>f`, `<>f`, `>|f`), split off. */
const REDIRECT = /^(?:\d*(?:<<<|<>|<<-?|<&|>&|>>|>\||<|>)|&>>|&>)/;

/** REVIEW-6 R6-3: the options that name the folder a tool works in, by tool. */
const DIR_OPTIONS: Record<string, { short?: string; long?: string[] }> = {
  env: { short: "-C", long: ["--chdir"] },
  git: { short: "-C" },
  make: { short: "-C", long: ["--directory"] },
  gmake: { short: "-C", long: ["--directory"] },
  tar: { short: "-C", long: ["--directory"] },
  npm: { long: ["--prefix"] },
  pnpm: { short: "-C", long: ["--dir"] },
  yarn: { long: ["--cwd"] },
  sudo: { short: "-D", long: ["--chdir"] },
};

/** The folder a tool's own option moves it to (R6-3), as written, or null. */
function dirOption(tool: string, args: readonly string[]): string | null {
  const o = Object.hasOwn(DIR_OPTIONS, tool) ? DIR_OPTIONS[tool]! : null;
  if (!o) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (o.short && a === o.short && args[i + 1] !== undefined) return args[i + 1]!;
    if (o.short && a.startsWith(o.short) && a.length > o.short.length && !a.startsWith("--")) return a.slice(o.short.length);
    for (const l of o.long ?? []) {
      if (a === l && args[i + 1] !== undefined) return args[i + 1]!;
      if (a.startsWith(`${l}=`)) return a.slice(l.length + 1);
    }
  }
  return null;
}

/** The rules for one simple command's words in a folder: why it asks, or null. */
function judgeCommand(words: string[], ctx: Ctx): string | null {
  const [name = "", ...args] = words;
  const tool = name.split("/").pop()!;
  for (const w of words) {
    const why = reachWithoutNaming(w, ctx);
    if (why) return `this command could reach the person's keys without naming them: ${why}`;
  }
  const operands = args.map((w) => normalWord(w, ctx)).filter((n): n is NonNullable<typeof n> => n !== null && !n.pattern);
  const inside = operands.find((n) => stateDirectory(n.path, ctx.home));
  if (inside) return `${tool} on ${inside.path} reaches the person's keys: name the file you mean`;
  const above = operands.find((n) => aboveState(n.path, ctx.home));
  if (above && readsMany(tool, args)) return `${tool} over ${above.path} reaches the person's keys: name the folder you mean`;
  return null;
}

/** A command's words with each redirection's file as a word of its own (R6-2): `cat < f`, `cat <f`, `2>f`. */
function withRedirectTargets(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of raw) {
    const m = REDIRECT.exec(t);
    if (!m) out.push(t);
    else if (t.length > m[0].length) out.push(t.slice(m[0].length));
  }
  return out.filter((w) => w !== "");
}

export function protectedReachAsk(command: string, context: ReachContext = {}): string | null {
  const ctx: Ctx = { home: context.home ?? homedir(), ...(context.cwd ? { cwd: context.cwd } : {}) };
  let lines: string[][];
  try {
    const d = decomposeBash(command);
    // `redirected` is the command's form with its redirections appended as written: their files are operands too.
    lines = d.opaque !== null ? [command.split(/\s+/)] : d.commands.map((c) => (c.redirected?.[0] ?? c.forms[0] ?? "").split(" "));
  } catch {
    lines = [command.split(/\s+/)];
  }
  // R6-3: a tool's directory option is an operand, and that command's folder. The decomposer strips git's global
  // options from its forms, so the options are read from the line's raw simple commands.
  for (const sub of splitShellCommands(command)) {
    const raw = sub.split(/\s+/).map((w) => w.replace(/^['"]+|['"]+$/g, ""));
    const at = raw.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    const tool = (raw[at] ?? "").split("/").pop()!;
    const dir = dirOption(tool, raw.slice(at + 1));
    if (dir === null) continue;
    const n = normalWord(dir, ctx);
    if (n === null || n.pattern) {
      const why = reachWithoutNaming(dir, ctx);
      if (why) return `this command could reach the person's keys without naming them: ${why}`;
      continue;
    }
    if (stateDirectory(n.path, ctx.home)) return `${tool} working in ${n.path} reaches the person's keys`;
    const inDir = judgeCommand(withRedirectTargets(raw.slice(at)), { home: ctx.home, cwd: n.path });
    if (inDir) return inDir;
  }
  for (const raw of lines) {
    const words = withRedirectTargets(raw.map((w) => w.replace(/^['"]+|['"]+$/g, "")));
    const [name = "", ...args] = words;
    const tool = name.split("/").pop()!;
    const why = judgeCommand(words, ctx);
    if (why) return why;
    // The folder the next command of the line runs in.
    if (tool === "cd" || tool === "pushd") {
      const target = args.filter((w) => !w.startsWith("-"));
      if (target.length === 0) ctx.cwd = ctx.home;
      else {
        const n = normalWord(target[0]!, ctx);
        if (n && !n.pattern) ctx.cwd = n.path;
        else delete ctx.cwd;
      }
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
