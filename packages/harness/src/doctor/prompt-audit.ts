/**
 * Prompt audit (`/doctor prompt-audit`): a deterministic read of the instruction files the
 * harness feeds the model (memory files, skills, agent definitions) for the ways they rot.
 * No model is consulted. Four families of findings:
 *
 *  - stale references: a path that no longer exists, a command not on PATH, a package or
 *    make script that is not defined, an `@import` that does not resolve;
 *  - contradictions: two directives that cannot both be followed, within one file or across
 *    the chain (a user file says "use npm", the project file says "use pnpm"; "always X" in
 *    one place and "never X" in another);
 *  - prompt patterns from an earlier model generation: retired model ids, chain-of-thought
 *    incantations, shouting in capitals, "you are a helpful assistant";
 *  - material that costs context for nothing: a paragraph duplicated across files, a file
 *    large enough that every cache miss is felt, a file written for another tool.
 *
 * Probes (does this path exist, is this command installed, which scripts does this package
 * define) are injected so the analysis is testable without a filesystem; the host supplies
 * `defaultAuditProbes()`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type AuditSeverity = "error" | "warn" | "info";

export type AuditKind =
  | "missing_path"
  | "missing_command"
  | "missing_script"
  | "unresolved_import"
  | "contradiction"
  | "old_model"
  | "old_pattern"
  | "foreign_tool"
  | "duplicate"
  | "oversize";

export interface AuditFinding {
  file: string;
  line: number;
  kind: AuditKind;
  severity: AuditSeverity;
  message: string;
  /** What to do about it, when the fix is not obvious from the message. */
  hint?: string;
}

export type InstructionRole = "memory" | "skill" | "agent";

export interface InstructionFile {
  path: string;
  role: InstructionRole;
  /** Raw text, before the sanitizer: line numbers must match what the person opens. */
  content: string;
}

export interface AuditProbes {
  exists: (path: string) => boolean;
  which: (command: string) => boolean;
  /** Scripts the nearest package.json defines and targets the nearest Makefile defines,
   *  searched upward from `dir`. Undefined when neither file is found. */
  scripts: (dir: string) => { packageScripts?: string[]; makeTargets?: string[] };
}

export interface AuditOptions {
  cwd: string;
  home: string;
  probes: AuditProbes;
}

export interface AuditReport {
  files: number;
  findings: AuditFinding[];
}

const SEVERITY_ORDER: Record<AuditSeverity, number> = { error: 0, warn: 1, info: 2 };

/** Absolute paths under these roots are filesystem paths; any other absolute path (`/v1/messages`,
 *  `/api/users`) is read as a route and left alone. */
const FS_ROOTS = ["/Users/", "/home/", "/opt/", "/usr/", "/etc/", "/var/", "/tmp/", "/private/", "/Volumes/", "/mnt/", "/srv/", "/root/", "/Applications/", "/Library/", "/workspace/", "/workspaces/", "/app/"];

/** Shell words that are never an installed program. */
const SHELL_BUILTINS = new Set([
  "cd", "export", "source", ".", "echo", "set", "unset", "alias", "unalias", "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "return", "exit", "true", "false", "test", "[", "[[", "read", "shift", "local", "declare", "typeset", "eval", "exec", "trap", "wait", "printf", "pushd", "popd", "dirs", "type", "command", "hash", "ulimit", "umask", "let", "history", "jobs", "kill", "bg", "fg", "builtin", "enable", "help", "getopts", "readonly", "mapfile", "select", "coproc", "caller", "disown", "logout", "suspend", "times", "complete", "compgen", "shopt", "bind", "fc", "break", "continue", ":", "sudo", "env", "time", "nohup", "exec", "xargs",
]);

/** Launchers that fetch what they run: the program after them is not expected on PATH. */
const ON_DEMAND_RUNNERS = new Set(["npx", "bunx", "uvx", "pipx", "dlx"]);

const COMMAND_TOKEN = /^[a-z][a-z0-9._+-]*$/;

interface Line {
  n: number;
  text: string;
  /** Inside a fenced code block, with its info string (lowercased, first word). */
  fence: string | null;
}

function lines(content: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  content.split("\n").forEach((text, i) => {
    const m = text.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/);
    if (m) {
      fence = fence === null ? (m[2] ?? "").toLowerCase() : null;
      out.push({ n: i + 1, text, fence: null });
      return;
    }
    out.push({ n: i + 1, text, fence });
  });
  return out;
}

function inlineSpans(text: string): string[] {
  const out: string[] = [];
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!.trim());
  return out;
}

const SHELL_FENCES = new Set(["", "bash", "sh", "shell", "zsh", "console", "shell-session"]);

// ---------- stale references ----------

function pathCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const span of inlineSpans(text)) {
    for (const tok of span.split(/\s+/)) out.add(tok);
  }
  // Bare tokens with an explicit path prefix, outside code spans too.
  for (const m of text.matchAll(/(?:^|[\s(,"'])((?:~\/|\.{1,2}\/|\/)[\w.@+\-/]+)/g)) out.add(m[1]!);
  return [...out];
}

function cleanPathToken(tok: string): string | null {
  let t = tok.replace(/^[("'<]+|[)"'>.,:;!?]+$/g, "");
  t = t.replace(/:\d+(?::\d+)?$/, ""); // file:line[:col]
  if (!t || t.length < 2) return null;
  if (/[*{}<>$|?\\]|:\/\/|^@|^-|^\$/.test(t)) return null; // globs, placeholders, urls, flags, scopes, variables
  if (!/\//.test(t) && !/^~/.test(t)) return null;
  if (/^\/\//.test(t)) return null;
  return t;
}

function resolvePath(t: string, baseDir: string, opts: AuditOptions): string {
  if (t.startsWith("~/")) return join(opts.home, t.slice(2));
  if (t === "~") return opts.home;
  return isAbsolute(t) ? t : resolve(baseDir, t);
}

/** True when the token is one the audit can judge. A bare `a/b/c` is only a path when its first
 *  segment is a directory next to the file or the cwd: `origin/main`, `owner/repo` and the like
 *  are left alone. */
function judgeable(t: string, baseDir: string, opts: AuditOptions): { check: string[] } | null {
  if (t.startsWith("~")) return { check: [resolvePath(t, baseDir, opts)] };
  if (isAbsolute(t)) return FS_ROOTS.some((r) => t.startsWith(r)) ? { check: [t] } : null;
  if (/^\.{1,2}\//.test(t)) return { check: [resolve(baseDir, t), resolve(opts.cwd, t)] };
  const first = t.split("/")[0]!;
  const roots = [baseDir, opts.cwd].filter((d) => opts.probes.exists(join(d, first)));
  if (roots.length === 0) return null;
  return { check: roots.map((d) => resolve(d, t)) };
}

function auditPaths(file: InstructionFile, ls: Line[], opts: AuditOptions, out: AuditFinding[]): void {
  const baseDir = dirname(file.path);
  const seen = new Set<string>();
  for (const l of ls) {
    const im = l.text.match(/^\s*@(\S+)\s*$/);
    if (im && file.role === "memory") {
      const target = resolvePath(im[1]!, baseDir, opts);
      if (!opts.probes.exists(target)) out.push({ file: file.path, line: l.n, kind: "unresolved_import", severity: "error", message: `@${im[1]} does not resolve (${target})`, hint: "the line is sent to the model as literal text" });
      continue;
    }
    for (const raw of pathCandidates(l.text)) {
      const t = cleanPathToken(raw);
      if (!t || seen.has(t)) continue;
      const j = judgeable(t, baseDir, opts);
      if (!j) continue;
      seen.add(t);
      if (j.check.some((p) => opts.probes.exists(p))) continue;
      out.push({ file: file.path, line: l.n, kind: "missing_path", severity: "warn", message: `path does not exist: ${t}` });
    }
  }
}

function commandSegments(line: string): string[] {
  const stripped = line.replace(/^\s*\$\s+/, "").replace(/#.*$/, "");
  return stripped.split(/\s*(?:&&|\|\||\||;)\s*/).map((s) => s.trim()).filter(Boolean);
}

function headWord(segment: string): string | null {
  const toks = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) i += 1; // FOO=bar prefixes
  while (i < toks.length && (SHELL_BUILTINS.has(toks[i]!) && ["sudo", "env", "time", "nohup", "exec", "xargs"].includes(toks[i]!))) i += 1;
  const head = toks[i];
  if (!head) return null;
  if (ON_DEMAND_RUNNERS.has(head)) return null;
  return head;
}

function auditCommands(file: InstructionFile, ls: Line[], opts: AuditOptions, out: AuditFinding[]): void {
  const seen = new Set<string>();
  const scriptsCache = new Map<string, ReturnType<AuditProbes["scripts"]>>();
  const scriptsFor = (dir: string) => {
    if (!scriptsCache.has(dir)) scriptsCache.set(dir, opts.probes.scripts(dir));
    return scriptsCache.get(dir)!;
  };
  const consider = (segment: string, n: number) => {
    const head = headWord(segment);
    if (!head || SHELL_BUILTINS.has(head) || !COMMAND_TOKEN.test(head)) return;
    const toks = segment.split(/\s+/);
    // `npm run x` / `bun run x` / `yarn x` / `pnpm x` / `make x`: the script must be defined.
    const runner = ["npm", "pnpm", "yarn", "bun"].includes(head) ? head : null;
    if (runner) {
      let script: string | undefined;
      if (toks[1] === "run" || toks[1] === "run-script") script = toks[2];
      else if ((head === "yarn" || head === "pnpm") && toks[1] && !toks[1].startsWith("-") && !["install", "add", "remove", "test", "build", "dev", "start", "exec", "dlx", "create", "init", "publish", "link", "why", "list", "outdated", "update", "upgrade", "x", "i"].includes(toks[1])) script = toks[1];
      if (script && !script.startsWith("-") && !/[$<]/.test(script)) {
        const s = scriptsFor(dirname(file.path)).packageScripts ?? scriptsFor(opts.cwd).packageScripts;
        const key = `script:${script}`;
        if (s && !s.includes(script) && !seen.has(key)) {
          seen.add(key);
          out.push({ file: file.path, line: n, kind: "missing_script", severity: "warn", message: `"${head} run ${script}": no script named ${script} in package.json` });
        }
      }
    }
    if (head === "make" && toks[1] && /^[\w.-]+$/.test(toks[1])) {
      const t = scriptsFor(dirname(file.path)).makeTargets ?? scriptsFor(opts.cwd).makeTargets;
      const key = `make:${toks[1]}`;
      if (t && !t.includes(toks[1]) && !seen.has(key)) {
        seen.add(key);
        out.push({ file: file.path, line: n, kind: "missing_script", severity: "warn", message: `"make ${toks[1]}": no such target in the Makefile` });
      }
    }
    if (head.includes("/")) return; // a path, judged by auditPaths
    if (seen.has(head)) return;
    seen.add(head);
    if (!opts.probes.which(head)) out.push({ file: file.path, line: n, kind: "missing_command", severity: "warn", message: `command not on PATH: ${head}`, hint: "the model will try it and fail; install it, or say where it lives" });
  };
  for (const l of ls) {
    if (l.fence !== null) {
      if (!SHELL_FENCES.has(l.fence)) continue;
      for (const seg of commandSegments(l.text)) consider(seg, l.n);
      continue;
    }
    for (const span of inlineSpans(l.text)) {
      // An inline span is a command only when it reads like an invocation: a command-shaped
      // head followed by at least one argument or flag. A lone word is a name, not a command.
      const toks = span.split(/\s+/);
      if (toks.length < 2 || !COMMAND_TOKEN.test(toks[0]!)) continue;
      if (/^[A-Z]/.test(span) || /[=:]$/.test(toks[0]!) || /^[-\w]+:\s/.test(span)) continue;
      if (!/(^|\s)(-{1,2}[a-z]|[a-z0-9./_-]+)(\s|$)/.test(toks.slice(1).join(" "))) continue;
      for (const seg of commandSegments(span)) consider(seg, l.n);
    }
  }
}

// ---------- contradictions ----------

interface Axis {
  name: string;
  alternatives: { label: string; re: RegExp }[];
}

const w = (s: string) => new RegExp(`(?<![\\w-])${s}(?![\\w-])`, "i");

const AXES: Axis[] = [
  { name: "package manager", alternatives: [{ label: "npm", re: w("npm") }, { label: "yarn", re: w("yarn") }, { label: "pnpm", re: w("pnpm") }, { label: "bun", re: w("bun") }] },
  { name: "indentation", alternatives: [{ label: "tabs", re: w("tabs?") }, { label: "spaces", re: w("spaces") }] },
  { name: "quotes", alternatives: [{ label: "single quotes", re: /single[- ]quot/i }, { label: "double quotes", re: /double[- ]quot/i }] },
  { name: "test runner", alternatives: [{ label: "jest", re: w("jest") }, { label: "vitest", re: w("vitest") }, { label: "mocha", re: w("mocha") }, { label: "pytest", re: w("pytest") }, { label: "bun test", re: /\bbun test\b/i }] },
  { name: "formatter", alternatives: [{ label: "prettier", re: w("prettier") }, { label: "biome", re: w("biome") }, { label: "black", re: w("black") }, { label: "ruff format", re: /\bruff format\b/i }] },
  { name: "python packaging", alternatives: [{ label: "pip", re: w("pip") }, { label: "poetry", re: w("poetry") }, { label: "uv", re: w("uv") }, { label: "pipenv", re: w("pipenv") }, { label: "conda", re: w("conda") }] },
  { name: "python version", alternatives: [{ label: "python 3.10", re: /python\s*3\.10\b/i }, { label: "python 3.11", re: /python\s*3\.11\b/i }, { label: "python 3.12", re: /python\s*3\.12\b/i }, { label: "python 3.13", re: /python\s*3\.13\b/i }, { label: "python 3.14", re: /python\s*3\.14\b/i }] },
];

const DIRECTIVE = /\b(use|prefer|always|never|must|should|default to|don'?t|do not|avoid|only|stick to)\b/i;
const NEGATION = /\b(never|not|don'?t|do not|avoid|no longer|instead of|rather than|stop using)\b/i;

interface Directive {
  file: string;
  line: number;
  text: string;
  /** The line with its code spans removed: a command quoted in a rule is not a stance. */
  prose: string;
}

function directiveLines(file: InstructionFile, ls: Line[]): Directive[] {
  return ls
    .filter((l) => l.fence === null && DIRECTIVE.test(l.text.replace(/`[^`]*`/g, "")) && !/^\s*#/.test(l.text))
    .map((l) => {
      const text = l.text.replace(/^[\s\-*>]+/, "").trim();
      return { file: file.path, line: l.n, text, prose: text.replace(/`[^`]*`/g, " ") };
    });
}

function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/[`*_"']/g, "").replace(/[.,;:!)]+$/, "").replace(/\s+/g, " ").trim();
}

function auditContradictions(files: InstructionFile[], perFile: Map<string, Line[]>, out: AuditFinding[]): void {
  const directives = files.flatMap((f) => directiveLines(f, perFile.get(f.path)!));
  // Axis stances: one alternative named, with a polarity.
  interface Stance { d: Directive; axis: string; label: string; positive: boolean }
  const stances: Stance[] = [];
  for (const d of directives) {
    for (const axis of AXES) {
      const hit = axis.alternatives.filter((a) => a.re.test(d.prose));
      if (hit.length !== 1) continue; // a comparative line ("use bun, not npm") is self-consistent
      stances.push({ d, axis: axis.name, label: hit[0]!.label, positive: !NEGATION.test(d.prose) });
    }
  }
  const reported = new Set<string>();
  const report = (a: Directive, b: Directive, what: string) => {
    const key = [a.file, a.line, b.file, b.line].join("|");
    if (reported.has(key)) return;
    reported.add(key);
    // The finding lands on the later (more specific) file; the chain is ordered general → specific.
    out.push({ file: b.file, line: b.line, kind: "contradiction", severity: "warn", message: `${what}: "${clip(b.text)}" vs "${clip(a.text)}" (${a.file}:${a.line})`, hint: "the model gets both; it will pick one, not always the same one" });
  };
  for (let i = 0; i < stances.length; i++) {
    for (let j = i + 1; j < stances.length; j++) {
      const a = stances[i]!, b = stances[j]!;
      if (a.axis !== b.axis) continue;
      if (a.label !== b.label && a.positive && b.positive) report(a.d, b.d, `${a.axis}: ${a.label} vs ${b.label}`);
      else if (a.label === b.label && a.positive !== b.positive) report(a.d, b.d, `${a.axis}: ${a.label} both required and forbidden`);
    }
  }
  // Generic "always X" vs "never X" with the same phrase.
  const absolutes = directives.flatMap((d) => {
    const m = d.prose.match(/\b(always|never)\s+(.+)$/i);
    if (!m) return [];
    const phrase = normalizePhrase(m[2]!);
    return phrase.split(" ").length >= 2 ? [{ d, polarity: m[1]!.toLowerCase(), phrase }] : [];
  });
  for (let i = 0; i < absolutes.length; i++) {
    for (let j = i + 1; j < absolutes.length; j++) {
      const a = absolutes[i]!, b = absolutes[j]!;
      if (a.phrase === b.phrase && a.polarity !== b.polarity) report(a.d, b.d, `"${a.phrase}" is both always and never`);
    }
  }
}

const clip = (s: string, n = 72): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------- model-generation patterns ----------

const OLD_MODELS: { re: RegExp; label: string }[] = [
  { re: /\bclaude-(?:3(?:-[57])?|2(?:\.[01])?|instant)[\w.-]*/gi, label: "a retired Claude model id" },
  { re: /\bclaude-[a-z0-9-]*?-20\d{6}\b/gi, label: "a dated Claude model id (snapshots are retired; use the alias)" },
  { re: /\b(?:sonnet|opus|haiku)\s*-?\s*3(?:\.[57])?\b/gi, label: "a retired Claude 3 generation" },
  { re: /\bgpt-3\.5[\w-]*|\btext-davinci[\w-]*|\bgpt-4-\d{4}\b/gi, label: "a retired OpenAI model id" },
  { re: /\bgemini-(?:1\.0|pro)\b/gi, label: "a retired Gemini model id" },
];

const OLD_PATTERNS: { re: RegExp; message: string; hint: string }[] = [
  { re: /\b(?:let'?s\s+)?think\s+step[- ]by[- ]step\b/i, message: "chain-of-thought incantation", hint: "current models reason natively; say what a good answer contains instead" },
  { re: /\btake a deep breath\b/i, message: "\"take a deep breath\"", hint: "a prompt trick from 2023 with no effect on current models" },
  { re: /\byou are a helpful assistant\b/i, message: "\"you are a helpful assistant\"", hint: "filler; the line costs tokens on every turn and tells the model nothing" },
  { re: /\bas an ai language model\b/i, message: "\"as an AI language model\"", hint: "a phrase from older model outputs; remove" },
  { re: /\bi(?:'ll| will) tip\b/i, message: "a tipping bribe", hint: "no effect on current models" },
  { re: /\b(?:do not|don'?t|never) hallucinate\b/i, message: "\"do not hallucinate\"", hint: "say what to do when unsure (cite, say unknown, check) rather than naming the failure" },
  { re: /\bignore (?:all )?(?:previous|prior|above) instructions\b/i, message: "\"ignore previous instructions\"", hint: "injection-shaped text in an instruction file; the sanitizer leaves prose alone, so remove it" },
  { re: /\bthis is (?:very )?important (?:to|for) my (?:career|job)\b/i, message: "an emotional-stakes incantation", hint: "no effect on current models" },
  { re: /\byou are (?:an? )?(?:world[- ]class|expert|senior|10x)\b/i, message: "a persona superlative", hint: "state the standard the work must meet instead of a title" },
];

const FOREIGN: { re: RegExp; label: string }[] = [
  { re: /~\/\.claude\/|\$HOME\/\.claude\//g, label: "~/.claude/ paths" },
  { re: /\bCLAUDE_CODE_[A-Z_]+/g, label: "CLAUDE_CODE_* variables" },
  { re: /\.cursorrules\b|\bcopilot-instructions\.md\b/g, label: "another tool's rule files" },
];

function auditPatterns(file: InstructionFile, ls: Line[], out: AuditFinding[]): void {
  const seenModel = new Set<string>();
  const seenPattern = new Set<string>();
  const foreign = new Map<string, { n: number; line: number }>();
  for (const l of ls) {
    for (const om of OLD_MODELS) {
      for (const m of l.text.matchAll(om.re)) {
        const id = m[0].replace(/[.\-]+$/, "");
        if (seenModel.has(id.toLowerCase())) continue;
        seenModel.add(id.toLowerCase());
        out.push({ file: file.path, line: l.n, kind: "old_model", severity: "warn", message: `names ${om.label}: ${id}` });
      }
    }
    if (l.fence !== null) continue;
    for (const op of OLD_PATTERNS) {
      if (!op.re.test(l.text) || seenPattern.has(op.message)) continue;
      seenPattern.add(op.message);
      out.push({ file: file.path, line: l.n, kind: "old_pattern", severity: "info", message: op.message, hint: op.hint });
    }
    const caps = l.text.match(/\b[A-Z]{4,}\b/g)?.filter((x) => !/^(HTTP|JSON|YAML|HTML|SQL|AWS|GCP|REST|TODO|NOTE|README|CLAUDE|AGENTS|YODEX|MCP|API|CLI|SDK|URL|HOP|HOPS|OTEL|JWT|UUID|ASCII|UTF|PEP|CSS|SSH|TLS|EKS|IAM|VPC|CPU|GPU|RAM|PII|SLO|SLA|MFA|OSS|CDE|ECR|RDS|EC|CI|CD|PR|PRS|LLM|LLMS|OK)$/.test(x));
    if (caps && caps.length >= 3 && !seenPattern.has("shouting")) {
      seenPattern.add("shouting");
      out.push({ file: file.path, line: l.n, kind: "old_pattern", severity: "info", message: `shouting: ${caps.slice(0, 3).join(" ")}…`, hint: "capitals spent on every rule rank none; current models follow a plain sentence" });
    }
    for (const f of FOREIGN) {
      const n = [...l.text.matchAll(f.re)].length;
      if (n === 0) continue;
      const cur = foreign.get(f.label);
      foreign.set(f.label, { n: (cur?.n ?? 0) + n, line: cur?.line ?? l.n });
    }
  }
  if (file.role === "memory") {
    for (const [label, v] of foreign) {
      out.push({ file: file.path, line: v.line, kind: "foreign_tool", severity: "info", message: `references ${label} (${v.n} place${v.n === 1 ? "" : "s"})`, hint: "written for another tool; the model reads them as true here" });
    }
  }
}

// ---------- weight ----------

const OVERSIZE_BYTES = 32 * 1024;
const DUPLICATE_MIN_CHARS = 160;

function auditWeight(files: InstructionFile[], out: AuditFinding[]): void {
  const firstSeen = new Map<string, { file: string; line: number }>();
  for (const f of files) {
    const bytes = Buffer.byteLength(f.content, "utf8");
    if (bytes > OVERSIZE_BYTES) out.push({ file: f.path, line: 1, kind: "oversize", severity: "info", message: `${Math.round(bytes / 1024)} KB in the system prompt`, hint: "cached between turns, paid in full on every cache miss; move reference material behind a skill" });
    let line = 1;
    let start = 1;
    let buf: string[] = [];
    const flush = () => {
      const para = buf.join("\n").trim();
      buf = [];
      if (para.length < DUPLICATE_MIN_CHARS) return;
      const key = normalizePhrase(para);
      const prev = firstSeen.get(key);
      if (!prev) firstSeen.set(key, { file: f.path, line: start });
      else if (prev.file !== f.path) out.push({ file: f.path, line: start, kind: "duplicate", severity: "info", message: `paragraph duplicated from ${prev.file}:${prev.line}`, hint: "the model reads it twice; keep one copy" });
    };
    for (const text of f.content.split("\n")) {
      if (!text.trim()) {
        flush();
        start = line + 1;
      } else {
        if (buf.length === 0) start = line;
        buf.push(text);
      }
      line += 1;
    }
    flush();
  }
}

// ---------- entry points ----------

export function auditInstructionFiles(files: InstructionFile[], opts: AuditOptions): AuditReport {
  const findings: AuditFinding[] = [];
  const perFile = new Map<string, Line[]>();
  for (const f of files) {
    const ls = lines(f.content);
    perFile.set(f.path, ls);
    auditPaths(f, ls, opts, findings);
    auditCommands(f, ls, opts, findings);
    auditPatterns(f, ls, findings);
  }
  auditContradictions(files, perFile, findings);
  auditWeight(files, findings);
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  return { files: files.length, findings };
}

export function renderAuditReport(report: AuditReport, opts: { home?: string; cwd?: string } = {}): string {
  const short = (p: string) => {
    if (opts.cwd && p.startsWith(`${opts.cwd}/`)) return p.slice(opts.cwd.length + 1);
    if (opts.home && p.startsWith(`${opts.home}/`)) return `~${p.slice(opts.home.length)}`;
    return p;
  };
  // Messages quote other files (a contradiction's counterpart); shorten those the same way.
  const shortAll = (s: string) => {
    let out = s;
    if (opts.cwd) out = out.split(`${opts.cwd}/`).join("");
    if (opts.home) out = out.split(`${opts.home}/`).join("~/");
    return out;
  };
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of report.findings) counts[f.severity] += 1;
  const head = `prompt audit: ${report.files} file${report.files === 1 ? "" : "s"}, ${counts.error} error${counts.error === 1 ? "" : "s"}, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}, ${counts.info} note${counts.info === 1 ? "" : "s"}`;
  if (report.findings.length === 0) return `${head}\n  nothing stale, contradictory or outdated found`;
  const byFile = new Map<string, AuditFinding[]>();
  for (const f of report.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  const mark: Record<AuditSeverity, string> = { error: "✗", warn: "!", info: "·" };
  const blocks = [...byFile.entries()].map(([file, fs]) => {
    const rows = fs.sort((a, b) => a.line - b.line).map((f) => `  ${mark[f.severity]} ${short(file)}:${f.line}  ${shortAll(f.message)}${f.hint ? `\n      ${f.hint}` : ""}`);
    return rows.join("\n");
  });
  return `${head}\n${blocks.join("\n")}`;
}

/** The real probes: the filesystem, PATH, and the nearest package.json / Makefile. */
export function defaultAuditProbes(): AuditProbes {
  const scriptsCache = new Map<string, ReturnType<AuditProbes["scripts"]>>();
  return {
    exists: (p) => existsSync(p),
    which: (c) => Bun.which(c) !== null,
    scripts: (dir) => {
      if (scriptsCache.has(dir)) return scriptsCache.get(dir)!;
      const out: ReturnType<AuditProbes["scripts"]> = {};
      let cur = resolve(dir);
      for (let guard = 0; guard < 32; guard++) {
        if (out.packageScripts === undefined) {
          const pj = join(cur, "package.json");
          if (existsSync(pj)) {
            try {
              out.packageScripts = Object.keys((JSON.parse(readFileSync(pj, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {});
            } catch {
              out.packageScripts = [];
            }
          }
        }
        if (out.makeTargets === undefined) {
          const mk = ["Makefile", "makefile", "GNUmakefile"].map((n) => join(cur, n)).find((p) => existsSync(p));
          if (mk) {
            try {
              out.makeTargets = [...readFileSync(mk, "utf8").matchAll(/^([A-Za-z0-9_.\/-]+)\s*:(?!=)/gm)].map((m) => m[1]!);
            } catch {
              out.makeTargets = [];
            }
          }
        }
        if (out.packageScripts !== undefined && out.makeTargets !== undefined) break;
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      scriptsCache.set(dir, out);
      return out;
    },
  };
}
