import { describe, expect, test } from "bun:test";
import { contentSafetyDeny, protectedReachAsk, protectedReadDeny } from "../src/permission/safety";

/** Integration of review-media R8 with tools-admin REVIEW-2: every protected-name rule matches the name as a
 *  case-insensitive, normalising file system (APFS, HFS+) resolves it. */
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
