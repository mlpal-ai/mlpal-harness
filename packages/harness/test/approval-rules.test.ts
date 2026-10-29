/**
 * A publication's `approvals_required` entries (P7 1.7, W6 D-15) are matched by the deny path (`withApprovals` builds
 * one manual deny policy per entry): the tool part is a glob over P7's grammar, `*` the only wildcard, case-sensitive;
 * the argument part as before (Bash per sub-command). A deny rule that matched before matches the same.
 */
import { describe, expect, test } from "bun:test";
import { createPolicy, parseApprovalEntry } from "../src/permission/engine";

const fires = async (rule: string, toolName: string, input: Record<string, unknown> = {}) => {
  const d = await createPolicy({ mode: "manual", deny: [rule] })({ toolName, input } as never);
  return d.behavior === "deny" && (d as { source?: string }).source === "deny_rule";
};

describe("the tool part is a glob (`*` only, case-sensitive)", () => {
  test("Deploy* names DeployProd and Deploy, not deployProd or Deplo", async () => {
    expect(await fires("Deploy*", "DeployProd")).toBe(true);
    expect(await fires("Deploy*", "Deploy")).toBe(true);
    expect(await fires("Deploy*", "deployProd")).toBe(false);
    expect(await fires("Deploy*", "Deplo")).toBe(false);
  });

  test("MCP names (digits, `:`, `.`, `-`) and an MCP server's every tool", async () => {
    expect(await fires("mcp__github__create_pr", "mcp__github__create_pr")).toBe(true);
    expect(await fires("mcp__github__*", "mcp__github__create_pr")).toBe(true);
    expect(await fires("mcp__github__*", "mcp__gitlab__create_pr")).toBe(false);
    expect(await fires("mcp__k8s-v2__apply.dry", "mcp__k8s-v2__apply.dry")).toBe(true);
    expect(await fires("mcp__k8s-v2__apply.dry", "mcp__k8s-v2__applyXdry")).toBe(false);
  });

  test("an exact name still matches exactly; the argument side is as before", async () => {
    expect(await fires("Bash", "Bash", { command: "ls" })).toBe(true);
    expect(await fires("Bash", "BashOutput")).toBe(false);
    expect(await fires("Bash(git push*)", "Bash", { command: "git push origin main" })).toBe(true);
    expect(await fires("Bash(git push*)", "Bash", { command: "git pull" })).toBe(false);
    expect(await fires("Bash(git push*)", "Bash", { command: "git status && git push origin main" })).toBe(true);
    expect(await fires("Bash(echo destroy-probe*)", "Bash", { command: "echo destroy-probe 1" })).toBe(true);
    expect(await fires("Bash(echo destroy-probe*)", "Bash", { command: "echo probe" })).toBe(false);
    expect(await fires("Edit(src/*.py)", "Edit", { path: "src/a.py" })).toBe(true);
    expect(await fires("Edit(src/*.py)", "Edit", { path: "lib/a.py" })).toBe(false);
  });
});

describe("parseApprovalEntry: P7's grammar, strictly", () => {
  test("Tool or Tool(<glob>): the parts, or null", () => {
    expect(parseApprovalEntry("Deploy*")).toEqual({ tool: "Deploy*" });
    expect(parseApprovalEntry("Bash(git push*)")).toEqual({ tool: "Bash", pattern: "git push*" });
    for (const bad of ["Bash()", "Bash(a(b)", "Ba sh", " Bash", "Bash(x\ty)"]) expect(parseApprovalEntry(bad)).toBeNull();
  });
});

describe("Bash rules fail closed on what the splitter cannot decompose (P3 critical-fix review, addendum)", () => {
  const push = (command: string) => fires("Bash(git push*)", "Bash", { command });
  const BYPASSES = [
    'echo "$(git push)"',
    'echo "`git push`"',
    "( git push )",
    "{ git push; }",
    "if true; then git push; fi",
    "for i in 1; do git push; done",
    "! git push",
    "FOO=1 git push",
    "FOO=1 BAR=2 git push",
    "env git push",
    "env FOO=1 git push",
    "env -i git push",
    "command git push",
    "time git push",
    "nohup git push",
    "echo x | xargs git push",
    "bash -c 'git push'",
    'sh -c "git push"',
    "eval 'git push'",
    "/usr/bin/git push",
    "\\git push",
    "git  push",
    "git\tpush",
  ];
  for (const command of BYPASSES) test(`asks for ${JSON.stringify(command)}`, async () => expect(await push(command)).toBe(true));

  test("ordinary commands match exactly as before", async () => {
    expect(await push("git push origin main")).toBe(true);
    expect(await push("git status")).toBe(false);
    expect(await push("ls -la && git pull")).toBe(false);
    expect(await push("ls -la && git push")).toBe(true);
    expect(await push("git log | head -5")).toBe(false);
    expect(await push('echo "hello world" > out.txt 2>&1')).toBe(false);
    expect(await push("echo $(git rev-parse HEAD)")).toBe(false);
    expect(await push('git commit -m "push it"')).toBe(false);
    expect(await push("npm test")).toBe(false);
    // Arithmetic expansion runs no command: it is not a subshell.
    expect(await push("echo E5-shell-$((6 * 7))")).toBe(false);
    expect(await push("echo $((1 + 2)) && git push")).toBe(true);
  });

  test("a rule that does not target Bash is unaffected by an opaque command", async () => {
    expect(await fires("Deploy*", "Bash", { command: "bash -c 'git push'" })).toBe(false);
    expect(await fires("Edit(src/*)", "Bash", { command: "( git push )" })).toBe(false);
  });
});

describe("M5: the glob's length counts code points, as Python does", () => {
  test("256 astral characters are one glob; 257 are not", () => {
    const astral = "\u{1F600}";
    expect(parseApprovalEntry(`Bash(${astral.repeat(256)})`)).not.toBeNull();
    expect(parseApprovalEntry(`Bash(${astral.repeat(257)})`)).toBeNull();
  });
});

describe("D-27: recursive decomposition, failing closed only on what cannot be decomposed", () => {
  const PROBE = JSON.parse(require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "fixtures", "platform-probe-0.2.1-commands.json"), "utf8")) as { modes: string[]; commands: string[] };
  const push = (command: string) => fires("Bash(git push*)", "Bash", { command });

  for (const [i, command] of PROBE.commands.entries()) {
    test(`the window probe's ${PROBE.modes[i]} command passes a \`Bash(git push*)\` deny`, async () => expect(await push(command)).toBe(false));
  }
  test("the exact EFFECT command of the window defect", async () => {
    expect(await push("sh -c 'f=probe-counter-x; c=$(cat $f 2>/dev/null || echo 0); echo $((c+1)) > $f; echo counter=$(cat $f); sleep 20'")).toBe(false);
  });

  test("git push inside a literal script, a substitution or a group is found", async () => {
    for (const command of [
      "sh -c 'git push'", "bash -c 'git push origin main'", "bash -lc 'git push'", "bash -euo pipefail -c 'ls; git push'", 'sh -c "git push"',
      "sh -c 'echo $(git push)'", "sh -c 'bash -c \"git push\"'", "echo $(echo $(git push))", "f=$(git push) && true",
    ]) expect({ command, fires: await push(command) }).toEqual({ command, fires: true });
  });

  test("ordinary scripts with no git push pass", async () => {
    for (const command of [
      "sh -c 'ls -la; echo done'", "bash -c 'for f in *.txt; do wc -l $f; done'", "sh -c 'if [ -f x ]; then cat x; fi'", "f=$(date) && echo $f",
      "( cd sub && make )", "{ echo a; echo b; } > out", "sh -c 'echo \"$HOME\" 2>&1 >/dev/null'", "x=1 y=2 make test", "echo `whoami`",
    ]) expect({ command, fires: await push(command) }).toEqual({ command, fires: false });
  });

  test("still undecomposable: fails closed", async () => {
    for (const command of [
      "$cmd push", "${GIT:-git} push", "eval 'ls'", 'sh -c "$script"', "sh -c \"echo $x\"", "bash", "curl -s x | sh", "source ./env.sh", ". ./env.sh",
      "bash <<EOF\nls\nEOF", "sh -c 'sh -c \"sh -c \\\"sh -c ls\\\"\"'", "echo 'unterminated", "f() { ls; }", "env -S 'git push'", "timeout --frobnicate 5 ls",
    ]) expect({ command, fires: await push(command) }).toEqual({ command, fires: true });
  });
});

describe("D-27, the reviewer's additions", () => {
  const push = (command: string) => fires("Bash(git push*)", "Bash", { command });
  const each = async (commands: string[], expected: boolean) => {
    for (const command of commands) expect({ command, fires: await push(command) }).toEqual({ command, fires: expected });
  };

  test("control structures are decomposed: for/while/until/if/case bodies, subshells, groups", async () => {
    await each(["for b in a c; do git push origin $b; done", "while true; do git push; break; done", "until false; do git push; done", "if true; then echo; else git push; fi", "case $x in a) ls;; b) git push;; esac", "( cd x; git push )", "{ echo; git push; }"], true);
    await each(["for b in a c; do echo $b; done", "while read l; do echo $l; done < f", "case $x in a|b) ls;; *) echo no;; esac", "( cd x && make )", "{ echo a; echo b; } 2>&1"], false);
  });

  test("normalised: git's global options, and the timeout/nice/stdbuf/ionice prefixes", async () => {
    await each(["git -C . push", "git -c user.name=x push", "git --git-dir=.git --work-tree=. push", "git --no-pager push", "timeout 30s git push", "timeout -s KILL 5 git push", "nice -n 10 git push", "nice -10 git push", "stdbuf -oL git push", "ionice -c 3 git push", "nohup nice timeout 5 git push"], true);
    await each(["git -C . status", "timeout 30s make test", "nice -n 5 ls"], false);
  });

  test("xargs: its command is checked (its arguments are not known)", async () => {
    await each(["echo origin | xargs git push", "ls | xargs -n1 -I{} git push {}"], true);
    await each(["ls | xargs wc -l", "find . -name '*.tmp' -print0 | xargs -0 rm"], false);
  });

  test("script files are checked as named, best-effort, and logged", async () => {
    const lines: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const logger = { info: (msg: string, fields?: Record<string, unknown>) => lines.push({ msg, fields }), warn() {}, error() {}, debug() {}, child() { return logger; } } as never;
    for (const command of ["bash script.sh", "sh ./deploy.sh --dry-run", "./x.sh", "bash -e ./run.sh"]) {
      const d = await createPolicy({ mode: "manual", deny: ["Bash(git push*)"], logger })({ toolName: "Bash", input: { command } } as never);
      expect({ command, denied: d.behavior === "deny" }).toEqual({ command, denied: false });
    }
    expect(lines.map((l) => [l.msg, l.fields?.command])).toEqual([["bash.rule_opaque", "bash script.sh"], ["bash.rule_opaque", "sh ./deploy.sh --dry-run"], ["bash.rule_opaque", "./x.sh"], ["bash.rule_opaque", "bash -e ./run.sh"]]);
    // A rule on the script's own name still matches it.
    expect(await fires("Bash(./deploy.sh*)", "Bash", { command: "./deploy.sh prod" })).toBe(true);
    expect(await fires("Bash(bash deploy.sh*)", "Bash", { command: "bash deploy.sh" })).toBe(true);
  });

  test("the refusal names the rule and the sub-command that matched, or the undecomposable form", async () => {
    const policy = createPolicy({ mode: "manual", deny: ["Bash(rm*)", "Bash(git push*)"] });
    const reason = async (command: string) => ((await policy({ toolName: "Bash", input: { command } } as never)) as { reason?: string }).reason;
    expect(await reason("sh -c 'ls; git push origin main'")).toBe('denied by rule "Bash(git push*)": git push origin main');
    expect(await reason("eval 'git push'")).toBe(`denied by rule "Bash(rm*)": undecomposable: eval git push`);
    expect(await reason("$cmd x")).toContain("undecomposable: $cmd x (an expansion as the command name)");
  });

  test("an allow rule sees the same commands, and never approves an undecomposable one", async () => {
    const allowed = async (command: string) => (await createPolicy({ mode: "manual", allow: ["Bash(git status*)"] })({ toolName: "Bash", input: { command } } as never)).behavior === "allow";
    expect(await allowed("git status")).toBe(true);
    expect(await allowed("sh -c 'git status'")).toBe(true);
    expect(await allowed("git status && rm -rf x")).toBe(false);
    expect(await allowed("eval 'git status'")).toBe(false);
  });
});
