import { describe, expect, test } from "bun:test";
import { contentSafetyDeny, normalWord, protectedReachAsk, protectedReadDeny } from "../src/permission/safety";
import { decomposeBash, homeTildeRest } from "../src/permission/shell-decompose";

/** Integration of review-media R8 with tools-admin REVIEW-2: every protected-name rule matches the name as a
 *  case-insensitive, normalising file system (APFS, HFS+) resolves it. */
describe("one home tilde for the decomposer and the path rules", () => {
  test("the words the decomposer reads as the home are the words normalWord resolves to the home", () => {
    const ctx = { home: "/home/me" };
    for (const w of ["~", "~/", "~/.yodex/hops/x/run.sh", "~/x y"]) {
      expect([w, homeTildeRest(w) !== null, normalWord(w, ctx)?.path.startsWith("/home/me")]).toEqual([w, true, true]);
      expect([w, decomposeBash(`cp ${w.replace(" ", "\\ ")} dest`).commands[0]!.wild ?? null]).toEqual([w, null]);
    }
    for (const w of ["~root/x", "~+", "~-/x", "~0", "a~/b"]) expect([w, homeTildeRest(w)]).toEqual([w, null]);
    expect(normalWord("~root/.yodex", ctx)?.path).toBe("/home/root/.yodex");
    // a recursive read of the home's state, in a folded spelling, still asks
    expect(protectedReachAsk("find ~/.YODEX -name x", ctx)).not.toBeNull();
  });
});

describe("protected names fold on every platform", () => {
  test("the home's .yodex and the person's keys, in any case or with an ignorable code point, are refused to commands", () => {
    for (const cmd of ["cat ~/.YODEX/credentials.json", "cat /Users/sai/.yodex/MCP-AUTH/x", "cat ~/.yo\u200cdex/credentials.json", "cat ~/.yodex/Person-Secrets.JSON", "cat /home/u/.YoDeX/Trust.json"])
      expect([cmd, protectedReadDeny(cmd) !== null]).toEqual([cmd, true]);
    // tools-admin REVIEW-3: everything else under ~/.yodex stays usable (skill scripts run from there), in any case
    expect(protectedReadDeny("bash ~/.YODEX/hops/x/1.0.0/skills/s/run.sh")).toBeNull();
    expect(protectedReadDeny("cat ~/.yodex/YODEX.md")).toBeNull();
  });
  test("a pattern that could reach the home's .yodex is asked in any case", () => {
    expect(protectedReachAsk("cat ~/.YOD*/x")).not.toBeNull();
    expect(protectedReachAsk("cat ~/.yod*/x")).not.toBeNull();
  });
  test("protected writes fold too", () => {
    expect(contentSafetyDeny("/w/.GIT/config")).not.toBeNull();
    expect(contentSafetyDeny("/home/u/.Ssh/id_ed25519")).not.toBeNull();
  });
});
