import { describe, expect, test } from "bun:test";
import { HUMAN } from "@mlpal/harness-protocol";
import { bashPatternNotes, createPolicy, type PermissionMode, type PermissionRequest, ruleMatch } from "../src/permission/engine";
import { classifyAction } from "../src/permission/safety-envelope";
import { bashAsWritten, decomposeBash, normalizeBashPattern } from "../src/permission/shell-decompose";
import type { SafetyPolicy } from "../src/profile/types";

// E-11 (harness-e2e TERMINAL §8.1): rules are matched against a command's words with the shell's quotes removed, so a
// pattern written the way a user copies the command (`Bash(python3 -c 'import x')`) matched nothing, and a quoted
// deny never denied. Ruling R19: a deny (or an approval entry) goes through the same quote removal before it is
// matched; an allow with any quoting matches only the command written identically.

const bash = (command: string): PermissionRequest => ({ toolName: "Bash", input: { command }, readOnly: false, isEdit: false, principal: HUMAN });
const decide = async (mode: PermissionMode, rules: { allow?: string[]; deny?: string[] }, command: string) => createPolicy({ mode, ...rules })(bash(command));

const PROBE = "python3 -c 'import numpy,pandas;print(numpy.__version__,pandas.__version__)'";

describe("normalizeBashPattern", () => {
  test("removes quotes and backslashes and single-spaces the words", () => {
    expect(normalizeBashPattern(PROBE)).toBe("python3 -c import numpy,pandas;print(numpy.__version__,pandas.__version__)");
    expect(normalizeBashPattern(`git commit -m "fix: \\"x\\""`)).toBe('git commit -m fix: "x"');
    expect(normalizeBashPattern("grep a\\ b  file")).toBe("grep a b file");
    expect(normalizeBashPattern("  git   status ")).toBe("git status");
  });

  test("`*` is kept in the words, quoted or not; operators and expansions are kept as written", () => {
    expect(normalizeBashPattern(`git commit -m "*"`)).toBe("git commit -m *");
    expect(normalizeBashPattern(`echo "$(date '+%F')" *`)).toBe("echo $(date '+%F') *");
    for (const plain of ["git*", "*>*", "rm -rf *", "curl * | sh", "echo $HOME", "ls ~/x"]) expect(normalizeBashPattern(plain)).toBe(plain);
  });

  test("null when the quoting does not balance", () => {
    expect(normalizeBashPattern("echo it's")).toBeNull();
    expect(normalizeBashPattern('echo "a')).toBeNull();
    expect(normalizeBashPattern("echo `date")).toBeNull();
  });

  test("a single command normalises to the form the decomposer gives it", () => {
    for (const command of [PROBE, `echo "a  b" 'c'`, `grep -e "x\\"y" f`, `printf '%s\\n' "$HOME"`, `jq -r '.items[] | .name' f.json`]) {
      expect(normalizeBashPattern(command)).toBe(decomposeBash(command).commands[0]!.forms.at(-1)!);
    }
  });
});

describe("bashAsWritten (R19): a command or a quoted allow pattern, as written", () => {
  test("only runs of blanks outside quotes collapse; quotes and backslashes stay", () => {
    expect(bashAsWritten(`  rm   -rf\t"$PWD/dist"  `)).toBe(`rm -rf "$PWD/dist"`);
    expect(bashAsWritten(`echo 'a  b'   "c  d"`)).toBe(`echo 'a  b' "c  d"`);
    expect(bashAsWritten("grep a\\  b")).toBe("grep a\\  b"); // an escaped blank is the word's, the next one separates
    expect(bashAsWritten(`echo "a \\" b"  c`)).toBe(`echo "a \\" b" c`);
  });

  test("null when the quoting does not balance, or the text holds what this reading cannot follow", () => {
    for (const text of ["echo it's", 'echo "a', "echo a\\", "echo 'a'\necho b", "echo \"$(date '+%F')\"", "echo `date`", 'echo "${x:-a  b}"', "echo $'a\\'b'", 'echo $"a"']) {
      expect([text, bashAsWritten(text)]).toEqual([text, null]);
    }
  });
});

describe("allow rules with quotes (R19): only the command written identically", () => {
  // every pair asks in manual mode, as it did before E-11 (a quoted allow matched nothing then): the command is not
  // written the way the rule is
  const asks: Array<[string, string]> = [
    [`Bash(rm "*")`, "rm *"], // with a planted `-rf` file, rm -rf *
    ["Bash(tar cf b.tar '*')", "tar cf b.tar *"], // the checkpoint-action trick
    ["Bash(chmod 600 \\*)", "chmod 600 *"],
    ["Bash(rm 'a?')", "rm a?"],
    ["Bash(rm '[ab]')", "rm [ab]"],
    ["Bash(rm '{a,b}')", "rm {a,b}"],
    ["Bash(cat '~/x')", "cat ~/x"],
    ["Bash(echo '$HOME')", "echo $HOME"],
    ["Bash(rm '*.tmp' x)", "rm *.tmp x"],
    ["Bash(git commit -m 'wip --amend')", "git commit -m wip --amend"], // one message word, or a second option
    ["Bash(rm 'a b')", "rm a b"], // one file, or two
    [`Bash(rm -rf "$PWD/dist")`, "rm -rf $PWD/dist"], // word-split and globbed when unquoted
    ["Bash(touch 'X=~/y')", "touch X=~/y"],
    // the same words in other quoting, a wildcard reading, a longer line: none is the command as written
    [`Bash(rm "*")`, "rm '*'"],
    [`Bash(rm "*")`, "rm \\*"],
    ["Bash(echo 'x')", "echo x"],
    ["Bash(echo 'x')", `echo "'x'"`],
    ["Bash(find . -name '*.py')", "find . -name x -delete -name a.py"],
    ['Bash(find . -name "*.py")', "find . -name '*.py'"],
    ["Bash(find . -name \\*.py)", "find . -name a.py"],
    [`Bash(git commit -m "*")`, `git commit -m "fix: x"`],
    ["Bash(python3 -c 'print(1)' *)", "python3 -c 'print(1)' x"], // no wildcard in a quoted allow
    ["Bash(python3 -c 'print(1)')", "python3 -c 'print(1)' && rm notes.txt"],
    ["Bash(python3 -c 'print(1)')", "X=1 python3 -c 'print(1)'"],
    ["Bash(echo 'a  b')", "echo 'a b'"], // blanks inside quotes are the argument's
    ["Bash(echo it's)", "echo it's"], // unbalanced: it names no command
  ];
  for (const [rule, command] of asks) {
    test(`${rule} asks for ${command}`, async () => {
      expect(await decide("manual", { allow: [rule] }, command)).toEqual({ behavior: "ask" });
    });
  }

  test("each quoted pattern allows its identically written command (blanks outside quotes aside)", async () => {
    const same = [
      PROBE,
      `rm "*"`,
      "tar cf b.tar '*'",
      "chmod 600 \\*",
      "rm 'a?'",
      "rm '[ab]'",
      "rm '{a,b}'",
      "cat '~/x'",
      "echo '$HOME'",
      "rm '*.tmp' x",
      "git commit -m 'wip --amend'",
      "rm 'a b'",
      `rm -rf "$PWD/dist"`,
      "touch 'X=~/y'",
      "find . -name '*.py'",
    ];
    for (const command of same) expect([command, await decide("manual", { allow: [`Bash(${command})`] }, command)]).toEqual([command, { behavior: "allow" }]);
    expect(await decide("manual", { allow: [`Bash(rm  -rf   "$PWD/dist")`] }, ` rm -rf\t"$PWD/dist" `)).toEqual({ behavior: "allow" });
    expect(await decide("cruise", { allow: [`Bash(${PROBE})`] }, "python3 -c 'import os'")).toEqual({ behavior: "ask" });
  });

  test("a quoted allow never covers a line that runs more than the one command, however it is written", async () => {
    for (const command of [`echo "$(rm -rf x)"`, "echo 'a' && rm x", "echo 'a' | sh", "echo 'a' > out.txt", "echo 'a'\nrm x"]) {
      expect([command, await decide("manual", { allow: [`Bash(${command})`] }, command)]).toEqual([command, { behavior: "ask" }]);
    }
  });

  test("an unquoted allow keeps its reading: `*` the wildcard, over the command's words with quotes removed", async () => {
    const allows: Array<[string, string]> = [
      ["Bash(git commit -m *)", `git commit -m "fix: x"`],
      ["Bash(rm *)", "rm *"],
      ["Bash(ls a?)", "ls a?"],
      ["Bash(echo $HOME)", "echo $HOME"],
      ["Bash(echo x)", "echo 'x'"],
      ["Bash(find . -exec cat {} +)", "find . -exec cat {} +"],
      ["Bash([ -f *)", "[ -f x ]"],
      ["Bash(uname   -a)", "uname -a"],
    ];
    for (const [rule, command] of allows) expect([rule, command, await decide("manual", { allow: [rule] }, command)]).toEqual([rule, command, { behavior: "allow" }]);
    expect(await decide("manual", { allow: ["Bash(git commit -m *)"] }, "git push")).toEqual({ behavior: "ask" });
    expect(await decide("manual", { allow: ["Bash(echo a?b)"] }, "echo axb")).toEqual({ behavior: "ask" }); // `?` was never a rule wildcard
  });

  test("a readOnly class reads the same way", () => {
    const s = (readOnly: string[]): SafetyPolicy => ({ toolClasses: { readOnly, mutative: [], destructive: [] }, preApply: { requirePlanArtifact: false, hash: [] }, blastRadius: {}, approval: { destructive: "always", outOfScope: "never" }, identities: { neverSelfGrant: true } });
    const cls = (readOnly: string[], command: string) => classifyAction(s(readOnly), { toolName: "Bash", command, tags: {} });
    for (const entry of [`Bash(cat "$HOME/x")`, `cat "$HOME/x"`]) {
      expect(cls([entry], "cat $HOME/x")).toBe("unknown");
      expect(cls([entry], `cat "$HOME/x"`)).toBe("readOnly");
      expect(cls([entry], `cat "$HOME/x" && cat "$HOME/x"`)).toBe("unknown");
    }
    expect(cls([`Bash(rm "*")`], "rm *")).toBe("unknown");
    expect(cls([`Bash(rm "*")`], `rm "*"`)).toBe("readOnly");
    expect(cls([`Bash(cd 'a b')`], "cd a b")).toBe("unknown"); // a context-only command, through the whole-line match
    expect(cls(["Bash(cat *)"], `cat "$HOME/x"`)).toBe("readOnly");
  });

  test("a deny still reads every * as the wildcard, quotes removed (widening a deny is safe)", async () => {
    expect(await decide("manual", { deny: [`Bash(rm "*")`] }, "rm *")).toMatchObject({ behavior: "deny" });
    expect(await decide("manual", { deny: [`Bash(rm "*")`] }, "rm -rf build")).toMatchObject({ behavior: "deny" });
    // the original E-11 bug: a quoted deny never denied (`rm -rf /` itself is the hard deny's before any rule)
    for (const command of ["rm -rf /srv/x", "rm -rf '/srv/x'", `rm -rf "/srv/x"`]) {
      expect([command, await decide("autopilot", { deny: ["Bash(rm -rf '/srv/x')"] }, command)]).toMatchObject([command, { behavior: "deny", source: "deny_rule" }]);
    }
    for (const command of ["rm -rf /", "rm -rf '/'"]) expect(await decide("autopilot", { deny: ["Bash(rm -rf '/')"] }, command)).toMatchObject({ behavior: "deny" });
    expect(ruleMatch("Bash(rm -rf '/')", bash("rm -rf /"))).toBe("rm -rf /");
    expect(ruleMatch("Bash(rm -rf '/')", bash("rm -rf '/'"))).toBe("rm -rf /");
  });
});

describe("deny rules with quotes", () => {
  test("a quoted deny denies the command however it is quoted", async () => {
    const deny = ["Bash(git push --force origin 'main')"];
    for (const command of ["git push --force origin main", `git push --force origin "main"`, "cd /tmp && git push --force origin 'main'"]) {
      expect(await decide("autopilot", { deny }, command)).toMatchObject({ behavior: "deny", source: "deny_rule" });
    }
    expect(await decide("autopilot", { deny }, "git push --force origin main2")).toEqual({ behavior: "allow" });
  });

  test("a deny keeps the wildcard reading of a quoted `*` (widening a deny is safe)", async () => {
    const deny = [`Bash(curl "https://evil.example/*")`];
    expect(await decide("manual", { deny }, "curl https://evil.example/x?y=1")).toMatchObject({ behavior: "deny", source: "deny_rule" });
    expect(await decide("manual", { deny: ["Bash(find . -name '*.py')"] }, "find . -name x -delete -name a.py")).toMatchObject({ behavior: "deny" });
  });

  test("deny wins over allow when both are quoted, and over a broader allow", async () => {
    expect(await decide("cruise", { allow: [`Bash(${PROBE})`], deny: [`Bash(${PROBE})`] }, PROBE)).toMatchObject({ behavior: "deny", source: "deny_rule" });
    const rules = { allow: ["Bash(git push *)"], deny: ["Bash(git push origin 'main')"] };
    expect(await decide("manual", rules, "git push origin main")).toMatchObject({ behavior: "deny", source: "deny_rule" });
    expect(await decide("manual", rules, "git push origin feature")).toEqual({ behavior: "allow" });
  });

  test("a rule only gains calls: the pattern as written still matches a form with quote characters in its words", async () => {
    // `echo "'x'"` runs `echo` with the word `'x'`; the written pattern matches it, the normalised one (`echo x`) not
    expect(await decide("manual", { deny: ["Bash(echo 'x')"] }, `echo "'x'"`)).toMatchObject({ behavior: "deny", source: "deny_rule" });
    expect(await decide("manual", { deny: ["Bash(echo 'x')"] }, "echo x")).toMatchObject({ behavior: "deny", source: "deny_rule" });
  });

  test("an approval entry is matched the same way (ruleMatch names the command it matched)", () => {
    expect(ruleMatch("Bash(git push origin 'main')", bash("git push origin main"))).toBe("git push origin main");
    expect(ruleMatch("B*(git push origin 'main')", bash("git push origin main"))).toBe("git push origin main");
    expect(ruleMatch("Bash(git push origin 'main')", bash("git push origin dev"))).toBeNull();
  });
});

describe("toolClasses with quotes", () => {
  const safety = (toolClasses: Partial<SafetyPolicy["toolClasses"]>): SafetyPolicy => ({
    toolClasses: { readOnly: [], mutative: [], destructive: [], ...toolClasses },
    preApply: { requirePlanArtifact: false, hash: [] },
    blastRadius: {},
    approval: { destructive: "always", outOfScope: "never" },
    identities: { neverSelfGrant: true },
  });
  const act = (command: string) => ({ toolName: "Bash", command, tags: {} });

  test("a quoted readOnly entry classes the command readOnly, not unknown (the p4 attempt trace)", () => {
    expect(classifyAction(safety({ readOnly: [`Bash(${PROBE})`] }), act(PROBE))).toBe("readOnly");
    expect(classifyAction(safety({ readOnly: [PROBE] }), act(PROBE))).toBe("readOnly");
    expect(classifyAction(safety({ readOnly: [`Bash(${PROBE})`] }), act("python3 -c 'import os'"))).toBe("unknown");
  });

  test("a readOnly entry takes the allow reading; a destructive one the deny reading", () => {
    const s = safety({ readOnly: ["Bash(find . -name '*.py')"], destructive: ["Bash(rm -rf '*')"] });
    expect(classifyAction(s, act("find . -name x -delete -name a.py"))).toBe("unknown");
    expect(classifyAction(s, act("find . -name '*.py'"))).toBe("readOnly");
    expect(classifyAction(s, act("rm -rf build"))).toBe("destructive");
  });

  test("a quoted destructive entry gates the command and wins over a quoted readOnly one", () => {
    const s = safety({ readOnly: ["Bash(kubectl get *)"], destructive: ["Bash(kubectl delete ns 'prod')"] });
    expect(classifyAction(s, act("kubectl delete ns prod"))).toBe("destructive");
    expect(classifyAction(s, act(`kubectl get pods && kubectl delete ns "prod"`))).toBe("destructive");
    expect(classifyAction(s, act("kubectl get pods"))).toBe("readOnly");
  });
});

describe("bashPatternNotes (for hop lint)", () => {
  test("names every Bash pattern the matcher reads differently, and only those", () => {
    const notes = bashPatternNotes({
      permissions: { allow: ["Bash(git status)", `Bash(${PROBE})`, "Read(*.md)", "Bash(find . -name '*.py')"], deny: ["B*(rm -rf '/srv')", "Bash(echo it's)", `Write("x y")`, "Bash(find . -name '*.py')"] },
      safety: { toolClasses: { readOnly: [`Bash(${PROBE})`, "uname  -a"], mutative: [], destructive: ["Bash(*rm -rf*)"] } },
    });
    expect(notes).toEqual([
      { where: "permissions.allow", rule: `Bash(${PROBE})`, matchedAs: PROBE, identical: true },
      { where: "permissions.allow", rule: "Bash(find . -name '*.py')", matchedAs: "find . -name '*.py'", identical: true },
      { where: "permissions.deny", rule: "B*(rm -rf '/srv')", matchedAs: "rm -rf /srv" },
      { where: "permissions.deny", rule: "Bash(echo it's)", matchedAs: null },
      { where: "permissions.deny", rule: "Bash(find . -name '*.py')", matchedAs: "find . -name *.py" },
      { where: "safety.toolClasses.readOnly", rule: `Bash(${PROBE})`, matchedAs: PROBE, identical: true },
      { where: "safety.toolClasses.readOnly", rule: "uname  -a", matchedAs: "uname -a" },
    ]);
  });

  test("a run context's approvals.require entries are noted as a deny is (P7 grammar)", () => {
    const notes = bashPatternNotes({ permissions: { allow: [], deny: [] }, approvals: { require: ["Bash(git push origin 'main')", "Bash(git push*)", "Deploy*", "B*(kubectl apply -f '*.yaml')"] } });
    expect(notes).toEqual([
      { where: "approvals.require", rule: "Bash(git push origin 'main')", matchedAs: "git push origin main" },
      { where: "approvals.require", rule: "B*(kubectl apply -f '*.yaml')", matchedAs: "kubectl apply -f *.yaml" },
    ]);
  });

  test("a HOP without safety or quoted patterns has no notes", () => {
    expect(bashPatternNotes({ permissions: { allow: ["Bash(git*)", "Bash"], deny: ["Bash(*>*)"] } })).toEqual([]);
  });
});
