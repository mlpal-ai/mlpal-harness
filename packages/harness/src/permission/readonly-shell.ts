import { splitShellCommands } from "./safety";
import { decomposeBash, refusesAutoApproval } from "./shell-decompose";

/**
 * Deterministic read-only classification of a shell command, for cruise mode: a command whose
 * every simple command is a known read-only program, with no redirection (other than to /dev/null
 * or another fd), substitution or escalation, runs without a prompt. Anything unrecognised is NOT read-only; the mode then asks.
 * A line the decomposer refuses to auto-approve (an environment change anywhere on it, a git global option, an rc-reading
 * shell, an undecomposable form, a redirection that writes a file: shell-decompose.ts) is not read-only either, whatever
 * program it runs (D-27 rounds 5 and 6).
 * The deny-list safety guard runs before any mode decision and is untouched by this.
 */

/** Programs that only read when used without the arguments checked below. */
const READ_ONLY = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "stat", "file", "du", "df", "echo", "printf", "date", "uname", "whoami", "id",
  "hostname", "which", "type", "command", "readlink", "realpath", "basename", "dirname", "env", "printenv", "ps", "pgrep",
  "lsof", "netstat", "uptime", "true", "false", "tr", "cut", "sort", "uniq", "grep", "egrep", "fgrep", "rg", "ag", "awk", "jq", "diff",
  "cmp", "comm", "less", "more", "strings", "od", "hexdump", "xxd", "md5", "md5sum", "sha1sum", "sha256sum", "shasum",
  "nproc", "sw_vers", "arch", "locale", "tty", "sleep", "test", "[", "column", "nl", "fold", "tee_never",
]);
/** Programs read-only only with a version/help flag as their sole argument. */
const VERSION_ONLY = new Set(["node", "bun", "npm", "pnpm", "yarn", "python", "python3", "pip", "pip3", "go", "cargo", "rustc", "java", "ruby", "gem", "php", "docker", "kubectl", "terraform", "gh", "aws", "gcloud", "az", "make", "cmake", "gcc", "clang", "tsc", "deno"]);
const VERSION_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h"]);
/** Programs whose `version`/`help` word is a subcommand that only prints. Elsewhere the word names what runs: a script
 *  file (`python3 help`, `node version`), a make target (`make help`), a package.json script (`bun version`). */
const VERSION_SUBCOMMAND = new Set(["npm", "go", "cargo", "gem", "pip", "pip3", "docker", "kubectl", "terraform", "gh", "aws", "gcloud", "az"]);
/** git subcommands that never write, with the argument checks that keep them so. */
const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "grep", "cat-file", "shortlog", "reflog", "rev-list", "name-rev", "count-objects", "var", "check-ignore", "merge-base", "for-each-ref", "symbolic-ref", "show-ref", "whatchanged", "diff-tree", "diff-index", "diff-files", "worktree"]);

/** `--output=file` writes; `--ext-diff`, `--textconv`, `--filters` run configured programs; `git grep -O` runs a pager. */
const GIT_WRITES_OR_RUNS = /^--(output|ext-diff|textconv|filters|open-files-in-pager)|^-O/;
/** An unquoted brace expansion (`{a,b}`, `{a..c}`): it rewrites the arguments after this check has read them. */
const BRACE_EXPANSION = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

/** Redirections that cannot write into the workspace: output to /dev/null (`>`, `>>`, `2>`, `&>`) and
 *  fd duplication (`2>&1`, `1>&2`). A leading fd digit counts only as its own word, as in the shell. */
const HARMLESS_REDIRECT = /(?:(?<=^|\s)\d)?(?:>>?|&>>?)\s*\/dev\/null(?=\s|$|[;|&])|(?:(?<=^|\s)\d)?>&\d(?=\s|$|[;|&])/g;

/** Blank harmless redirections outside quotes so the remaining text is the command proper. */
function stripHarmlessRedirects(cmd: string): string {
  let out = "";
  let i = 0;
  const quoted = /'[^']*'|"[^"]*"/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(cmd))) {
    out += cmd.slice(i, m.index).replace(HARMLESS_REDIRECT, " ") + m[0];
    i = m.index + m[0].length;
  }
  return out + cmd.slice(i).replace(HARMLESS_REDIRECT, " ");
}

/** Tokenise one simple command on whitespace, honouring quotes. Returns null on anything this
 *  classifier does not model (substitution, redirection, globs are fine). */
function tokens(cmd: string): string[] | null {
  // The splitter already removed quotes and split on `;`, `&&`, `||`; redirections and `&` were
  // refused on the whole command (quote-aware) before splitting. Substitution is refused here.
  if (/[`$()]/.test(cmd)) return null;
  const out: string[] = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** `quotedSpace`: a quoted span on the line held whitespace. The splitter has removed quotes, so here such a span is
 *  several words, and a check that must find where one argument ends (sed's script) cannot trust the boundaries. */
function simpleIsReadOnly(cmd: string, quotedSpace: boolean): boolean {
  const argv = tokens(cmd.trim());
  if (!argv || argv.length === 0) return false;
  return argvIsReadOnly(argv as [string, ...string[]], quotedSpace);
}

/** A leading VAR=value never reaches here (isReadOnlyShell refuses an environment change first). */
function argvIsReadOnly([prog, ...args]: [string, ...string[]], quotedSpace: boolean): boolean {
  const base = prog.includes("/") ? prog.slice(prog.lastIndexOf("/") + 1) : prog;
  // `env` and `command` run their arguments as a command, which must be read-only itself; alone they only print.
  if (base === "env") return args.length === 0 || (!args[0]!.startsWith("-") && argvIsReadOnly(args as [string, ...string[]], quotedSpace));
  if (base === "command") {
    if (args[0] === "-v" || args[0] === "-V") return true;
    const rest = args[0] === "-p" ? args.slice(1) : args;
    return rest.length === 0 || (!rest[0]!.startsWith("-") && argvIsReadOnly(rest as [string, ...string[]], quotedSpace));
  }
  if (base === "sudo" || base === "doas" || base === "su" || base === "xargs" || base === "eval" || base === "exec" || base === "source" || base === ".") return false;
  if (base === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (!sub || !GIT_READ.has(sub)) {
      // branch / tag / stash / remote / config list only when given no operand that would write.
      if (sub === "branch" || sub === "tag") return args.every((a) => a === sub || a.startsWith("-")) && !args.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/.test(a));
      if (sub === "stash") return ["list", "show"].includes(args[args.indexOf(sub) + 1] ?? "") && !args.some((a) => GIT_WRITES_OR_RUNS.test(a));
      if (sub === "remote") return args.slice(args.indexOf(sub) + 1).every((a) => a === "-v" || a === "--verbose" || a === "show" || a === "get-url");
      if (sub === "config") return args.some((a) => a === "--get" || a === "--list" || a === "-l" || a === "--get-all" || a === "--get-regexp");
      return false;
    }
    const rest = args.slice(args.indexOf(sub) + 1);
    if (sub === "worktree") return rest[0] === "list";
    // `git symbolic-ref HEAD <ref>` sets, `-d` deletes; `git reflog expire|delete|drop` deletes entries.
    if (sub === "symbolic-ref") return !rest.some((a) => a === "-d" || a === "--delete" || a === "-m") && rest.filter((a) => !a.startsWith("-")).length <= 1;
    if (sub === "reflog" && ["expire", "delete", "drop"].includes(rest[0] ?? "")) return false;
    return !args.some((a) => GIT_WRITES_OR_RUNS.test(a));
  }
  if (base === "arch") return args.length === 0; // `arch -x86_64 <cmd>` runs a command
  if (base === "find") return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fls)$|^-fprint/.test(a));
  if (base === "sed") return !quotedSpace && sedIsReadOnly(args);
  if (base === "awk" || base === "gawk") return awkIsReadOnly(args);
  // `sort -o`/`--output` writes a file; `--compress-program` runs one (getopt takes any unambiguous prefix: `--o`, `--co`).
  if (base === "sort") return !args.some((a) => /^-[^-]*o|^--(o|co)/.test(a));
  // A second operand is the file `uniq` and `xxd` write; `file -C` compiles a magic file.
  if (base === "uniq") return operands(args, ["-f", "-s", "-w"]).length <= 1;
  if (base === "xxd") return operands(args, ["-c", "-cols", "-g", "-groupsize", "-l", "-len", "-s", "-seek", "-o", "-offset", "-n", "-name"]).length <= 1;
  if (base === "file") return !args.some((a) => /^-[a-zA-Z]*C|^--comp/.test(a));
  // A pager's options and `+commands` can log to a file or run a shell escape: only plain file operands are read-only.
  if (base === "less" || base === "more") return args.every((a) => !a.startsWith("-") && !a.startsWith("+"));
  // `rg --pre` / `--hostname-bin` and `ag --pager` run a command.
  if (base === "rg") return !args.some((a) => /^--(pre|hostname-bin)(=|$)/.test(a));
  if (base === "ag") return !args.some((a) => /^--pag/.test(a));
  if (base === "tee" || base === "tee_never") return false;
  // `ss -K` / `--kill` closes sockets; every other `ss` form only lists them.
  if (base === "ss") return !args.some((a) => a === "--kill" || /^-[a-zA-Z]*K/.test(a));
  if (VERSION_ONLY.has(base)) return args.length === 1 && (VERSION_FLAGS.has(args[0]!) || (VERSION_SUBCOMMAND.has(base) && (args[0] === "version" || args[0] === "help")));
  if (READ_ONLY.has(base)) return true;
  return false;
}

/** The operands among `args`: words not starting with `-` (all after `--`), skipping the value of an option in `withValue`. */
function operands(args: string[], withValue: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return [...out, ...args.slice(i + 1)];
    if (withValue.includes(a)) i++;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

/** awk's program: only `-F` and an attached `-vNAME=value` before it (`-f`, `-l`, `-i`, `-E` load code from files), and
 *  no text that writes, pipes, reads a command or loads an extension. `>` and `|` also refuse comparisons and `||`. The
 *  program may arrive as several words (quotes removed), so every word from it on is checked. */
function awkIsReadOnly(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-F") i++;
    else if (/^-F.|^-v[A-Za-z_]\w*=/.test(a)) continue;
    else if (a.startsWith("-")) return false;
    else return !args.slice(i).some((w) => /system|getline|[|>]|@(load|include)/.test(w));
  }
  return false;
}

const SED_LONG = new Set(["--debug", "--posix", "--quiet", "--silent", "--regexp-extended", "--sandbox", "--separate", "--unbuffered", "--null-data", "--zero-terminated", "--follow-symlinks"]);

/** sed with known options only (`-i`/`-I` edit in place, `-f` reads a script file) and scripts every command of which
 *  only prints, deletes or edits the stream (sedScriptIsReadOnly). */
function sedIsReadOnly(args: string[]): boolean {
  const scripts: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const flag = eq < 0 ? a : a.slice(0, eq);
      const value = () => (eq < 0 ? args[++i] : a.slice(eq + 1));
      if (flag === "--expression") {
        const v = value();
        if (v === undefined) return false;
        scripts.push(v);
      } else if (flag === "--line-length") {
        if (!/^\d+$/.test(value() ?? "")) return false;
      } else if (eq >= 0 || !SED_LONG.has(a)) return false;
      continue;
    }
    if (a.startsWith("-") && a !== "-") {
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!;
        if ("nErsuz".includes(c)) continue;
        if (c !== "e" && c !== "l") return false;
        const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
        if (v === undefined) return false;
        // GNU's `-l N`; BSD's `-l` takes none, so a non-number after it would be BSD's script
        if (c === "l" && !/^\d+$/.test(v)) return false;
        if (c === "e") scripts.push(v);
        break;
      }
      continue;
    }
    rest.push(a);
  }
  if (scripts.length === 0) {
    if (rest.length === 0) return false;
    scripts.push(rest[0]!);
  }
  return scripts.every(sedScriptIsReadOnly);
}

const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:[^/\\\n]|\\.)*/[IM]*)`;
const SED_RANGE = String.raw`(?:\d+~\d+|${SED_ADDRESS}(?:\s*,\s*(?:${SED_ADDRESS}|[+~]\d+))?)`;
const SED_SUBST = String.raw`s(?<s>[^\w\s\\])(?:(?!\k<s>)[^\\\n]|\\.)*\k<s>(?:(?!\k<s>)[^\\\n]|\\.)*\k<s>[gpiImM0-9]*`;
const SED_Y = String.raw`y(?<y>[^\w\s\\])(?:(?!\k<y>)[^\\\n]|\\.)*\k<y>(?:(?!\k<y>)[^\\\n]|\\.)*\k<y>`;
/** One token of a read-only sed script: a separator, a block's close, or an optionally addressed command that only
 *  prints, deletes, moves lines or substitutes (an `s` flag that writes or executes, `w`, `e`, `r`, `a`/`i`/`c`, a label
 *  or branch, anything else: not read-only). */
const SED_TOKEN = new RegExp(String.raw`\s*(?:[;\n]|\}|(?:${SED_RANGE}\s*)?!?\s*(?:\{|[pdqQ=nNPDhHgGxlzF]|${SED_SUBST}|${SED_Y}))`, "y");

function sedScriptIsReadOnly(script: string): boolean {
  let i = 0;
  while (script.slice(i).trim()) {
    SED_TOKEN.lastIndex = i;
    if (!SED_TOKEN.exec(script) || SED_TOKEN.lastIndex === i) return false;
    i = SED_TOKEN.lastIndex;
  }
  return true;
}

/** True when every simple command of `command` is read-only: pipes and `&&`/`||`/`;` between
 *  read-only commands are fine; a redirection to anything but /dev/null or an fd, a substitution, a background `&`, an
 *  unquoted brace expansion, a backslash, or any program outside the known set makes the whole command "not read-only",
 *  and so does a line `refusesAutoApproval`. */
export function isReadOnlyShell(command: string): boolean {
  const trimmed = stripHarmlessRedirects(command.trim()).trim();
  if (!trimmed) return false;
  if (refusesAutoApproval(decomposeBash(command))) return false;
  // Remaining redirections and `tee` write; command substitution runs arbitrary code; a trailing
  // `&` is a background job we do not reason about. Check outside quotes.
  const unquoted = trimmed.replace(/'[^']*'|"[^"]*"/g, "");
  if (/[<>]|`|\$\(/.test(unquoted)) return false;
  // A brace expansion or a backslash changes an argument after the checks below read it (`find . {-delete,}` and
  // `find . -de\lete` both run `find . -delete`); a backslash anywhere, quoted or not, is refused (D-27 round 6).
  if (trimmed.includes("\\") || BRACE_EXPANSION.test(unquoted)) return false;
  if (/&/.test(unquoted.replace(/&&/g, ""))) return false;
  const parts = splitShellCommands(trimmed);
  if (parts.length === 0) return false;
  const quotedSpace = /'[^']*\s[^']*'|"[^"]*\s[^"]*"/.test(trimmed);
  for (const part of parts) {
    for (const stage of part.split("|")) {
      if (!simpleIsReadOnly(stage, quotedSpace)) return false;
    }
  }
  return true;
}
