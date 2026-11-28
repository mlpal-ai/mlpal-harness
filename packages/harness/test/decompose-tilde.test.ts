import { describe, expect, test } from "bun:test";
import { createPolicy } from "../src/permission/engine";
import { decomposeBash, UNKNOWN } from "../src/permission/shell-decompose";

/**
 * A leading `~` that bash expands to the command's own $HOME (bare, or before an unquoted `/`) is read as written,
 * as production's engine read it, unless something on the line could change HOME first. Every other tilde form
 * stays a run-time value. Checked against bash 3.2.57 and 5.2.21 by generation (p1/decompose/tilde/).
 */
const runtime = (line: string) => {
  const d = decomposeBash(line);
  return d.opaque !== null || d.commands.some((c) => (c.wild ?? "").includes(UNKNOWN));
};

describe("a leading ~ that bash expands to $HOME is read as written", () => {
  test("~, ~/ and ~/path, also with a quoted rest, are fixed", () => {
    for (const w of ["~", "~/", "~/x", "~/.yodex/hops/h/1.0.0/scripts/run_cases.py", "~/'x y'", '~/"x y"', "~/~"]) expect([w, runtime(`cp ${w} dest`)]).toEqual([w, false]);
  });

  test("other users' homes, the directory stack, a quoted slash after ~, globs and expansions stay run-time values", () => {
    for (const w of ["~root", "~root/x", "~nobody/x", "~+", "~+/x", "~-", "~-/x", "~0", "~~/x", "~'/x'", '~"/x"', "~/*.py", "~/{a,b}", "~/$HOME"]) expect([w, runtime(`cp ${w} dest`)]).toEqual([w, true]);
  });

  test("a tilde bash does not expand is literal, as before", () => {
    for (const w of ['"~"/x', "'~'/x", "\\~/x", "a~/b", "x~", "--prefix=~/p", "a:~/b"]) expect([w, runtime(`cp ${w} dest`)]).toEqual([w, false]);
  });

  test("anything that could change HOME before the word keeps it a run-time value", () => {
    for (const line of [
      "HOME=/tmp/x cp ~/a b",
      "X=1 cp ~/a b",
      "export HOME=/tmp/x; cp ~/a b",
      "HOME=/tmp/x; cp ~/a b",
      "read HOME; cp ~/a b",
      "for HOME in /a; do cp ~/x b; done",
      "env cp ~/a b",
      "env HOME=/x cp ~/a b",
      "sudo -u bob cp ~/a b",
      "su bob -c 'cp ~/a b'",
      "doas cp ~/a b",
      ": ${HOME:=/tmp}; cp ~/a b",
    ])
      expect([line, runtime(line)]).toEqual([line, true]);
    // a change after the word does not reach it
    expect(runtime("cp ~/a b; export HOME=/tmp")).toBe(false);
  });
});

describe("the policy: the friction goes, the protections stay", () => {
  test("a literal ~/ copy under an allow rule runs as on production's engine; with HOME changed first it asks", async () => {
    const policy = createPolicy({ mode: "cruise", allow: ["Bash(cp *)"] });
    const decide = async (command: string) => (await policy({ toolName: "Bash", input: { command }, readOnly: false, isEdit: false } as never)).behavior;
    expect(await decide("cp ~/.yodex/hops/h/1.0.0/scripts/run_cases.py evals/")).toBe("allow");
    expect(await decide("HOME=/tmp/x cp ~/.yodex/hops/h/1.0.0/scripts/run_cases.py evals/")).toBe("ask");
    // (an allow's `*` admits any argument either way, as on production; a run-time value matters to denies and classes)
  });

  test("a deny that names a protected file still fires on its tilde spellings", async () => {
    const policy = createPolicy({ mode: "autopilot", deny: ["Bash(*.mlpal/credentials*)", "Bash(*.ssh/id_*)"] });
    const decide = async (command: string) => (await policy({ toolName: "Bash", input: { command } } as never)).behavior;
    for (const command of ["cat ~/.mlpal/credentials", "cp ~/.mlpal/credentials /tmp/x", "cat ~/'.mlpal'/credentials", "cat ~root/.mlpal/credentials", "HOME=/x cat ~/.mlpal/credentials", "cat ~/.ssh/id_ed25519"])
      expect([command, await decide(command)]).toEqual([command, "deny"]);
  });
});
