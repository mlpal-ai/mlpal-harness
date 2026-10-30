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
 *   are tried); `$((…))` (arithmetic, no command; kept as written); redirections and their targets; here-doc bodies (data);
 * - best-effort (checked as the command named, contents not inspected; `bestEffort`): a shell running a script file
 *   (`bash script.sh`), a command run by a relative path (`./x.sh`);
 * - opaque (`opaque` names the form; a rule on Bash fails closed): an expansion as the command name, `eval`, `source`/
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
}

export interface Decomposed {
  commands: DecomposedCommand[];
  /** The form that could not be decomposed, or null: a rule on Bash must treat the command as matching. */
  opaque: string | null;
}

const MAX_DEPTH = 3;
const OPAQUE_HEAD = new Set(["eval", "source", ".", "exec", "sudo", "doas", "su", "busybox", "parallel"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh"]);
/** Words that open or close shell syntax around the commands of a compound; the command after them is checked. */
const COMPOUND = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}"]);
const UNSUPPORTED = new Set(["select", "function", "coproc"]);
/** Builtins that assign a variable, an alias or a command's path for the rest of the line. */
const ASSIGNING_BUILTINS = new Set(["export", "declare", "typeset", "local", "readonly", "unset", "read", "mapfile", "readarray", "let", "getopts", "alias", "unalias", "hash", "enable"]);
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
}

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
  /** The word as the command receives it: quotes removed, substitutions kept as written. */
  text: string;
  /** Parameter expansion or substitution somewhere in it (unquoted or double-quoted). */
  expanded: boolean;
  /** Entirely literal: its text is exactly what runs. */
  literal: boolean;
  /** An unquoted glob or brace character (`*?[{}`): as a command name, bash would expand it. */
  glob?: boolean;
}

class Opaque extends Error {
  constructor(readonly form: string) {
    super(form);
  }
}
const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);

export function decomposeBash(command: string): Decomposed {
  const commands: DecomposedCommand[] = [];
  const line: Line = { envChanged: false };
  try {
    decompose(command, 0, commands, line);
    if (line.envChanged) for (const c of commands) c.envInjected = true;
    return { commands, opaque: null };
  } catch (e) {
    if (e instanceof Opaque) return { commands: [], opaque: e.form };
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
  const endWord = () => {
    if (word) {
      if (skipNext) skipNext = false;
      else words.push(word);
    }
    word = null;
    if (words.length === 3 && words[0]!.literal && words[0]!.text === "case" && words[2]!.literal && words[2]!.text === "in") {
      words = [];
      cases.push("pattern");
    }
  };
  const cur = (): Word => (word ??= { text: "", expanded: false, literal: true });
  const endCommand = () => {
    endWord();
    if (skipNext) throw new Opaque("a redirection with no target");
    simple(words, depth, out, line, heredoc);
    words = [];
    heredoc = false;
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
        cases.pop();
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
      cases.pop();
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
        cur().text += "/dev/fd/0";
        i = end;
        continue;
      }
      const w = word as Word | null;
      if (w && /^[0-9]+$/.test(w.text) && w.literal) word = null;
      else endWord();
      if (c === "<" && next === "<" && command[i + 2] !== "<") {
        // a here-doc: its delimiter, then its body after the line
        let j = i + 2;
        const strip = command[j] === "-";
        if (strip) j++;
        while (command[j] === " " || command[j] === "\t") j++;
        const m = /^(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()]+))/.exec(command.slice(j));
        if (!m) throw new Opaque("a here-doc with no delimiter");
        // a quoted delimiter (`'EOF'`, `"EOF"`, `\EOF`) keeps the body as data; an unquoted one expands it
        pendingHeredocs.push({ delimiter: m[1] ?? m[2] ?? m[3]!, strip, quoted: m[1] !== undefined || m[2] !== undefined || m[0].startsWith("\\") });
        heredoc = true;
        i = j + m[0].length - 1;
        continue;
      }
      // The operator (`>`, `>>`, `<`, `&>`, `>|`, `<<<`, `>&`), then an fd it duplicates (`>&2`, `2>&1`, `<&-`) or a
      // target word, which is not an argument.
      let j = i;
      while (j + 1 < command.length && "<>&|".includes(command[j + 1]!)) j++;
      if (command[j] === "&" && j > i && /[0-9-]/.test(command[j + 1] ?? "")) {
        while (j + 1 < command.length && /[0-9-]/.test(command[j + 1]!)) j++;
      } else skipNext = true;
      i = j;
      continue;
    }
    if (c === "(") {
      if (word !== null || words.length > 0) throw new Opaque(clip(`${words.map((x) => x.text).join(" ")} ${(word as Word | null)?.text ?? ""}(`.trim()) + " (a function definition)");
      const end = close(i);
      inner(command.slice(i + 1, end)); // a subshell
      i = end;
      continue;
    }
    if (c === ")") throw new Opaque("unbalanced parentheses");
    if (c === "\\") {
      if (next === "\n") {
        i++;
        continue;
      }
      if (next !== undefined) cur().text += next;
      i++;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Opaque("unbalanced quotes");
      cur().text += command.slice(i + 1, end);
      i = end;
      continue;
    }
    if (c === '"') {
      const w = cur();
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!;
        if (d === "\\" && j + 1 < command.length) {
          w.text += command[j + 1];
          j++;
        } else if (d === "$" || d === "`") j = expansion(command, j, w, inner, close, line);
        else w.text += d;
      }
      if (j >= command.length) throw new Opaque("unbalanced quotes");
      i = j;
      continue;
    }
    if (c === "$" || c === "`") {
      i = expansion(command, i, cur(), inner, close, line);
      continue;
    }
    const w = cur();
    w.text += c;
    if ("*?[{}".includes(c)) w.glob = true;
  }
  endCommand();
  if (pendingHeredocs.length) throw new Opaque("an unterminated here-doc");
  if (cases.length) throw new Opaque("an unterminated case");
}

/** An expansion at `i` (`$((…))`, `$(…)`, backticks, `$name`, `${…}`): substitutions decomposed, the word marked.
 *  Answers the index of its last character. */
function expansion(s: string, i: number, w: Word, inner: (cmd: string) => void, close: (open: number) => number, line: Line): number {
  if (s[i] === "`") {
    const end = s.indexOf("`", i + 1);
    if (end < 0) throw new Opaque("unbalanced backticks");
    inner(s.slice(i + 1, end));
    w.text += s.slice(i, end + 1);
    w.expanded = true;
    w.literal = false;
    return end;
  }
  const next = s[i + 1];
  if (next === "'" || next === '"') {
    // ANSI-C (`$'…'`) or locale (`$"…"`) quoting: what it yields is not what is written
    w.text += "$";
    w.expanded = true;
    w.literal = false;
    return i;
  }
  if (next === "(" && s[i + 2] === "(") {
    // arithmetic: no command runs itself, but substitutions inside it do (kept as written, so a refusal shows it)
    const end = close(i + 1);
    arithmetic(s.slice(i + 3, end - 1), inner, line, true);
    w.text += s.slice(i, end + 1);
    w.expanded = true;
    w.literal = false;
    return end;
  }
  if (next === "(") {
    const end = close(i + 1);
    inner(s.slice(i + 2, end));
    w.text += s.slice(i, end + 1);
    w.expanded = true;
    w.literal = false;
    return end;
  }
  if (next === "{") {
    // a parameter expansion: its operators (`${x:-…}`, `${x/…/…}`) may hold substitutions, which run
    const end = matchBrace(s, i + 1);
    if (end < 0) throw new Opaque("an unterminated ${…}");
    parameter(s.slice(i + 2, end), inner, line, true);
    w.text += s.slice(i, end + 1);
    w.expanded = true;
    w.literal = false;
    return end;
  }
  const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?$!#*@-])/.exec(s.slice(i));
  if (!m) {
    w.text += "$";
    return i;
  }
  w.text += m[0];
  w.expanded = true;
  w.literal = false;
  return i + m[0].length - 1;
}

/** A `$((…))` body: its substitutions decomposed, an assignment in it recorded. */
function arithmetic(body: string, inner: (cmd: string) => void, line: Line, quotes: boolean): void {
  if (ARITHMETIC_ASSIGNMENT.test(body)) line.envChanged = true;
  substitutions(body, inner, line, quotes);
}

/** A `${…}` body: its substitutions decomposed, an assigning form recorded. */
function parameter(body: string, inner: (cmd: string) => void, line: Line, quotes: boolean): void {
  if (PARAMETER_ASSIGNMENT.test(body)) line.envChanged = true;
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

/** One simple command: syntax, assignments and prefixes stripped, a shell's literal script decomposed, the rest
 *  recorded for the rules. */
function simple(input: Word[], depth: number, out: DecomposedCommand[], line: Line, heredoc: boolean): void {
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
      return;
    }
    if (head.literal && (UNSUPPORTED.has(head.text) || head.text === "case" || head.text === "esac")) throw new Opaque(clip(text(words)));
    if (ASSIGNMENT.test(head.text) && !head.text.slice(0, head.text.indexOf("=")).includes("$")) {
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
  const form = [name, ...args].join(" ").replace(/\s+/g, " ").trim();
  const asWritten = [head.text, ...args].join(" ").replace(/\s+/g, " ").trim();
  const relative = head.text.includes("/") && !head.text.startsWith("/");
  // a stripped git global option is matched by a deny, but changes what the allowed form would run
  const gitOptions = args.length < written.length;
  out.push({ forms: asWritten === form ? [form] : [form, asWritten], ...(relative ? { bestEffort: true } : {}), ...(gitOptions ? { envInjected: true } : {}) });
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
