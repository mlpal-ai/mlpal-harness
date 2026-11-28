import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { checkShowInput, displayEnvelopeSchema, imageInfo, parseDisplayCaps, sniffMedia, type MediaFacts, type MediaProbeResult } from "../src/index";

/** The media kinds (DISPLAY-PROTOCOL-v0.1-media): what the checks make of the engine's facts, with no filesystem. */
type Vector = { name: string; hex: string; mime: string | null; info: null | "unreadable" | { width: number; height: number; animated: boolean; gps?: boolean } };
const magic = JSON.parse(readFileSync(new URL("./fixtures/display/media-magic.vectors.json", import.meta.url), "utf8")) as { vectors: Vector[] };
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

describe("magic numbers and headers (the shared vectors)", () => {
  for (const v of magic.vectors) {
    test(v.name, () => {
      const head = bytes(v.hex);
      expect(sniffMedia(head)).toBe(v.mime);
      if (v.mime && v.mime !== "image/svg+xml") expect(imageInfo(head, v.mime)).toEqual(v.info === "unreadable" ? null : v.info);
    });
  }
});

const PNG: MediaFacts = { path: "media/2026-11-28/hero-1.png", mime: "image/png", bytes: 1_234_567, sha256: "a".repeat(64), width: 1536, height: 1024, animated: false };
const facts = (...xs: Array<[string, MediaProbeResult]>) => new Map(xs);
const IMAGE_KINDS = new Set(["chart", "kpis", "grid", "image", "image_set"] as const);
const image = (over: Record<string, unknown> = {}) => ({ block_id: "hero", kind: "image", spec: { path: "media/2026-11-28/hero-1.png", alt: "A red fox on snow at dawn" }, ...over });
const check = (input: unknown, media = facts(["media/2026-11-28/hero-1.png", PNG]), extra: Record<string, unknown> = {}) => checkShowInput(input, { kinds: IMAGE_KINDS, media, ...extra });
const faults = (r: ReturnType<typeof checkShowInput>) => (r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path ?? ""}`.trim()));

describe("an image block", () => {
  test("its spec is the checked file and the header's facts; the fallback is the engine's, by path", () => {
    const r = check(image());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.show.spec).toEqual({ media: { path: PNG.path, mime: "image/png", bytes: 1_234_567, sha256: "a".repeat(64) }, alt: "A red fox on snow at dawn", width: 1536, height: 1024, animated: false });
    expect(r.show.fallback).toBe("A red fox on snow at dawn\nImage: hero-1.png · PNG · 1536×1024 · 1.2 MB · media/2026-11-28/hero-1.png");
    const envelope = { v: 1, block_id: "hero", revision: 1, op: "snapshot", level: "block", kind: "image", catalog: "harness.v1/1", spec: r.show.spec, fallback: { text: r.show.fallback }, source: { by: "model" }, status: "ok" };
    expect(displayEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(JSON.stringify(envelope)).not.toMatch(/base64|data:|https?:/);
  });

  test("the model's own text leads, short text is fine, and the engine's line follows", () => {
    const r = check(image({ fallback: { text: "The fox, as asked." } }));
    expect(r.ok && r.show.fallback).toBe("The fox, as asked.\nImage: hero-1.png · PNG · 1536×1024 · 1.2 MB · media/2026-11-28/hero-1.png");
    expect(faults(check(image({ fallback: { text: "x", table: { from: "rows" } } })))).toEqual(["VALIDATION_FAILED fallback.table"]);
  });

  test("an alt text is required, plain, at most 300 characters", () => {
    expect(faults(check(image({ spec: { path: PNG.path } })))).toEqual(["VALIDATION_FAILED spec.alt"]);
    expect(faults(check(image({ spec: { path: PNG.path, alt: "a‮b" } })))).toEqual(["VALIDATION_FAILED spec.alt"]);
    expect(faults(check(image({ spec: { path: PNG.path, alt: "x".repeat(301) } })))).toEqual(["VALIDATION_FAILED spec.alt"]);
  });

  test("a URL, a scheme or a network path is never a source", () => {
    for (const p of ["https://x.test/a.png", "data:image/png;base64,AAAA", "blob:abc", "//host/a.png", "file:///etc/passwd"]) {
      expect([p, faults(check(image({ spec: { path: p, alt: "a" } }), facts()))]).toEqual([p, ["URL_NOT_ALLOWED spec.path"]]);
    }
  });

  test("the probe's fault, a type no image kind takes, the size and the sides are each refused at the path", () => {
    const at = (r: MediaProbeResult) => faults(check(image(), facts([PNG.path, r])));
    expect(at({ code: "PATH_OUTSIDE_WORKSPACE", message: "outside" })).toEqual(["PATH_OUTSIDE_WORKSPACE spec.path"]);
    expect(at({ ...PNG, mime: "image/svg+xml", width: undefined, height: undefined })).toEqual(["MEDIA_TYPE_NOT_ALLOWED spec.path"]);
    expect(at({ ...PNG, mime: "application/octet-stream" })).toEqual(["MEDIA_TYPE_NOT_ALLOWED spec.path"]);
    expect(at({ ...PNG, bytes: 21 * 1024 * 1024 })).toEqual(["MEDIA_TOO_LARGE spec.path"]);
    expect(at({ ...PNG, width: 30_000, height: 30_000 })).toEqual(["MEDIA_DIMENSIONS_TOO_LARGE spec.path"]);
    expect(at({ ...PNG, width: 1, height: 100_000 })).toEqual(["MEDIA_DIMENSIONS_TOO_LARGE spec.path"]);
    expect(at({ ...PNG, width: undefined, height: undefined })).toEqual(["MEDIA_UNREADABLE spec.path"]);
    expect(faults(check(image(), facts()))).toEqual(["MEDIA_NOT_FOUND spec.path"]);
    const svg = check(image(), facts([PNG.path, { ...PNG, mime: "image/svg+xml" }]));
    expect(!svg.ok && svg.error.hint).toMatch(/SVG is never drawn as an image/);
  });

  test("a client must name the kind, and draw the type", () => {
    expect(faults(checkShowInput(image(), { media: facts([PNG.path, PNG]) }))).toEqual(["KIND_NOT_ALLOWED kind"]);
    expect(faults(checkShowInput(image(), { kinds: new Set(["chart", "image_set"] as const), media: facts([PNG.path, PNG]) }))).toEqual(["KIND_NOT_ALLOWED kind"]);
    expect(faults(check(image(), undefined, { formats: new Set(["image/jpeg"]) }))).toEqual(["KIND_NOT_ALLOWED spec.path"]);
    expect(check(image(), undefined, { formats: new Set(["image/png"]) }).ok).toBe(true);
  });
});

describe("an image set", () => {
  const set = (images: unknown[], over: Record<string, unknown> = {}) => ({ block_id: "options", kind: "image_set", spec: { images, ...over } });
  const A = { path: "media/a.png", alt: "Option A" };
  const B = { path: "media/b.png", alt: "Option B" };
  const all = facts(["media/a.png", { ...PNG, path: "media/a.png" }], ["media/b.png", { ...PNG, path: "media/b.png", width: 1024, height: 1024 }]);

  test("labelled A to H in order; chosen marks one; one engine line per image", () => {
    const r = check(set([A, B], { chosen: 1 }), all);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.show.spec as { images: Array<{ label: string }> }).images.map((i) => i.label)).toEqual(["A", "B"]);
    expect(r.show.fallback).toBe("2 images.\nA: Option A · 1536×1024 · media/a.png\nB: Option B · 1024×1024 · media/b.png (chosen)");
  });

  test("every fault in one refusal: a chosen past the end, a missing file and an SVG", () => {
    const r = check(set([A, B, { path: "media/c.svg", alt: "C" }], { chosen: 5 }), facts(["media/a.png", { ...PNG, path: "media/a.png" }], ["media/c.svg", { ...PNG, path: "media/c.svg", mime: "image/svg+xml" }]));
    expect(faults(r)).toEqual(["VALIDATION_FAILED spec.chosen", "MEDIA_NOT_FOUND spec.images[1].path", "MEDIA_TYPE_NOT_ALLOWED spec.images[2].path"]);
  });

  test("2 to 8 images", () => {
    expect(faults(check(set([A]), all))).toEqual(["VALIDATION_FAILED spec.images"]);
    expect(faults(check(set(Array.from({ length: 9 }, () => A)), all))).toEqual(["VALIDATION_FAILED spec.images"]);
  });
});

describe("the declaration", () => {
  const base = { v: 1, client: "web", levels: ["text", "block"], catalogs: ["harness.v1/1"], viewport: "desktop", theme: "light", locale: "en-US", timeZone: "UTC" };
  test("media is optional, parsed when well formed, dropped (never the run) when not", () => {
    const ok = parseDisplayCaps({ ...base, kinds: ["chart", "image"], media: { formats: ["image/png", "image/webp"], save_data: false } });
    expect(ok.ok && ok.value.media).toEqual({ formats: ["image/png", "image/webp"], save_data: false });
    const bad = parseDisplayCaps({ ...base, media: { formats: "png" } });
    expect(bad.ok && "media" in bad.value && bad.value.media).toBe(undefined);
    expect(parseDisplayCaps(base).ok).toBe(true);
  });
});

describe("the media envelope fixtures the UI builds against", () => {
  const dir = new URL("./fixtures/display/media/", import.meta.url);
  for (const name of ["image", "image-generated", "image-set-4", "image-repairing"]) {
    test(`${name}.json is a valid envelope`, () => expect(displayEnvelopeSchema.safeParse(JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"))).success).toBe(true));
  }
  test("display-caps.json parses, media and all", () => {
    const r = parseDisplayCaps(JSON.parse(readFileSync(new URL("display-caps.json", dir), "utf8")));
    expect(r.ok && r.value.media?.formats.length).toBe(4);
  });
});
