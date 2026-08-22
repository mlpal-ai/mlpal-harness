import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  collectAttachments,
  collectAttachmentsForPaths,
  detectImagePaths,
  detectImageSpans,
  detectMediaPaths,
  isMediaPath,
} from "../src/context/attachments";

let cwd: string;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

beforeEach(async () => {
  cwd = join(tmpdir(), `yodex-att-${crypto.randomUUID()}`);
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("detectMediaPaths", () => {
  test("finds bare, escaped-space, and quoted paths (drag-drop forms)", () => {
    const text =
      "look at /tmp/a.png and /Users/me/Desktop/Screen\\ Shot.png plus '/tmp/with space.pdf' and \"/tmp/q.docx\"";
    const found = detectMediaPaths(text);
    expect(found).toContain("/tmp/a.png");
    expect(found).toContain("/Users/me/Desktop/Screen Shot.png");
    expect(found).toContain("/tmp/with space.pdf");
    expect(found).toContain("/tmp/q.docx");
  });

  test("finds @-mentions and relative paths; ignores prose", () => {
    const found = detectMediaPaths("compare @shots/before.png with shots/after.jpeg thanks");
    expect(found).toContain("shots/before.png");
    expect(found).toContain("shots/after.jpeg");
    expect(detectMediaPaths("no media here, just words")).toHaveLength(0);
  });

  test("isMediaPath classifies extensions", () => {
    expect(isMediaPath("x.png")).toBe(true);
    expect(isMediaPath("x.pdf")).toBe(true);
    expect(isMediaPath("x.docx")).toBe(true);
    expect(isMediaPath("x.ts")).toBe(false);
  });
});

describe("collectAttachments", () => {
  test("attaches a real png as an image block; skips nonexistent paths silently", async () => {
    await writeFile(join(cwd, "shot.png"), PNG);
    const atts = await collectAttachments(`see shot.png and /nope/missing.png`, cwd);
    expect(atts).toHaveLength(1);
    expect(atts[0]!.kind).toBe("image");
    expect(atts[0]!.block).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
  });

  test("attaches a pdf as a document block", async () => {
    await writeFile(join(cwd, "doc.pdf"), "%PDF-1.4 fake");
    const [a] = await collectAttachments("read doc.pdf", cwd);
    expect(a!.block).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
  });

  test("oversized image is reported as skipped", async () => {
    await writeFile(join(cwd, "big.png"), Buffer.alloc(6 * 1024 * 1024));
    const [a] = await collectAttachments("see big.png", cwd);
    expect(a!.skipped).toContain("too large");
  });

  test("drag-drop path with spaces is detected regardless of escaping (disk pass)", async () => {
    const name = "Screenshot 2026-06-29 at 3.51.16 AM.png";
    await writeFile(join(cwd, name), PNG);
    // fully escaped, unescaped, and the mixed form from the real bug report
    for (const path of [
      `${cwd}/Screenshot\\ 2026-06-29\\ at\\ 3.51.16\\ AM.png what's here`,
      `${cwd}/Screenshot 2026-06-29 at 3.51.16 AM.png what's here`,
      `${cwd}/Screenshot\\ 2026-06-29\\ at\\ 3.51.16 AM.png what's here`, // mixed (the bug)
    ]) {
      const atts = await collectAttachments(path, cwd);
      expect(atts).toHaveLength(1);
      expect(atts[0]!.kind).toBe("image");
      expect(atts[0]!.name).toBe(name);
    }
  });

  test("does not duplicate a path found by both the pattern and disk passes", async () => {
    await writeFile(join(cwd, "clean.png"), PNG);
    const atts = await collectAttachments(`${cwd}/clean.png describe it`, cwd);
    expect(atts).toHaveLength(1);
  });
});

describe("detectImagePaths (live placeholder detection, no read)", () => {
  test("returns existing image abs paths only — not pdfs, not missing files", async () => {
    await writeFile(join(cwd, "a.png"), PNG);
    await writeFile(join(cwd, "d.pdf"), "%PDF fake");
    const got = detectImagePaths(`${cwd}/a.png and ${cwd}/d.pdf and ${cwd}/missing.png`, cwd);
    expect(got).toEqual([join(cwd, "a.png")]); // pdf excluded, missing excluded
  });

  test("handles the quoted / escaped-space drag-drop forms", async () => {
    const name = "Screen Shot.png";
    await writeFile(join(cwd, name), PNG);
    for (const form of [`'${cwd}/${name}'`, `${cwd}/Screen\\ Shot.png`]) {
      expect(detectImagePaths(form, cwd)).toContain(join(cwd, name));
    }
  });

  test("handles paths with escaped COMMAS (and other specials), not just spaces", async () => {
    // Regression: a ChatGPT export like "… Jul 15, 2026 …" is dropped with commas backslash-escaped.
    const name = "ChatGPT Image Jul 15, 2026, 04_39_03 PM.png";
    await writeFile(join(cwd, name), PNG);
    const pasted = `${cwd}/ChatGPT\\ Image\\ Jul\\ 15\\,\\ 2026\\,\\ 04_39_03\\ PM.png`;
    expect(detectImagePaths(pasted, cwd)).toEqual([join(cwd, name)]);
  });

  test("does not mangle a Windows path (backslash before a letter is a separator, not an escape)", () => {
    expect(detectMediaPaths("C:\\Users\\me\\shot.png")).toContain("C:\\Users\\me\\shot.png");
  });
});

describe("detectImageSpans (exact raw span + resolved path, for placeholder replacement)", () => {
  test("returns the verbatim matched text alongside the unescaped path", async () => {
    const name = "a, b.png";
    await writeFile(join(cwd, name), PNG);
    const pasted = `${cwd}/a\\,\\ b.png`;
    const spans = detectImageSpans(pasted, cwd);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.raw).toBe(`${cwd}/a\\,\\ b.png`); // exact, still escaped
    expect(spans[0]!.path).toBe(join(cwd, name)); // resolved, unescaped
    // and replacing the raw span with a marker yields clean text
    expect(pasted.replace(spans[0]!.raw, "[Image #1]")).toBe("[Image #1]");
  });
});

describe("collectAttachmentsForPaths (resolve [Image #N] placeholders)", () => {
  test("builds image blocks from an explicit path list, deduped, skipping non-media", async () => {
    await writeFile(join(cwd, "x.png"), PNG);
    const atts = await collectAttachmentsForPaths(
      [join(cwd, "x.png"), join(cwd, "x.png"), join(cwd, "notes.txt")],
      cwd,
    );
    expect(atts).toHaveLength(1);
    expect(atts[0]!.kind).toBe("image");
    expect(atts[0]!.block).toMatchObject({ type: "image", source: { media_type: "image/png" } });
  });
});
