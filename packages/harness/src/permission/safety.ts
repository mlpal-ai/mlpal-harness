/**
 * Deterministic safety authority — the *deny* backstop that no mode, allow-rule, or model
 * decision can override. Two layers:
 *   1. A catastrophic-command denylist (rm -rf /, mkfs, dd to a raw device, fork bombs…).
 *   2. Content-safety write blocks (git internals, private keys / cloud credentials).
 * Plus a shell-aware splitter so `git status && rm -rf /` is inspected per sub-command
 * rather than matched as one opaque string. This is where yodex is deterministically safer
 * than an LLM-classifier boundary: allow is earned; deny here is absolute.
 */

/**
 * Split a shell command into its constituent simple-commands across operators and
 * substitutions (`&&`, `||`, `;`, `|`, newlines, `$( … )`, backticks). Not a full parser —
 * a robust approximation that surfaces the pieces a denylist must see. Quotes are respected
 * so `echo "a; b"` is not split on the quoted `;`.
 */
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
    // operators that separate commands
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
      push();
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") {
      push();
      continue;
    }
    // command substitution: recurse into `$( … )` and backticks
    if (c === "$" && next === "(") {
      const end = command.indexOf(")", i + 2);
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

/** True only for rm -rf whose TARGET is a root/home (not a project subdir). */
function isRootRm(cmd: string): boolean {
  if (!/\brm\b/i.test(cmd) || !/-[a-z]*r/i.test(cmd) || !/-[a-z]*f/i.test(cmd)) return false;
  // strip flags, look at the operands
  const operands = cmd
    .replace(/\brm\b/i, "")
    .split(/\s+/)
    .filter((t) => t && !t.startsWith("-"));
  return operands.some((t) =>
    /^\/$|^\/\*$|^~$|^~\/?\*?$|^\$HOME\/?\*?$|^\/(bin|etc|usr|var|lib|boot|dev|sys|home|root|System|Library)(\/|$|\*)/.test(
      t,
    ),
  );
}

/** Returns a deny reason if the command is catastrophic, else null.
 *  - The rm rule is OPERAND-based, so it runs per sub-command only (checking the whole
 *    chain would false-positive on a `/` operand belonging to a different command).
 *  - The regex rules are self-anchored (mkfs/dd/fork-bomb/chmod), so they run against the
 *    whole command AND each sub-command — catching a fork bomb (spans operators) and a
 *    destructive command hidden in a `&&`/`;` chain alike. */
export function catastrophicDeny(command: string): string | null {
  const subs = splitShellCommands(command);
  for (const sub of subs) {
    if (isRootRm(sub)) return "blocked: recursive-force rm targeting a system/home root";
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
