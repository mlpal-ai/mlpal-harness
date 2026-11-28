import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { displayEnvelopeSchema, type DisplayCaps } from "@mlpal/harness-protocol";
import { createShowTool, localMediaProbe, resolveDisplay } from "../src/display";
import { SHOW_JSON_SCHEMA, SHOW_MEDIA_JSON_SCHEMA } from "../src/display/schema";
import { silentLogger } from "../src/obs/logger";
import { MemoryMetrics } from "../src/obs/metrics";
import type { ToolResult } from "../src/tools";

/** Show's media kinds through the engine: the workspace jail, the file checks on real files, the client's gate. */
type Vector = { name: string; hex: string };
const magic = JSON.parse(readFileSync(new URL("../../protocol/test/fixtures/display/media-magic.vectors.json", import.meta.url), "utf8")) as { vectors: Vector[] };
const head = (name: string) => Buffer.from(magic.vectors.find((v) => v.name === name)!.hex, "hex");

const MEDIA: DisplayCaps = {
  v: 1, client: "web", levels: ["text", "block"], catalogs: ["harness.v1/1"], kinds: ["chart", "kpis", "grid", "image", "image_set"],
  media: { formats: ["image/png", "image/jpeg", "image/gif", "image/webp"] }, viewport: "desktop", theme: "light", locale: "en-US", timeZone: "UTC",
};

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "media-ws-"));
  outside = mkdtempSync(join(tmpdir(), "media-out-"));
  mkdirSync(join(root, "media"), { recursive: true });
  writeFileSync(join(root, "media", "fox.png"), head("png 1536x1024"));
  writeFileSync(join(root, "media", "b.jpg"), head("jpeg 4032x3024 with a GPS IFD"));
  writeFileSync(join(outside, "secret.png"), head("png 1536x1024"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function tool(caps: DisplayCaps = MEDIA) {
  const show = createShowTool({ policy: resolveDisplay(caps, { media: true })!, history: async () => ({ revisions: new Map(), toolUseIds: new Set() }), logger: silentLogger, metrics: new MemoryMetrics(), probe: localMediaProbe });
  return (input: unknown, runId = "run-1") => show.call(input, { cwd: root, roots: [root], runId });
}
const text = (r: ToolResult) => (typeof r.content === "string" ? r.content : r.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
const faults = (r: ToolResult) => {
  const body = JSON.parse(text(r).split("\n").find((l) => l.startsWith("{"))!) as { error: string; path?: string; faults?: Array<{ code: string; path?: string }> };
  return (body.faults ?? [{ code: body.error, path: body.path }]).map((f) => `${f.code} ${f.path ?? ""}`.trim());
};
const image = (path: string, over: Record<string, unknown> = {}) => ({ block_id: "fox", kind: "image", spec: { path, alt: "A red fox on snow" }, ...over });

describe("a media Show reads the workspace file it names", () => {
  test("the envelope carries the checked file: workspace path, magic type, bytes, sha256 and the header's sides, never the bytes", async () => {
    const r = await tool()(image("media/fox.png"));
    expect(r.isError).toBeUndefined();
    const env = r.meta!.display![0]!;
    expect(displayEnvelopeSchema.safeParse(env).success).toBe(true);
    const bytes = readFileSync(join(root, "media", "fox.png"));
    expect(env).toMatchObject({ level: "block", kind: "image", spec: { media: { path: "media/fox.png", mime: "image/png", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, width: 1536, height: 1024 } });
    expect(JSON.stringify(env)).not.toContain(bytes.toString("base64").slice(0, 16));
    expect(env.fallback.text).toContain("media/fox.png");
  });

  test("an absolute path inside the workspace is stored workspace-relative; GPS in a JPEG's EXIF is flagged", async () => {
    const r = await tool()(image(join(root, "media", "b.jpg")));
    expect(r.meta!.display![0]).toMatchObject({ spec: { media: { path: "media/b.jpg", mime: "image/jpeg" }, width: 4032, height: 3024, gps: true } });
  });

  test("outside the workspace, through .., an absolute path or a symlink, is refused", async () => {
    symlinkSync(join(outside, "secret.png"), join(root, "media", "link.png"));
    symlinkSync(outside, join(root, "out"));
    for (const p of ["../x.png", join(outside, "secret.png"), "out/secret.png"]) expect([p, faults(await tool()(image(p)))]).toEqual([p, ["PATH_OUTSIDE_WORKSPACE spec.path"]]);
    expect(faults(await tool()(image("media/link.png")))).toEqual(["PATH_OUTSIDE_WORKSPACE spec.path"]);
  });

  test("hidden paths, a missing file, a directory, a symlink inside and a NUL are refused", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "x.png"), head("png 1536x1024"));
    mkdirSync(join(root, ".mlpal-state"), { recursive: true });
    writeFileSync(join(root, ".mlpal-state", "x.png"), head("png 1536x1024"));
    mkdirSync(join(root, "sub", ".git"), { recursive: true });
    writeFileSync(join(root, "sub", ".git", "y.png"), head("png 1536x1024"));
    symlinkSync(join(root, "media", "fox.png"), join(root, "media", "alias.png"));
    const cases: Array<[string, string]> = [
      [".git/x.png", "PATH_NOT_ALLOWED"], [".mlpal-state/x.png", "PATH_NOT_ALLOWED"], ["sub/.git/y.png", "PATH_NOT_ALLOWED"],
      ["media/none.png", "MEDIA_NOT_FOUND"], ["media", "MEDIA_NOT_REGULAR"], ["media/alias.png", "MEDIA_NOT_REGULAR"], ["media/a\u0000.png", "PATH_NOT_ALLOWED"],
    ];
    for (const [p, code] of cases) expect([p, faults(await tool()(image(p)))]).toEqual([p, [`${code} spec.path`]]);
  });

  test("the type is the bytes', never the extension; over the cap is refused before any read", async () => {
    writeFileSync(join(root, "media", "zeros.png"), Buffer.alloc(64));
    writeFileSync(join(root, "media", "logo.png"), head("svg (never an image kind)"));
    writeFileSync(join(root, "media", "page.png"), head("html"));
    writeFileSync(join(root, "media", "huge.png"), head("png 30000x30000 (a header only: refused by size before any decode)"));
    writeFileSync(join(root, "media", "big.png"), head("png 1536x1024"));
    truncateSync(join(root, "media", "big.png"), 21 * 1024 * 1024); // sparse: nothing is written
    const cases: Array<[string, string]> = [["media/zeros.png", "MEDIA_TYPE_NOT_ALLOWED"], ["media/logo.png", "MEDIA_TYPE_NOT_ALLOWED"], ["media/page.png", "MEDIA_TYPE_NOT_ALLOWED"], ["media/huge.png", "MEDIA_DIMENSIONS_TOO_LARGE"], ["media/big.png", "MEDIA_TOO_LARGE"]];
    for (const [p, code] of cases) expect([p, faults(await tool()(image(p)))]).toEqual([p, [`${code} spec.path`]]);
    // a polyglot is the image its magic says, and only that
    writeFileSync(join(root, "media", "poly.png"), head("a PNG/HTML polyglot is a PNG"));
    expect((await tool()(image("media/poly.png"))).meta!.display![0]).toMatchObject({ spec: { media: { mime: "image/png" } } });
  });

  test("an image set lists every fault in one refusal; the second failure ends the block as text", async () => {
    const show = tool();
    const set = { block_id: "opts", kind: "image_set", spec: { images: [{ path: "media/fox.png", alt: "A" }, { path: "../x.png", alt: "B" }, { path: "media/none.png", alt: "C" }], chosen: 7 }, fallback: { text: "Three options." } };
    const first = await show(set);
    expect(faults(first)).toEqual(["VALIDATION_FAILED spec.chosen", "PATH_OUTSIDE_WORKSPACE spec.images[1].path", "MEDIA_NOT_FOUND spec.images[2].path"]);
    expect(first.meta!.display![0]).toMatchObject({ level: "text", status: "repairing" });
    const second = await show(set);
    expect(text(second)).toContain("RETRY_EXHAUSTED");
    expect(second.meta!.display![0]).toMatchObject({ level: "text", status: "fallback_only" });
    const ok = await tool()({ ...set, spec: { images: [{ path: "media/fox.png", alt: "A" }, { path: "media/b.jpg", alt: "B" }], chosen: 1 } });
    expect(ok.meta!.display![0]).toMatchObject({ kind: "image_set", spec: { chosen: 1, images: [{ label: "A" }, { label: "B", gps: true }] } });
  });
});

describe("only a client that names the kinds and declares media gets them", () => {
  test("resolveDisplay: media kinds need the engine's local files, `kinds` naming them, and `media` with an image type", () => {
    const kinds = (caps: DisplayCaps, media = true) => [...(resolveDisplay(caps, { media })?.kinds ?? [])].sort();
    expect(kinds(MEDIA)).toEqual(["chart", "grid", "image", "image_set", "kpis"]);
    expect(kinds(MEDIA, false)).toEqual(["chart", "grid", "kpis"]);
    const { media: _m, ...noMedia } = MEDIA;
    expect(kinds(noMedia)).toEqual(["chart", "grid", "kpis"]);
    const { kinds: _k, ...noKinds } = MEDIA;
    expect(kinds(noKinds)).toEqual(["chart", "grid", "kpis"]);
    expect(kinds({ ...MEDIA, media: { formats: ["audio/mpeg"] } })).toEqual(["chart", "grid", "kpis"]);
  });

  test("a type the client does not draw is refused to the model", async () => {
    const r = await tool({ ...MEDIA, media: { formats: ["image/jpeg"] } })(image("media/fox.png"));
    expect(faults(r)).toEqual(["KIND_NOT_ALLOWED spec.path"]);
  });

  test("a wave-1 client's schema is unchanged; a media client's names the kinds and makes the fallback optional", () => {
    const wave1 = createShowTool({ policy: resolveDisplay({ ...MEDIA, kinds: undefined })!, history: async () => ({ revisions: new Map(), toolUseIds: new Set() }), logger: silentLogger, metrics: new MemoryMetrics() });
    expect(wave1.jsonSchema).toBe(SHOW_JSON_SCHEMA);
    const media = createShowTool({ policy: resolveDisplay(MEDIA, { media: true })!, history: async () => ({ revisions: new Map(), toolUseIds: new Set() }), logger: silentLogger, metrics: new MemoryMetrics(), probe: localMediaProbe });
    expect(media.jsonSchema).toBe(SHOW_MEDIA_JSON_SCHEMA);
    const s = SHOW_MEDIA_JSON_SCHEMA as { required: string[]; properties: { kind: { enum: string[] }; spec: { properties: Record<string, unknown> } } };
    expect(s.properties.kind.enum).toEqual(["chart", "kpis", "grid", "image", "image_set"]);
    expect(s.required.sort()).toEqual(["block_id", "kind", "spec"]);
    expect(Object.keys(s.properties.spec.properties)).toEqual(expect.arrayContaining(["path", "alt", "images", "chosen"]));
    expect(JSON.stringify(SHOW_MEDIA_JSON_SCHEMA)).not.toMatch(/"(oneOf|allOf|const|\$ref)"/);
  });
});
