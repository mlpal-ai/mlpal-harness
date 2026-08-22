import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { expandMentions, extractMentions } from "../src/context/mentions";

let cwd: string;

beforeEach(async () => {
  cwd = join(tmpdir(), `yodex-mentions-${crypto.randomUUID()}`);
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("extractMentions", () => {
  test("pulls @-tokens, dedupes, strips trailing punctuation", () => {
    expect(extractMentions("look at @src/a.ts and @src/a.ts, plus @b.md.")).toEqual([
      "src/a.ts",
      "b.md",
    ]);
  });
  test("ignores bare @ and mid-word @ (emails)", () => {
    expect(extractMentions("email me@example.com now")).toEqual([]);
  });
  test("strips trailing ? and ! that abut a path in a question", () => {
    expect(extractMentions("what is in @settings.yaml? and @notes.md!")).toEqual([
      "settings.yaml",
      "notes.md",
    ]);
  });
});

describe("expandMentions", () => {
  test("inlines a real in-bounds file and reports it", async () => {
    await writeFile(join(cwd, "note.txt"), "HELLO CONTENT");
    const r = await expandMentions("summarize @note.txt please", { cwd, roots: [cwd] });
    expect(r.text).toContain("<referenced-files>");
    expect(r.text).toContain("HELLO CONTENT");
    expect(r.attached).toEqual([{ path: "note.txt", ok: true }]);
  });

  test("leaves prose @-tokens untouched when they aren't files", async () => {
    const r = await expandMentions("ping @nobody about it", { cwd, roots: [cwd] });
    expect(r.text).toBe("ping @nobody about it");
    expect(r.attached).toEqual([]);
  });

  test("refuses an out-of-bounds mention and surfaces it", async () => {
    const outside = join(tmpdir(), `yodex-out-${crypto.randomUUID()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "NOPE");
    const r = await expandMentions(`read @${join(outside, "secret.txt")}`, { cwd, roots: [cwd] });
    expect(r.text).not.toContain("NOPE");
    expect(r.attached[0]).toMatchObject({ ok: false, reason: "outside allowed directories" });
    await rm(outside, { recursive: true, force: true });
  });
});
