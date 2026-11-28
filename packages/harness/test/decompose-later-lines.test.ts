import { describe, expect, test } from "bun:test";
import { createPolicy } from "../src/permission/engine";
import { classifyAction } from "../src/permission/safety-envelope";
import { decomposeBash } from "../src/permission/shell-decompose";
import type { SafetyPolicy } from "../src/profile/types";

/**
 * Review of the quoting fix (R1, R2): an ANSI-C escape bash decodes in a way the decomposer does not, and a
 * definition on one line that changes what a word means on a later one.
 */
const SAFETY: SafetyPolicy = {
  toolClasses: { readOnly: ["Bash(git status*)", "Bash(ls*)"], mutative: [], consequential: [], destructive: ["Bash(mlpal mcp delete*)", "Bash(mlpal hops chat*)", "Bash(mlpal keys create*)"] },
  preApply: { requirePlanArtifact: false, hash: [] },
  blastRadius: {},
  approval: { destructive: "always", outOfScope: "always" },
  identities: { neverSelfGrant: true },
};
// an applies-tagged Bash: unlisted is mutative, so a readOnly entry is what admits a read
const cls = (command: string) => classifyAction(SAFETY, { toolName: "Bash", command, tags: { applies: true } });
const deny = createPolicy({ mode: "autopilot", deny: ["Bash(*.mlpal/credentials*)"] });
const decide = async (command: string) => (await deny({ toolName: "Bash", input: { command } } as never)).behavior;

describe("R1: an escape outside what the decomposer decodes exactly makes the line opaque", () => {
  const REVIEWER = ["mlpal mcp $'\\x{64}elete' srv", "mlpal mcp $'de\\x{6c}ete' srv", "mlpal hops $'\\x{63}hat' --publication p", "mlpal keys $'\\x{63}reate'"];
  for (const line of REVIEWER) test(`destructive: ${JSON.stringify(line)}`, () => expect([decomposeBash(line).opaque !== null, cls(line)]).toEqual([true, "destructive"]));
  test("the credentials deny fires for the braced-hex spelling", async () => expect(await decide("cat ~/.$'\\x{6d}lpal'/credentials")).toBe("deny"));
  test("every escape bash reads differently, or the decomposer does not decode, is opaque", () => {
    for (const e of ["\\x{41}", "\\x{}", "\\xg", "\\x", "\\u0041", "\\U00000041", "\\c?", "\\c", "\\q", "\\8", "\\xe9", "\\777"]) expect([e, decomposeBash(`echo $'a${e}'`).opaque !== null]).toEqual([e, true]);
    for (const e of ["\\n", "\\t", "\\x41", "\\x4", "\\101", "\\0101", "\\cA", "\\e", "\\\\", '\\"', "\\?"]) expect([e, decomposeBash(`echo $'a${e}b'`).opaque]).toEqual([e, null]);
  });
});

describe("R2: what a line defines for a later one is opaque, or never admitted as read-only", () => {
  const OPAQUE = [
    // the reviewer's
    "shopt -s expand_aliases\nalias m='mlpal mcp delete'\nm srv",
    // ten of our own
    "alias m='mlpal mcp delete'; m srv",
    "bash -i -c \"alias m='mlpal mcp delete'\nm srv\"",
    "alias ls='rm -rf'",
    "shopt -s expand_aliases",
    "enable -f ./evil.so ls",
    "enable -n echo",
    "hash -p /tmp/evil/git git; git status",
    "set -k; mlpal mcp X=1 list",
    "set -o allexport",
    "f() { mlpal mcp delete srv; }; f",
  ];
  for (const line of OPAQUE) test(`opaque: ${JSON.stringify(line)}`, () => expect([decomposeBash(line).opaque !== null, cls(line)]).toEqual([true, "destructive"]));

  test("a changed PATH (or another variable that picks the code that runs) keeps every command of the line from read-only", () => {
    for (const line of ["export PATH=./evil:$PATH; git status", "PATH=/tmp/x git status", "env PATH=/tmp/x ls", "declare -x LD_PRELOAD=/tmp/e.so; ls", "export BASH_ENV=/tmp/e; ls"]) {
      expect([line, decomposeBash(line).opaque, cls(line)]).toEqual([line, null, "mutative"]);
    }
    expect([cls("git status"), cls("FOO=1 git status"), cls("export FOO=1; ls")]).toEqual(["readOnly", "readOnly", "readOnly"]);
  });

  test("ordinary lines are unchanged: set -euo pipefail, set --, unalias, alias listing, an export", () => {
    for (const line of ["set -euo pipefail; ls", "set -e\nset -x\nls", "set -- a b; ls", "set +e; ls", "unalias ll; ls", "alias", "alias -p", "export FOO=1; ls", "shopt -s nullglob; ls"]) expect([line, decomposeBash(line).opaque]).toEqual([line, null]);
  });
});
