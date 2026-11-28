import { describe, expect, test } from "bun:test";
import { contentSafetyDeny, protectedReadDeny } from "../src/permission/safety";

/** Integration of review-media R8 with tools-admin REVIEW-2: every protected-name rule matches the name as a
 *  case-insensitive, normalising file system (APFS, HFS+) resolves it. */
describe("protected names fold on every platform", () => {
  test("the home's .yodex and the person's keys, in any case or with an ignorable code point, are refused to commands", () => {
    for (const cmd of ["cat ~/.YODEX/credentials.json", "ls $HOME/.Yodex/hops", "cat /Users/sai/.yodex/MCP-AUTH/x", "cat ~/.yo‌dex/x", "cat ~/.yodex/Person-Secrets.JSON", "cat /home/u/.YoDeX/state"])
      expect([cmd, protectedReadDeny(cmd) !== null]).toEqual([cmd, true]);
    expect(protectedReadDeny("cat ~/.yodex/YODEX.md")).toBeNull();
    expect(protectedReadDeny("cat ~/.YODEX/agents.md")).toBeNull();
    expect(protectedReadDeny("cat .yodex/hops/x/HOP.md")).toBeNull();
  });
  test("protected writes fold too", () => {
    expect(contentSafetyDeny("/w/.GIT/config")).not.toBeNull();
    expect(contentSafetyDeny("/home/u/.Ssh/id_ed25519")).not.toBeNull();
  });
});
