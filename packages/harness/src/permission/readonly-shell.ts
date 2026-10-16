import { splitShellCommands } from "./safety";

/**
 * Deterministic read-only classification of a shell command, for cruise mode: a command whose
 * every simple command is a known read-only program, with no redirection (other than to /dev/null
 * or another fd), substitution or escalation, runs without a prompt. Anything unrecognised is NOT read-only; the mode then asks.
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
const VERSION_FLAGS = new Set(["--version", "-v", "-V", "version", "--help", "-h", "help"]);
/** git subcommands that never write, with the argument checks that keep them so. */
const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "grep", "cat-file", "shortlog", "reflog", "rev-list", "name-rev", "count-objects", "var", "check-ignore", "merge-base", "for-each-ref", "symbolic-ref", "show-ref", "whatchanged", "diff-tree", "diff-index", "diff-files", "worktree"]);

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

function simpleIsReadOnly(cmd: string): boolean {
  const argv = tokens(cmd.trim());
  if (!argv || argv.length === 0) return false;
  // Leading VAR=value assignments are fine; a bare assignment is not a read.
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
  const prog = argv[i];
  if (!prog) return false;
  const args = argv.slice(i + 1);
  const base = prog.includes("/") ? prog.slice(prog.lastIndexOf("/") + 1) : prog;
  if (base === "sudo" || base === "doas" || base === "su" || base === "xargs" || base === "eval" || base === "exec" || base === "source" || base === ".") return false;
  if (base === "git") {
    const sub = args.find((a) => !a.startsWith("-"));
    if (!sub || !GIT_READ.has(sub)) {
      // branch / tag / stash / remote / config list only when given no operand that would write.
      if (sub === "branch" || sub === "tag") return args.every((a) => a === sub || a.startsWith("-")) && !args.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream-to)/.test(a));
      if (sub === "stash") return args[args.indexOf(sub) + 1] === "list" || args[args.indexOf(sub) + 1] === "show";
      if (sub === "remote") return args.slice(args.indexOf(sub) + 1).every((a) => a === "-v" || a === "--verbose" || a === "show" || a === "get-url");
      if (sub === "config") return args.some((a) => a === "--get" || a === "--list" || a === "-l" || a === "--get-all" || a === "--get-regexp");
      return false;
    }
    if (sub === "worktree") return args[args.indexOf(sub) + 1] === "list";
    // `git log --output=file` and friends write; refuse any output-to-file flag.
    return !args.some((a) => a.startsWith("--output"));
  }
  if (base === "find") return !args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir" || a === "-fprint" || a === "-fls" || a === "-fprintf");
  if (base === "sed") return !args.some((a) => /^-i|^--in-place/.test(a)) && !args.some((a) => /(^|[;\n])\s*w\b/.test(a) || /^-[a-zA-Z]*s.*w$/.test(a));
  if (base === "awk" || base === "gawk") return !args.some((a) => />\s*"|^-v\s*$/.test(a)) && !args.some((a) => a.includes("system("));
  if (base === "tee" || base === "tee_never") return false;
  // `ss -K` / `--kill` closes sockets; every other `ss` form only lists them.
  if (base === "ss") return !args.some((a) => a === "--kill" || /^-[a-zA-Z]*K/.test(a));
  if (VERSION_ONLY.has(base)) return args.length === 1 && VERSION_FLAGS.has(args[0]!);
  if (READ_ONLY.has(base)) return true;
  return false;
}

/** True when every simple command of `command` is read-only: pipes and `&&`/`||`/`;` between
 *  read-only commands are fine; a redirection to anything but /dev/null or an fd, a substitution, a background `&`, or any program
 *  outside the known set makes the whole command "not read-only". */
export function isReadOnlyShell(command: string): boolean {
  const trimmed = stripHarmlessRedirects(command.trim()).trim();
  if (!trimmed) return false;
  // Remaining redirections and `tee` write; command substitution runs arbitrary code; a trailing
  // `&` is a background job we do not reason about. Check outside quotes.
  const unquoted = trimmed.replace(/'[^']*'|"[^"]*"/g, "");
  if (/[<>]|`|\$\(/.test(unquoted)) return false;
  if (/&/.test(unquoted.replace(/&&/g, ""))) return false;
  const parts = splitShellCommands(trimmed);
  if (parts.length === 0) return false;
  for (const part of parts) {
    for (const stage of part.split("|")) {
      if (!simpleIsReadOnly(stage)) return false;
    }
  }
  return true;
}
