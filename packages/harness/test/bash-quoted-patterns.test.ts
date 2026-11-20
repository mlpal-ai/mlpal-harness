import { describe, expect, test } from "bun:test";
import { HUMAN } from "@mlpal/harness-protocol";
import { bashPatternNotes, createPolicy, type PermissionMode, type PermissionRequest, ruleMatch } from "../src/permission/engine";
import { classifyAction } from "../src/permission/safety-envelope";
import { decomposeBash, normalizeBashPattern, readBashPattern } from "../src/permission/shell-decompose";
import type { SafetyPolicy } from "../src/profile/types";

// E-11 (harness-e2e TERMINAL §8.1): rules are matched against a command's words with the shell's quotes removed, so a
// pattern written the way a user copies the command (`Bash(python3 -c 'import x')`) matched nothing, and a quoted
// deny never denied. The pattern goes through the same quote removal before it is matched.

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

  test("the allow reading: only a bare `*` is a wildcard", () => {
    const allow = (p: string) => readBashPattern(p)!.allow;
    expect(allow("find . -name '*.py'").test("find . -name *.py")).toBe(true);
    expect(allow("find . -name '*.py'").test("find . -name x -delete -name a.py")).toBe(false);
    expect(allow("find . -name \\*.py").test("find . -name a.py")).toBe(false);
    expect(allow("echo $(ls *)").test("echo $(ls x)")).toBe(false);
    expect(allow("git log *").test("git log --oneline -3")).toBe(true);
    expect(allow("echo a?b").test("echo axb")).toBe(false); // `?` was never a wildcard in a rule
    expect([readBashPattern("find . -name '*.py'")!.quotedStar, readBashPattern("git log *")!.quotedStar]).toEqual([true, false]);
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

describe("allow rules with quotes", () => {
  test("the quoted command a user copied into the rule is allowed (cruise asked before)", async () => {
    expect(await decide("cruise", { allow: [`Bash(${PROBE})`] }, PROBE)).toEqual({ behavior: "allow" });
    expect(await decide("cruise", { allow: [`Bash(${PROBE})`] }, "python3 -c 'import os'")).toEqual({ behavior: "ask" });
  });

  test("ruling (security-first): a `*` an allow quotes or escapes is literal; only a bare `*` is the wildcard", async () => {
    // the reviewer's case: the quoted glob is find's own argument, never the rule's wildcard
    for (const rule of ["Bash(find . -name '*.py')", 'Bash(find . -name "*.py")', "Bash(find . -name \\*.py)"]) {
      expect(await decide("manual", { allow: [rule] }, "find . -name x -delete -name a.py")).toEqual({ behavior: "ask" });
      expect(await decide("manual", { allow: [rule] }, "find . -name '*.py'")).toEqual({ behavior: "allow" });
    }
    expect(await decide("manual", { allow: [`Bash(git commit -m "*")`] }, `git commit -m "fix: x"`)).toEqual({ behavior: "ask" });
    expect(await decide("manual", { allow: ["Bash(git commit -m *)"] }, `git commit -m "fix: x"`)).toEqual({ behavior: "allow" });
    expect(await decide("manual", { allow: ["Bash(git commit -m *)"] }, "git push")).toEqual({ behavior: "ask" });
  });

  test("an allow is matched as shell words only, never also as written", async () => {
    // `echo "'x'"` runs echo with the word `'x'`; the written pattern would match that form, the allow reading does not
    expect(await decide("manual", { allow: ["Bash(echo 'x')"] }, `echo "'x'"`)).toEqual({ behavior: "ask" });
    expect(await decide("manual", { allow: ["Bash(echo 'x')"] }, "echo x")).toEqual({ behavior: "allow" });
  });

  test("normalising never loosens the refusals: a chain still needs every command to match", async () => {
    const allow = [`Bash(python3 -c 'print(1)')`];
    expect(await decide("manual", { allow }, "python3 -c 'print(1)' && rm notes.txt")).toEqual({ behavior: "ask" });
    expect(await decide("manual", { allow }, "X=1 python3 -c 'print(1)'")).toEqual({ behavior: "ask" });
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
      { where: "permissions.allow", rule: `Bash(${PROBE})`, matchedAs: "python3 -c import numpy,pandas;print(numpy.__version__,pandas.__version__)" },
      { where: "permissions.allow", rule: "Bash(find . -name '*.py')", matchedAs: "find . -name *.py", literalStar: true },
      { where: "permissions.deny", rule: "B*(rm -rf '/srv')", matchedAs: "rm -rf /srv" },
      { where: "permissions.deny", rule: "Bash(echo it's)", matchedAs: null },
      { where: "permissions.deny", rule: "Bash(find . -name '*.py')", matchedAs: "find . -name *.py" },
      { where: "safety.toolClasses.readOnly", rule: `Bash(${PROBE})`, matchedAs: "python3 -c import numpy,pandas;print(numpy.__version__,pandas.__version__)" },
      { where: "safety.toolClasses.readOnly", rule: "uname  -a", matchedAs: "uname -a" },
    ]);
  });

  test("a HOP without safety or quoted patterns has no notes", () => {
    expect(bashPatternNotes({ permissions: { allow: ["Bash(git*)", "Bash"], deny: ["Bash(*>*)"] } })).toEqual([]);
  });
});
