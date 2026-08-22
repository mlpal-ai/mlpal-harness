import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "../src/tools/builtin/diff";

describe("unifiedDiff", () => {
  test("no change → empty", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n")).toBe("");
  });

  test("new file (empty before) → all additions", () => {
    const d = unifiedDiff("", "line1\nline2");
    expect(d).toContain("@@ -1,0 +1,2 @@");
    expect(d).toContain("+line1");
    expect(d).toContain("+line2");
    expect(d).not.toContain("\n-"); // nothing removed
  });

  test("single-line edit shows context, removal, addition", () => {
    const before = "one\ntwo\nthree\nfour\nfive";
    const after = "one\ntwo\nTWO-AND-A-HALF\nfour\nfive";
    const d = unifiedDiff(before, after);
    expect(d).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(d).toContain("-three");
    expect(d).toContain("+TWO-AND-A-HALF");
    expect(d).toContain(" two"); // leading context (space-prefixed)
    expect(d).toContain(" four"); // trailing context
  });

  test("caps very large diffs with an elision note", () => {
    const after = Array.from({ length: 1000 }, (_, i) => `l${i}`).join("\n");
    const d = unifiedDiff("", after);
    expect(d.split("\n").length).toBeLessThan(250);
    expect(d).toContain("more line(s)");
  });

  test("hunk header line counts are consistent with body", () => {
    const d = unifiedDiff("a\nb\nc", "a\nX\nc");
    const header = d.split("\n")[0]!;
    const m = header.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
    expect(m).not.toBeNull();
    const body = d.split("\n").slice(1);
    const oldLines = body.filter((l) => l.startsWith(" ") || l.startsWith("-")).length;
    const newLines = body.filter((l) => l.startsWith(" ") || l.startsWith("+")).length;
    expect(oldLines).toBe(Number(m![2]));
    expect(newLines).toBe(Number(m![4]));
  });
});
