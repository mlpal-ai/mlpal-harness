/**
 * The simple commands a Bash command runs, as a permission rule sees them (W3 window defect D-27, controller ruling and
 * the reviewer's additions). A rule must find `git push` wherever the shell would run it — inside `sh -c '…'`, a
 * `$(…)`, backticks, a subshell or group, an `if`/`for`/`while`/`until`/`case` body, behind `env`/`FOO=1`/`timeout`/
 * `nice`, after git's global options, as `xargs`'s command — and must not refuse an ordinary script for being one.
 *
 * - decomposed: `sh|bash … -c '<literal script>'` (option bundles ending in `c`, `-o <opt>` skipped), `$(…)`, backticks,
 *   `<(…)`/`>(…)`, subshells, groups, compound bodies, `case` arms; recursion depth ≤ 3;
 * - normalised: whitespace; leading `NAME=value`; the prefixes `env` (`-i`, `-u NAME`, `-C DIR`), `command` (`-p`),
 *   `builtin`, `time` (`-p`), `nohup`, `timeout` (its options and duration), `nice` (`-n N`, `-N`), `stdbuf` (`-i|-o|-e
 *   MODE`), `ionice` (`-c N`, `-n N`, `-t`); git's global options before its subcommand (`-C <path>`, `-c k=v`,
 *   `--git-dir=…`, `--work-tree=…`, …); `xargs` and its options; an absolute command path to its basename (both forms
 *   are tried); `$((…))` (arithmetic, no command; kept as written); here-doc bodies (data);
 * - redirections (D-37, round 6): recorded per command as written (`redirected`, for a deny or an approval: a group's,
 *   subshell's or compound's redirection is each inner command's), and on the line, every one that writes a file other
 *   than `/dev/null`, `/dev/std{in,out,err}` or `/dev/fd/N` (`writes`): such a line is never auto-approved;
 * - best-effort (checked as the command named, contents not inspected; `bestEffort`): a shell running a script file
 *   (`bash script.sh`), a command run by a relative path (`./x.sh`);
 * - words as bash passes them: quotes and backslashes removed as bash removes them (inside double quotes a backslash
 *   escapes only `$`, backtick, `"`, `\` and a newline), `$'…'` decoded (`ansiC`'s escapes; one bash versions read
 *   differently is a run-time part), `$"…"` as double quotes, line continuations joined. A part bash knows only when
 *   it runs (an expansion, a substitution, arithmetic, an unquoted glob or brace word, a leading `~`) is kept as
 *   written and is UNKNOWN in the command's `wild` form, which a deny or a gating class reads as "any value";
 * - opaque (`opaque` names the form; a rule on Bash fails closed): an expansion or quoting as the command name, `eval`, `source`/
 *   `.`, `exec`, `sudo`/`doas`/`su`, a shell with a non-literal script or reading stdin, a here-doc into a shell, a
 *   function definition, `select`/`coproc`, an option a prefix does not take, `env -S`, unbalanced quotes or
 *   parentheses, depth > 3;
 * - environment-changing (every command of the line `envInjected`; D-27 round 3): any `NAME=value` (before a command
 *   or standing alone), `env` with an option or assignment, a builtin that assigns (`export`, `read`, `declare`, `let`,
 *   `alias`, `hash`, `printf -v`, …), a `for` loop variable, an assignment in `$((…))` or `${NAME:=…}`, a login or
 *   interactive shell (`-l`, `--login`, `-i`, `-o login|interactive`), a shell that reads a user rc file with `-c`
 *   (`zsh` without `-f` reads `~/.zshenv`; `bash --debugger`): it can point a later `git` at a planted binary, config
 *   or rc file, and in a loop it reaches the commands before it too;
 * - environment-changing for that command only (`envInjected`; D-27 round 4): a `git` with any global option stripped
 *   (`-c core.fsmonitor=…` runs a command; `-C`, `--git-dir`, `--exec-path` move git onto planted files). The deny side
 *   matches the stripped form; the allow side never auto-approves it.
 */

/** A redirection as written: its operator with any fd (`>`, `2>>`, `&>`, `>|`, `<>`, `<<<`, `>&`, `3>&`), and its
 *  target with quotes removed (an fd for a duplication, the delimiter for a here-doc). */
export interface Redirection {
  operator: string;
  target: string;
  /** The target is exactly the file opened: no expansion, no unquoted `~` or glob. */
  literal: boolean;
}

export interface DecomposedCommand {
  /** The forms a rule is matched against (any one matching counts): the command name, then its arguments with quotes
   *  removed, single-spaced; for an absolute path, both the basename form and the form as written. */
  forms: string[];
  /** Checked as named; what it runs (a script file's contents) is not inspected. */
  bestEffort?: boolean;
  /** It runs with arguments the matcher cannot see (`xargs <cmd>`): a deny or approval still checks the command, but
   *  an allow rule never auto-approves it (its arguments could be anything). */
  argsUnknown?: boolean;
  /** It runs in a line that changes the environment (`VAR=… cmd`, `PATH=…; cmd`, `env -i cmd`, `for PATH in …`,
   *  `$((PATH=0))`, `bash -lc …`, `zsh -c …`), or is a `git` whose global options were stripped (`git -c k=v status`):
   *  a deny or approval still checks the command, but an allow rule never auto-approves it (LD_PRELOAD,
   *  GIT_SSH_COMMAND, BASH_ENV, PATH, HOME, PAGER, core.fsmonitor … run code, and the matcher cannot judge which
   *  variable is safe). */
  envInjected?: boolean;
  /** Its forms with its redirections appended as written (`grep a b > /etc/x`), when it has any: a deny or an approval
   *  matches these too, an allow rule only `forms`. An entry with no `forms` runs no command (`> f`, `command -v git
   *  > /dev/null`): it is recorded for its redirections. */
  redirected?: string[];
  /** Its forms as the matcher read them before quoting was decoded exactly (`$'x'` as `$x`, `"a\b"` as `ab`), when
   *  that differs: a deny or an approval matches these too, so the exact reading never fires fewer of them. */
  legacy?: string[];
  /** Its form with every part whose value bash knows only when it runs (a parameter expansion, a substitution,
   *  arithmetic, a glob or brace word, a leading `~`, an escape bash versions read differently) as `UNKNOWN`: a deny or
   *  an approval, and a gating class, anchored at the command names it if ANY value could make it match
   *  (`bashDenyOverlap`), so `mlpal mcp $(echo delete) srv` meets `mlpal mcp delete*`. Present only when the command
   *  has such a part. */
  wild?: string;
  /** The line sets a variable that picks the code a command runs (PATH, LD_PRELOAD, BASH_ENV…): a gating entry still
   *  matches it by name, but a readOnly entry never admits it (a planted file could answer to a read-only name). */
  codePathChanged?: boolean;
  /** A word of it was written in ANSI-C (`$'…'`) or locale (`$"…"`) quoting. Its forms hold the decoded words, as bash
   *  runs them, for the deny side; the line is never auto-approved (`refusesAutoApproval`). */
  specialQuoting?: boolean;
}

/** In a `wild` form: any string, of any length, spaces included. */
export const UNKNOWN = "\uFFFF";

export interface Decomposed {
  commands: DecomposedCommand[];
  /** The form that could not be decomposed, or null: a rule on Bash must treat the command as matching. */
  opaque: string | null;
  /** Every redirection on the line, at any depth, that writes a file other than `/dev/null`, `/dev/std{in,out,err}`
   *  or `/dev/fd/N` (empty when `opaque`). */
  writes: Redirection[];
}

/**
 * Whether no part of this line may be auto-approved, whatever runs on it: it could not be decomposed, a command of it
 * runs in a changed environment (`envInjected`), or it writes a file through a redirection (`writes`). The one judgement
 * both auto-approval paths refuse on — an allow rule (engine.ts) and cruise's read-only check (readonly-shell.ts) — so
 * the two cannot drift (D-27 round 5, D-37 round 6).
 */
export function refusesAutoApproval(d: Decomposed): boolean {
  return d.opaque !== null || d.writes.length > 0 || d.commands.some((c) => c.envInjected === true || c.specialQuoting === true);
}

/** Files a redirection may write without touching the estate. */
const HARMLESS_TARGET = /^\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)$/;

/** Whether a redirection to a target word opens a file for writing (`>`, `>>`, `>|`, `&>`, `<>`, `>&file`, with any fd),
 *  other than a harmless one; an input (`<`, `<<<`) writes nothing, nor does a duplication (`2>&1`, `>&-`) or a here-doc,
 *  which have no target word. */
function writesFile(r: Redirection): boolean {
  return r.operator.includes(">") && !(r.literal && HARMLESS_TARGET.test(r.target));
}

const MAX_DEPTH = 3;
const OPAQUE_HEAD = new Set(["eval", "source", ".", "exec", "sudo", "doas", "su", "busybox", "parallel"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh"]);
/** Words that open or close shell syntax around the commands of a compound; the command after them is checked. */
const COMPOUND = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"]);
const UNSUPPORTED = new Set(["select", "function", "coproc"]);
/** Builtins that assign a variable, an alias or a command's path for the rest of the line. */
const ASSIGNING_BUILTINS = new Set(["export", "declare", "typeset", "local", "readonly", "unset", "read", "mapfile", "readarray", "let", "getopts", "alias", "unalias", "hash", "enable"]);
/** Variables that choose the code a later command runs (which file a name is, a library, a startup script, an
 *  interpreter's options): a line that sets one is never admitted as read-only (`codePathChanged`). */
const CODE_VARS: ReadonlySet<string> = new Set([
  "PATH", "BASH_ENV", "ENV", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PERL5OPT", "PERL5LIB",
  "RUBYOPT", "RUBYLIB", "GIT_EXEC_PATH", "BASH_LOADABLES_PATH", "CDPATH",
]);
/** `set` options that change no later word: errors, tracing, globbing off, clobbering; and `--` (positional words,
 *  already run-time values). Any other (`-k` makes a later `X=1` an assignment, `-a` exports) is opaque. */
const SAFE_SET_FLAGS = /^[-+][euxvfCEBhT]+$/;
const SAFE_SET_OPTIONS: ReadonlySet<string> = new Set(["errexit", "nounset", "xtrace", "verbose", "noglob", "noclobber", "errtrace", "pipefail", "functrace", "hashall"]);
/** An assignment in arithmetic (`x=1`, `x+=1`, `x<<=1`, `a[i]=1`, `x++`, `--x`); `==`, `!=`, `<=`, `>=` are not. */
const ARITHMETIC_ASSIGNMENT = /[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\s*(?:<<|>>|[-+*/%&^|])?=(?!=)|\+\+|--/;
/** A parameter expansion that assigns (`${x=…}`, `${x:=…}`). */
const PARAMETER_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?:?=/;
/** Shell options that read a login or interactive rc file before the script runs. */
const RC_SHELL_OPTIONS = new Set(["login", "interactive"]);

/** What the whole line does beyond its commands. */
interface Line {
  /** Something on the line changes the environment a command runs in (see the module comment). */
  envChanged: boolean;
  /** The redirections that write a file (`Decomposed.writes`). */
  writes: Redirection[];
  /** For tests (`shellWords`): every simple command's words as written, before anything is stripped. */
  words?: string[][];
  /** A variable that picks the code that runs (CODE_VARS) is set somewhere on the line. */
  codePath?: boolean;
}

const newWord = (): Word => ({ text: "", legacy: "", wild: "", expanded: false, literal: true });
/** Append the same characters to every reading of the word. */
const add = (w: Word, s: string) => {
  w.text += s;
  w.legacy += s;
  w.wild += s;
};
/** Append a part bash knows only at run time: kept as written, UNKNOWN in the wild reading. */
const addUnknown = (w: Word, written: string) => {
  w.text += written;
  w.legacy += written;
  if (!w.wild.endsWith(UNKNOWN)) w.wild += UNKNOWN;
  w.expanded = true;
  w.literal = false;
};
/** Words that open a group or compound whose redirections apply to every command in it, and the words that close one. */
const OPENERS = new Set(["{", "if", "while", "until", "for"]);
const CLOSERS = new Set(["}", "fi", "done"]);

interface PrefixSpec {
  noArg?: string[];
  arg?: string[];
  /** Options with their value attached (`-n10`, `-oL`). */
  attached?: RegExp;
  /** A bare `-<number>` option (`nice -10`). */
  numeric?: boolean;
  /** Options after which no command runs (`command -v git`). */
  noCommand?: string[];
  /** Options that make the rest unparseable (`env -S '…'`). */
  opaque?: string[];
  /** Positional words before the command (`timeout 30s cmd`). */
  positional?: number;
  /** `NAME=value` words before the command (`env FOO=1 cmd`). */
  assignments?: boolean;
}
const PREFIXES: Record<string, PrefixSpec> = {
  env: { noArg: ["-i", "--ignore-environment", "-0", "--null"], arg: ["-u", "--unset", "-C", "--chdir"], opaque: ["-S", "--split-string"], assignments: true },
  command: { noArg: ["-p"], noCommand: ["-v", "-V"] },
  builtin: {},
  time: { noArg: ["-p"] },
  nohup: {},
  timeout: { noArg: ["--preserve-status", "--foreground", "-v", "--verbose"], arg: ["-s", "--signal", "-k", "--kill-after"], positional: 1 },
  nice: { arg: ["-n", "--adjustment"], attached: /^-n-?\d+$/, numeric: true },
  stdbuf: { arg: ["-i", "-o", "-e", "--input", "--output", "--error"], attached: /^-[ioe].+$/ },
  ionice: { noArg: ["-t", "--ignore"], arg: ["-c", "-n", "--class", "--classdata"], attached: /^-[cn]\d+$/, noCommand: ["-p", "--pid", "-P", "--pgid", "-u", "--uid"] },
  xargs: {
    noArg: ["-0", "-r", "-t", "-p", "-x", "--null", "--no-run-if-empty", "--verbose", "--interactive", "--exit", "--open-tty", "-o"],
    arg: ["-n", "-I", "-L", "-P", "-s", "-d", "-E", "-a", "--max-args", "--replace", "--max-lines", "--max-procs", "--max-chars", "--delimiter", "--eof", "--arg-file"],
    attached: /^-[nILPsdEa].+$/,
  },
};
const SHELL_LONG_FLAGS = new Set(["--norc", "--noprofile", "--login", "--posix", "--noediting", "--restricted", "--verbose", "--debugger"]);
const SHELL_LONG_WITH_VALUE = new Set(["--rcfile", "--init-file"]);
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env", "--list-cmds"]);

interface Word {
  /** The word as the command receives it: quotes removed (ANSI-C escapes decoded), substitutions kept as written. */
  text: string;
  /** The word as the matcher read it before quoting was decoded exactly (see `DecomposedCommand.legacy`). */
  legacy: string;
  /** `text` with each part whose value is known only at run time as UNKNOWN (see `DecomposedCommand.wild`). */
  wild: string;
  /** Written in ANSI-C or locale quoting somewhere. */
  special?: boolean;
  /** Parameter expansion or substitution somewhere in it (unquoted or double-quoted). */
  expanded: boolean;
  /** Entirely literal: its text is exactly what runs. */
  literal: boolean;
  /** An unquoted glob or brace character (`*?[{}`): as a command name, bash would expand it. */
  glob?: boolean;
  /** It starts with an unquoted `~` (tilde expansion). */
  tilde?: boolean;
  /** Its `~` is followed by an unquoted `/`: bash expands it to `$HOME` (with a bare `~`, the only such forms). */
  tildeSlash?: boolean;
}

class Opaque extends Error {
  constructor(readonly form: string) {
    super(form);
  }
}
const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);

export function decomposeBash(command: string): Decomposed {
  const commands: DecomposedCommand[] = [];
  const line: Line = { envChanged: false, writes: [] };
  try {
    decompose(command, 0, commands, line);
    if (line.envChanged) for (const c of commands) c.envInjected = true;
    if (line.codePath) for (const c of commands) c.codePathChanged = true;
    return { commands, opaque: null, writes: line.writes };
  } catch (e) {
    if (e instanceof Opaque) return { commands: [], opaque: e.form, writes: [] };
    throw e;
  }
}

function decompose(command: string, depth: number, out: DecomposedCommand[], line: Line): void {
  if (depth > MAX_DEPTH) throw new Opaque(`nested deeper than ${MAX_DEPTH}`);
  const inner = (s: string) => decompose(s, depth + 1, out, line);
  let words: Word[] = [];
  let word: Word | null = null;
  let skipNext = false;
  let heredoc = false;
  const pendingHeredocs: Array<{ delimiter: string; strip: boolean; quoted: boolean }> = [];
  /** Open `case` statements: reading an arm's pattern, or its commands. */
  const cases: Array<"pattern" | "body"> = [];
  /** This simple command's redirections as written; the operator awaiting its target word (`skipNext`). */
  let redirections: string[] = [];
  let pending: { operator: string; spaced: boolean } | null = null;
  /** Where each open group or compound's commands start in `out`, and the start of the one this command closed. */
  const openers: number[] = [];
  let closed: number | null = null;
  const written = (r: Redirection, spaced: boolean) => redirections.push(`${r.operator}${spaced ? " " : ""}${r.target}`);
  const endWord = () => {
    if (word) {
      if (skipNext) {
        skipNext = false;
        const r = { operator: pending!.operator, target: word.text, literal: word.literal && !word.glob && !word.tilde };
        written(r, pending!.spaced);
        if (writesFile(r)) line.writes.push(r);
        pending = null;
      } else {
        if (word.literal && words.every((w) => w.literal && COMPOUND.has(w.text))) {
          if (OPENERS.has(word.text)) openers.push(out.length);
          else if (CLOSERS.has(word.text)) closed = openers.pop() ?? null;
        }
        // bash expands an unquoted glob or brace word to names it finds, and a leading `~` to a home. A `~` it expands
        // to the command's own $HOME (bare, or before an unquoted `/`) is kept as written, as production's engine read
        // it, while nothing on the line could have changed HOME; `~user`, `~+`, `~-` and the rest stay run-time values
        if (word.glob) word.wild = UNKNOWN;
        else if (word.tilde && !(word.literal && homeTildeRest(word.text) !== null && (word.text === "~" || word.tildeSlash) && !homeMayChange(words, line))) word.wild = UNKNOWN + word.wild.slice(1);
        words.push(word);
      }
    }
    word = null;
    if (words.length === 3 && words[0]!.literal && words[0]!.text === "case" && words[2]!.literal && words[2]!.text === "in") {
      words = [];
      cases.push("pattern");
      openers.push(out.length);
    }
  };
  const esac = () => {
    cases.pop();
    closed = openers.pop() ?? null;
  };
  const cur = (): Word => (word ??= newWord());
  const endCommand = () => {
    endWord();
    if (skipNext) throw new Opaque("a redirection with no target");
    if (words.length) line.words?.push(words.map((w) => (w.wild.includes(UNKNOWN) ? UNKNOWN : w.text)));
    const from = out.length;
    simple(words, depth, out, line, heredoc);
    if (redirections.length) {
      // a closing word's redirections are its group's; a line of redirections alone is recorded as written
      const to = closed ?? from;
      if (to < out.length) for (const c of out.slice(to)) c.redirected = (c.redirected ?? c.forms).map((f) => `${f} ${redirections.join(" ")}`);
      else out.push({ forms: [], redirected: [[...words.map((w) => w.text), ...redirections].join(" ")] });
    }
    words = [];
    heredoc = false;
    redirections = [];
    closed = null;
  };
  const close = (open: number): number => {
    const end = matchParen(command, open);
    if (end < 0) throw new Opaque("unbalanced parentheses");
    return end;
  };
  const atWord = (i: number, w: string) => command.startsWith(w, i) && !/[^\s;&|)]/.test(command[i + w.length] ?? " ");
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    const inCase = cases[cases.length - 1];
    if (inCase === "pattern" && word === null) {
      if (/\s/.test(c)) continue;
      if (atWord(i, "esac")) {
        esac();
        i += 3;
        continue;
      }
      // the arm's pattern, up to its unquoted `)`
      let j = c === "(" ? i + 1 : i;
      let quote: string | null = null;
      for (; j < command.length; j++) {
        const d = command[j]!;
        if (quote) {
          if (d === quote) quote = null;
        } else if (d === "'" || d === '"') quote = d;
        else if (d === ")") break;
      }
      if (j >= command.length) throw new Opaque("an unterminated case arm");
      cases[cases.length - 1] = "body";
      i = j;
      continue;
    }
    if (inCase === "body" && word === null && words.length === 0 && atWord(i, "esac")) {
      esac();
      i += 3;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "\n") {
      endCommand();
      for (const h of pendingHeredocs.splice(0)) {
        // the body, up to the delimiter's line: data, but an unquoted delimiter's body is expanded (its substitutions run)
        let found = false;
        const body: string[] = [];
        while (i < command.length) {
          const eol = command.indexOf("\n", i + 1);
          const line = command.slice(i + 1, eol < 0 ? command.length : eol);
          i = eol < 0 ? command.length : eol;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delimiter) {
            found = true;
            break;
          }
          body.push(line);
          if (eol < 0) break;
        }
        if (!found) throw new Opaque("an unterminated here-doc");
        if (!h.quoted) substitutions(body.join("\n"), inner, line, false);
      }
      continue;
    }
    if (c === ";") {
      if (next === ";" || (next === "&" && inCase === "body")) {
        if (inCase !== "body") throw new Opaque("`;;` outside a case");
        endCommand();
        i += next === ";" && command[i + 2] === "&" ? 2 : 1;
        cases[cases.length - 1] = "pattern";
        continue;
      }
      endCommand();
      continue;
    }
    if (c === "#" && word === null) {
      const nl = command.indexOf("\n", i);
      i = nl < 0 ? command.length : nl - 1;
      continue;
    }
    if (c === "|" || (c === "&" && next !== ">")) {
      if ((c === "|" && (next === "|" || next === "&")) || (c === "&" && next === "&")) i++;
      endCommand();
      continue;
    }
    if (c === "<" || c === ">" || (c === "&" && next === ">")) {
      if ((c === "<" || c === ">") && next === "(") {
        const end = close(i + 1);
        inner(command.slice(i + 2, end));
        add(cur(), "/dev/fd/0");
        i = end;
        continue;
      }
      const w = word as Word | null;
      let fd = "";
      if (w && /^[0-9]+$/.test(w.text) && w.literal) {
        fd = w.text;
        word = null;
      } else endWord();
      if (c === "<" && next === "<" && command[i + 2] !== "<") {
        // a here-doc: its delimiter, then its body after the line
        let j = i + 2;
        const strip = command[j] === "-";
        if (strip) j++;
        const spaced = command[j] === " " || command[j] === "\t";
        while (command[j] === " " || command[j] === "\t") j++;
        const m = /^(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(command.slice(j));
        if (!m) throw new Opaque("a here-doc with no delimiter");
        // a quoted delimiter (`'EOF'`, `"EOF"`, `\EOF`) keeps the body as data; an unquoted one expands it
        const delimiter = m[1] ?? m[2] ?? m[3]!;
        pendingHeredocs.push({ delimiter, strip, quoted: m[1] !== undefined || m[2] !== undefined || m[0].startsWith("\\") });
        written({ operator: `${fd}${strip ? "<<-" : "<<"}`, target: delimiter, literal: true }, spaced);
        heredoc = true;
        i = j + m[0].length - 1;
        continue;
      }
      // The operator (`>`, `>>`, `<`, `&>`, `>|`, `<<<`, `>&`), then an fd it duplicates (`>&2`, `2>&1`, `<&-`) or a
      // target word, which is not an argument.
      let j = i;
      while (j + 1 < command.length && "<>&|".includes(command[j + 1]!)) j++;
      const operator = fd + command.slice(i, j + 1);
      if (command[j] === "&" && j > i && /[0-9-]/.test(command[j + 1] ?? "")) {
        const at = j + 1;
        while (j + 1 < command.length && /[0-9-]/.test(command[j + 1]!)) j++;
        written({ operator, target: command.slice(at, j + 1), literal: true }, false);
      } else {
        skipNext = true;
        pending = { operator, spaced: command[j + 1] === " " || command[j + 1] === "\t" };
      }
      i = j;
      continue;
    }
    if (c === "(") {
      if (word !== null || words.length > 0) throw new Opaque(clip(`${words.map((x) => x.text).join(" ")} ${(word as Word | null)?.text ?? ""}(`.trim()) + " (a function definition)");
      const end = close(i);
      const from = out.length;
      inner(command.slice(i + 1, end)); // a subshell: a redirection after it is its commands'
      closed = from;
      i = end;
      continue;
    }
    if (c === ")") throw new Opaque("unbalanced parentheses");
    if (c === "\\") {
      if (next === "\n") {
        i++;
        continue;
      }
      if (next !== undefined) add(cur(), next);
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      i = quoted(command, i, cur(), inner, close, line);
      continue;
    }
    if (c === "$" || c === "`") {
      i = expansion(command, i, cur(), inner, close, line);
      continue;
    }
    const w = cur();
    if (c === "/" && w.tilde && w.text === "~") w.tildeSlash = true;
    if (c === "~" && w.text === "") w.tilde = true;
    add(w, c);
    if ("*?[{}".includes(c)) w.glob = true;
  }
  endCommand();
  if (pendingHeredocs.length) throw new Opaque("an unterminated here-doc");
  if (cases.length) throw new Opaque("an unterminated case");
}

/** A quoted span at `i` (`'…'` or `"…"`) added to the word with its quotes removed, as the command receives it: inside
 *  double quotes a backslash keeps the next character and `$`/backticks expand. Answers the closing quote's index. */
function quoted(s: string, i: number, w: Word, inner: (cmd: string) => void, close: (open: number) => number, line: Line): number {
  if (s[i] === "'") {
    const end = s.indexOf("'", i + 1);
    if (end < 0) throw new Opaque("unbalanced quotes");
    add(w, s.slice(i + 1, end));
    return end;
  }
  let j = i + 1;
  for (; j < s.length && s[j] !== '"'; j++) {
    const d = s[j]!;
    if (d === "\\" && j + 1 < s.length) {
      // bash: inside double quotes a backslash escapes only `$`, backtick, `"`, `\` and a newline (both then vanish);
      // before anything else it stays. The legacy reading dropped it before every character.
      const e = s[j + 1]!;
      if ("$`\"\\".includes(e)) add(w, e);
      else if (e === "\n") w.legacy += e;
      else {
        w.text += `\\${e}`;
        w.wild += `\\${e}`;
        w.legacy += e;
      }
      j++;
    } else if (d === "$" || d === "`") j = expansion(s, j, w, inner, close, line);
    else add(w, d);
  }
  if (j >= s.length) throw new Opaque("unbalanced quotes");
  return j;
}

/**
 * A rule's argument pattern read the way `decomposeBash` reads a command (E-11), by the same code (`quoted`,
 * `expansion`): quotes and backslashes removed, whitespace single-spaced, so `python3 -c 'import x'` reads
 * `python3 -c import x`. Every other character is kept as written (operators, `$…`, `~`, each `*`): the pattern is
 * never split into commands. Null when its quoting does not balance. This is the widening reading, for a deny rule or
 * an approval entry only (R19): an allow never matches through it.
 */
export function normalizeBashPattern(pattern: string): string | null {
  const words: string[] = [];
  let w: Word | null = null;
  const unused: Line = { envChanged: false, writes: [] };
  const ignore = () => {};
  const close = (open: number) => {
    const end = matchParen(pattern, open);
    if (end < 0) throw new Opaque("unbalanced parentheses");
    return end;
  };
  try {
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i]!;
      if (c === " " || c === "\t" || c === "\n") {
        if (w) words.push(w.legacy);
        w = null;
        continue;
      }
      if (c === "\\" && pattern[i + 1] === "\n") {
        i++;
        continue;
      }
      w ??= newWord();
      if (c === "\\") {
        if (i + 1 < pattern.length) add(w, pattern[i + 1]!);
        i++;
      } else if (c === "'" || c === '"') i = quoted(pattern, i, w, ignore, close, unused);
      else if (c === "$" || c === "`") i = expansion(pattern, i, w, ignore, close, unused);
      else add(w, c);
    }
  } catch (e) {
    if (e instanceof Opaque) return null;
    throw e;
  }
  // the legacy reading: a pattern is read exactly as it was before command words were decoded exactly
  if (w) words.push(w.legacy);
  // single-spaced and trimmed, as a command's forms are (a quoted run of whitespace included)
  return words.join(" ").replace(/\s+/g, " ").trim();
}

/** What `bashAsWritten` does not follow: a line break, and the constructs that nest quoting or commands. */
const NOT_AS_WRITTEN = /[\n\r`]|\$[({'"]/;

/**
 * A command line, or an allow rule's quoted pattern, as written (ruling R19): only the runs of blanks outside quotes
 * are collapsed and the ends trimmed. Quotes and backslashes are kept, so two texts are equal here only when the shell
 * is handed the same quoting. Null when the quoting does not balance, or the text holds a line break, a substitution,
 * `${…}`, `$'…'` or `$"…"`: an allow then matches nothing, and the call falls to the mode.
 */
export function bashAsWritten(text: string): string | null {
  if (NOT_AS_WRITTEN.test(text)) return null;
  let out = "";
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === " " || c === "\t") {
      gap = out !== "";
      continue;
    }
    if (gap) out += " ";
    gap = false;
    let end = i;
    if (c === "\\") end = i + 1;
    else if (c === "'") end = text.indexOf("'", i + 1);
    else if (c === '"') {
      for (end = i + 1; end < text.length && text[end] !== '"'; end++) if (text[end] === "\\") end++;
    }
    if (end < 0 || end >= text.length) return null;
    out += text.slice(i, end + 1);
    i = end;
  }
  return out;
}

/** An expansion at `i` (`$((…))`, `$(…)`, backticks, `$name`, `${…}`): substitutions decomposed, the word marked.
 *  Answers the index of its last character. */
function expansion(s: string, i: number, w: Word, inner: (cmd: string) => void, close: (open: number) => number, line: Line): number {
  if (s[i] === "`") {
    const end = s.indexOf("`", i + 1);
    if (end < 0) throw new Opaque("unbalanced backticks");
    inner(s.slice(i + 1, end));
    addUnknown(w, s.slice(i, end + 1));
    return end;
  }
  const next = s[i + 1];
  if (next === "'") return ansiC(s, i, w);
  if (next === '"') {
    // locale quoting: bash translates the string through a message catalog, which no host here has, so it is the
    // double-quoted string itself. The word stays non-literal: as a command name it is still refused.
    w.legacy += "$";
    w.special = true;
    w.expanded = true;
    w.literal = false;
    return quoted(s, i + 1, w, inner, close, line);
  }
  if (next === "(" && s[i + 2] === "(") {
    // arithmetic: no command runs itself, but substitutions inside it do (kept as written, so a refusal shows it)
    const end = close(i + 1);
    arithmetic(s.slice(i + 3, end - 1), inner, line, true);
    addUnknown(w, s.slice(i, end + 1));
    return end;
  }
  if (next === "(") {
    const end = close(i + 1);
    inner(s.slice(i + 2, end));
    addUnknown(w, s.slice(i, end + 1));
    return end;
  }
  if (next === "{") {
    // a parameter expansion: its operators (`${x:-…}`, `${x/…/…}`) may hold substitutions, which run
    const end = matchBrace(s, i + 1);
    if (end < 0) throw new Opaque("an unterminated ${…}");
    parameter(s.slice(i + 2, end), inner, line, true);
    addUnknown(w, s.slice(i, end + 1));
    return end;
  }
  const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?$!#*@-])/.exec(s.slice(i));
  if (!m) {
    add(w, "$");
    return i;
  }
  addUnknown(w, m[0]);
  return i + m[0].length - 1;
}

/** Simple escapes of ANSI-C quoting, as bash 3.2 and 5 both read them. */
const ANSI_SIMPLE: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"', "?": "?" };

/**
 * ANSI-C quoting at `i` (`$'…'`), decoded to what bash passes: the simple escapes, `\nnn` (one to three octal digits),
 * `\xHH` (one or two hex digits) and `\cX` for a letter X; a NUL ends the string. Any other escape makes the line
 * opaque (review R1): bash decodes forms this table does not (`\x{HH}`), reads `\u`, `\U` and `\c` before a
 * non-letter differently by version, and keeps an unknown one with its backslash; a byte past ASCII depends on the
 * locale. A `\'` inside it is opaque too. Answers the closing quote.
 */
function ansiC(s: string, i: number, w: Word): number {
  let j = i + 2;
  let out = "";
  let exact = true;
  let ended = false;
  for (; j < s.length && s[j] !== "'"; j++) {
    if (s[j] !== "\\") {
      if (!ended) out += s[j];
      continue;
    }
    const e = s[j + 1];
    if (e === undefined) break;
    if (e === "'") throw new Opaque("an escaped quote in ANSI-C quoting");
    j++;
    let ch: string;
    if (Object.hasOwn(ANSI_SIMPLE, e)) ch = ANSI_SIMPLE[e]!;
    else if (/[0-7]/.test(e)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(j))![0];
      j += m.length - 1;
      ch = String.fromCharCode(parseInt(m, 8) & 0xff);
    } else if (e === "x" && /[0-9A-Fa-f]/.test(s[j + 1] ?? "")) {
      const m = /^[0-9A-Fa-f]{1,2}/.exec(s.slice(j + 1))![0];
      j += m.length;
      ch = String.fromCharCode(parseInt(m, 16));
    } else if (e === "c" && /[A-Za-z]/.test(s[j + 1] ?? "")) {
      ch = String.fromCharCode(s[j + 1]!.charCodeAt(0) & 0x1f);
      j++;
    } else throw new Opaque(`an ANSI-C escape \\${e} the matcher does not decode exactly`);
    if (ch.charCodeAt(0) > 0x7f) throw new Opaque("an ANSI-C escape past ASCII (its byte depends on the locale)");
    if (ch === "\0") ended = true;
    if (!ended) out += ch;
  }
  if (j >= s.length) throw new Opaque("unbalanced quotes");
  const raw = s.slice(i + 2, j);
  w.legacy += `$${raw}`;
  if (exact) {
    w.text += out;
    w.wild += out;
  } else {
    w.text += s.slice(i, j + 1);
    if (!w.wild.endsWith(UNKNOWN)) w.wild += UNKNOWN;
  }
  w.special = true;
  w.expanded = true;
  w.literal = false;
  return j;
}

/** A `$((…))` body: its substitutions decomposed, an assignment in it recorded. */
function arithmetic(body: string, inner: (cmd: string) => void, line: Line, quotes: boolean): void {
  if (ARITHMETIC_ASSIGNMENT.test(body)) line.envChanged = true;
  substitutions(body, inner, line, quotes);
}

/** A `${…}` body: its substitutions decomposed, an assigning form recorded. */
function parameter(body: string, inner: (cmd: string) => void, line: Line, quotes: boolean): void {
  if (PARAMETER_ASSIGNMENT.test(body)) line.envChanged = true;
  if (PARAMETER_ASSIGNMENT.test(body) && CODE_VARS.has(/^[A-Za-z_][A-Za-z0-9_]*/.exec(body)![0])) line.codePath = true;
  substitutions(body, inner, line, quotes);
}

/** Every command substitution in `text` (`$(…)`, backticks, and those inside `${…}` and `$((…))`), decomposed. With
 *  `quotes`, single-quoted spans are data (a word); without (a here-doc body), quotes are literal characters. */
function substitutions(text: string, inner: (cmd: string) => void, line: Line, quotes: boolean): void {
  const local = (open: number) => {
    const end = matchParen(text, open);
    if (end < 0) throw new Opaque("unbalanced parentheses");
    return end;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (quotes && c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Opaque("unbalanced quotes");
      i = end;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) throw new Opaque("unbalanced backticks");
      inner(text.slice(i + 1, end));
      i = end;
      continue;
    }
    if (c !== "$") continue;
    if (text[i + 1] === "(" && text[i + 2] === "(") {
      const end = local(i + 1);
      arithmetic(text.slice(i + 3, end - 1), inner, line, quotes);
      i = end;
    } else if (text[i + 1] === "(") {
      const end = local(i + 1);
      inner(text.slice(i + 2, end));
      i = end;
    } else if (text[i + 1] === "{") {
      const end = matchBrace(text, i + 1);
      if (end < 0) throw new Opaque("an unterminated ${…}");
      parameter(text.slice(i + 2, end), inner, line, quotes);
      i = end;
    }
  }
}

/** The `}` closing the `{` at `open`, past nested braces, substitutions and quotes. */
function matchBrace(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "$" && s[i + 1] === "(") {
      const end = matchParen(s, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function matchParen(s: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

const basename = (w: string) => w.slice(w.lastIndexOf("/") + 1);

/**
 * The home tilde, by bash's rule on a word's text: a leading `~` whose prefix up to the first `/` is empty, which bash
 * expands to $HOME. Returns what follows the `~` ("" or "/…"), or null for `~user`, `~+`, `~-`, `~N` and a word with no
 * leading `~`. One definition for the engine: the decomposer applies it to an unquoted `~` before an unquoted `/`
 * (bash's rule, since it sees the quoting); the path rules (safety.ts normalWord), which see words with their quotes
 * removed, apply it to any leading `~`, which can only make them ask more.
 */
export function homeTildeRest(text: string): string | null {
  return text === "~" || text.startsWith("~/") ? text.slice(1) : null;
}

/** Commands that run the rest under another user or environment, so its HOME may not be the line's. */
const HOME_CHANGERS = new Set(["env", "sudo", "doas", "su", "runuser", "setpriv", "chroot", "pkexec", "machinectl", "systemd-run", "flatpak-spawn"]);

/** Whether HOME may differ from the command's own by the time a word of this command is expanded: anything earlier on
 *  the line changed the environment, or this command so far has an assignment or a word that runs it elsewhere. */
function homeMayChange(before: readonly Word[], line: Line): boolean {
  return line.envChanged || before.some((w) => !w.literal || ASSIGNMENT.test(w.text) || HOME_CHANGERS.has(basename(w.text)));
}
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const text = (ws: Word[]) => ws.map((w) => w.text).join(" ");

/** The words after a prefix's own options (and positional words), or null when no command runs. */
function afterPrefix(name: string, spec: PrefixSpec, words: Word[]): Word[] | null {
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i]!;
    const t = w.text;
    if (!t.startsWith("-") || t === "-") break;
    if (t === "--") {
      i++;
      break;
    }
    const flag = t.includes("=") && t.startsWith("--") ? t.slice(0, t.indexOf("=")) : t;
    if (spec.opaque?.includes(flag)) throw new Opaque(clip(`${name} ${text(words)}`));
    if (spec.noCommand?.includes(flag)) return null;
    if (spec.noArg?.includes(flag)) continue;
    if (spec.arg?.includes(flag)) {
      if (!t.includes("=")) i++;
      continue;
    }
    if (spec.attached?.test(t) || (spec.numeric && /^-\d+$/.test(t))) continue;
    throw new Opaque(clip(`${name} ${text(words)} (an option the matcher does not know)`));
  }
  if (spec.assignments) while (i < words.length && ASSIGNMENT.test(words[i]!.text)) i++;
  return words.slice(i + (spec.positional ?? 0));
}

/** One simple command (`commandOf`), each command it yields marked when a word of it used ANSI-C or locale quoting. */
function simple(input: Word[], depth: number, out: DecomposedCommand[], line: Line, heredoc: boolean): void {
  const from = out.length;
  commandOf(input, depth, out, line, heredoc);
  if (input.some((w) => w.special)) for (const c of out.slice(from)) c.specialQuoting = true;
}

/** One simple command: syntax, assignments and prefixes stripped, a shell's literal script decomposed, the rest
 *  recorded for the rules. */
function commandOf(input: Word[], depth: number, out: DecomposedCommand[], line: Line, heredoc: boolean): void {
  let words = input;
  for (;;) {
    const head = words[0];
    if (!head) return;
    if (head.literal && COMPOUND.has(head.text)) {
      words = words.slice(1);
      continue;
    }
    if (head.literal && head.text === "for") {
      // `for NAME in WORDS`: its words' substitutions were decomposed; any loop variable is an assignment (the matcher
      // does not judge which name is safe)
      line.envChanged = true;
      if (CODE_VARS.has(words[1]?.text ?? "")) line.codePath = true;
      return;
    }
    if (head.literal && (UNSUPPORTED.has(head.text) || head.text === "case" || head.text === "esac")) throw new Opaque(clip(text(words)));
    if (ASSIGNMENT.test(head.text) && !head.text.slice(0, head.text.indexOf("=")).includes("$")) {
      if (CODE_VARS.has(head.text.slice(0, head.text.indexOf("=")).replace(/\+$/, ""))) line.codePath = true;
      words = words.slice(1);
      // before a command, its environment; alone, the environment of the rest of the line
      line.envChanged = true;
      continue;
    }
    const prefix = head.literal ? PREFIXES[basename(head.text)] : undefined;
    if (prefix && basename(head.text) !== "xargs") {
      const rest = afterPrefix(basename(head.text), prefix, words.slice(1));
      if (rest === null) return;
      // `env` with any option or NAME=VALUE sets the command's environment
      if (basename(head.text) === "env" && rest.length < words.length - 1) line.envChanged = true;
      if (basename(head.text) === "env" && words.slice(1, words.length - rest.length).some((w) => CODE_VARS.has(w.text.split("=")[0]!))) line.codePath = true;
      // With no command after it, the prefix is the program that runs: a bare `env` prints the environment, and a rule
      // must see it (managed-v1, C8).
      if (rest.length === 0) break;
      words = rest;
      continue;
    }
    break;
  }
  const head = words[0]!;
  if (!head.literal || head.expanded) throw new Opaque(clip(`${text(words)} (an expansion as the command name)`));
  if (head.glob && head.text !== "[" && head.text !== "[[") throw new Opaque(clip(`${text(words)} (a glob or brace expansion as the command name)`));
  const name = basename(head.text);
  if (OPAQUE_HEAD.has(name)) throw new Opaque(clip(text(words)));
  if (ASSIGNING_BUILTINS.has(name) || (name === "printf" && words.slice(1).some((w) => /^-[A-Za-z]*v/.test(w.text)))) line.envChanged = true;
  laterMeaning(name, words, line);
  // `trap '<command>' SIG` runs a string later, as eval would; `trap - SIG`, `trap '' SIG`, `trap -l|-p` run nothing
  if (name === "trap" && words[1] && !["-", "", "-l", "-p", "--"].includes(words[1].text)) throw new Opaque(clip(`${text(words)} (trap runs a command string)`));
  if (name === "xargs") {
    // its command runs with arguments the matcher cannot know: the command itself is checked
    const rest = afterPrefix("xargs", PREFIXES.xargs!, words.slice(1));
    const from = out.length;
    if (rest && rest.length) simple(rest, depth, out, line, false);
    else out.push({ forms: ["echo"], argsUnknown: true }); // xargs's default command
    for (const c of out.slice(from)) c.argsUnknown = true;
    return;
  }
  if (SHELLS.has(name)) {
    if (heredoc) throw new Opaque(clip(`${text(words)} <<… (a here-doc into a shell)`));
    shell(name, words, depth, out, line);
    return;
  }
  const written = words.slice(1).map((w) => w.text);
  const args = name === "git" ? withoutGitGlobalOptions(written) : written;
  const kept = words.slice(1 + written.length - args.length);
  const single = (ws: string[]) => ws.join(" ").replace(/\s+/g, " ").trim();
  const form = single([name, ...args]);
  const asWritten = single([head.text, ...args]);
  const relative = head.text.includes("/") && !head.text.startsWith("/");
  // a stripped git global option is matched by a deny, but changes what the allowed form would run
  const gitOptions = args.length < written.length;
  const forms = asWritten === form ? [form] : [form, asWritten];
  const legacy = single([name, ...kept.map((w) => w.legacy)]);
  out.push({
    forms,
    ...(forms.includes(legacy) ? {} : { legacy: [legacy] }),
    ...(kept.some((w) => w.wild.includes(UNKNOWN)) ? { wild: wildForm(name, kept) } : {}),
    ...(relative ? { bestEffort: true } : {}),
    ...(gitOptions ? { envInjected: true } : {}),
  });
}

/** A command's `wild` form: a word that is wholly UNKNOWN joins its neighbour with no space of its own, so it may
 *  stand for no word, one or several (an unquoted expansion splits or vanishes). */
function wildForm(name: string, words: Word[]): string {
  let f = name;
  for (const w of words) f += w.wild === UNKNOWN ? UNKNOWN : ` ${w.wild.replace(/\s+/g, " ")}`;
  return f.replace(/ +/g, " ").trim();
}

/** For tests: the words of each simple command a line runs, as bash will pass them, a word whose value is known
 *  only at run time as UNKNOWN; null when the line is opaque. */
export function shellWords(command: string): string[][] | null {
  const words: string[][] = [];
  try {
    decompose(command, 0, [], { envChanged: false, writes: [], words });
    return words;
  } catch (e) {
    if (e instanceof Opaque) return null;
    throw e;
  }
}

/**
 * Review R2: what a command defines for the lines after it. Bash runs a script line by line, so an alias defined on
 * one line expands on the next (with `expand_aliases`, or in an interactive shell); `enable` and `hash -p` change
 * what a name runs; some `set` options change what a later word is. Each is opaque, as a function definition already
 * is: the matcher cannot see what a later word will mean. A variable that picks the code that runs (CODE_VARS) is
 * resolved instead: the line runs, but nothing of it is admitted as read-only.
 */
function laterMeaning(name: string, words: Word[], line: Line): void {
  const args = words.slice(1).map((w) => w.text);
  const opaque = (why: string): never => {
    throw new Opaque(clip(`${text(words)} (${why})`));
  };
  if (name === "alias" && args.some((a) => a.includes("="))) opaque("an alias definition: a later line runs what it names");
  if (name === "shopt" && args.includes("expand_aliases")) opaque("aliases expanded on later lines");
  if (name === "enable" && args.length) opaque("enable changes what a builtin's name runs");
  if (name === "hash" && args.some((a) => /^-[A-Za-z]*p/.test(a))) opaque("hash -p maps a name to a file");
  if (name === "set") {
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--" || a === "-") break;
      if (!a.startsWith("-") && !a.startsWith("+")) break; // positional words
      // a bundle with `o` takes the next word as an option name (`set -euo pipefail`)
      const flags = a.replace(/o/g, "");
      if (flags.length > 1 && !SAFE_SET_FLAGS.test(flags)) opaque(`set ${a} changes what later words mean`);
      if (a.includes("o")) {
        i++;
        if (!SAFE_SET_OPTIONS.has(args[i] ?? "")) opaque(`set -o ${args[i] ?? ""} changes what later words mean`);
      }
    }
  }
  if (ASSIGNING_BUILTINS.has(name) && args.some((a) => CODE_VARS.has(a.split("=")[0]!))) line.codePath = true;
}

/** git's global options before its subcommand: `git -C . push` is `git push`. */
function withoutGitGlobalOptions(args: string[]): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "--") i += GIT_OPTIONS_WITH_VALUE.has(args[i]!) ? 2 : 1;
  return args.slice(i);
}

/** `sh -c '<literal script>'` is decomposed; `sh script.sh` is checked as named (best-effort); anything else (a
 *  non-literal script, stdin) is opaque. A login or interactive shell, `zsh` without `-f` (it reads `~/.zshenv`
 *  whenever it starts) and `bash --debugger` read an rc file first: the line changes the environment. */
function shell(name: string, words: Word[], depth: number, out: DecomposedCommand[], line: Line): void {
  const args = words.slice(1);
  let command = false;
  // zsh's `-f` (NO_RCS) skips the user rc files; `+f` turns them back on, and the last one wins
  let noRcs = false;
  const runs = () => {
    if (name === "zsh" && !noRcs) line.envChanged = true;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const t = a.text;
    if (a.literal && t === "--") {
      // the end of the options: the script (with -c) or the script file follows
      const rest = args.slice(i + 1);
      if (command) {
        runs();
        return script(rest[0], words, depth, out, line);
      }
      if (!rest.length) break;
      runs();
      out.push({ forms: [[name, ...args.map((x) => x.text)].join(" ")], bestEffort: true });
      return;
    }
    if (a.literal && t.startsWith("--")) {
      if (SHELL_LONG_FLAGS.has(t)) {
        if (t === "--login" || t === "--debugger") line.envChanged = true;
        continue;
      }
      if (SHELL_LONG_WITH_VALUE.has(t)) {
        i++;
        continue;
      }
      throw new Opaque(clip(`${text(words)} (a shell option the matcher does not know)`));
    }
    if (a.literal && /^[-+][A-Za-z]+$/.test(t)) {
      if (t.includes("s")) break; // read the script from stdin
      if (t.includes("c")) command = true;
      if (/[li]/.test(t)) line.envChanged = true;
      if (t.includes("f")) noRcs = t.startsWith("-");
      if (/[oO]$/.test(t)) {
        // `-o pipefail`, `-O extglob`: the option's argument (zsh ignores case and underscores in it)
        i++;
        if (RC_SHELL_OPTIONS.has((args[i]?.text ?? "").replace(/_/g, "").toLowerCase())) line.envChanged = true;
      }
      continue;
    }
    runs();
    if (command) return script(a, words, depth, out, line);
    // a script file: checked as named, its contents not inspected
    out.push({ forms: [[name, ...args.map((x) => x.text)].join(" ")], bestEffort: true });
    return;
  }
  throw new Opaque(clip(`${text(words)} (a shell reading its script from stdin)`));
}

/** `-c`'s script: decomposed when it is literal, opaque otherwise. */
function script(w: Word | undefined, words: Word[], depth: number, out: DecomposedCommand[], line: Line): void {
  if (!w || !w.literal) throw new Opaque(clip(`${text(words)} (a shell with a non-literal script)`));
  decompose(w.text, depth + 1, out, line);
}
