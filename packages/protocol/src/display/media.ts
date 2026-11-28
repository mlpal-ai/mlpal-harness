import { z } from "zod";
import { DISPLAY_LIMITS, type MediaKind } from "./catalog.js";
import { report, type DisplayErrorCode } from "./errors.js";
import { inertFallbackText } from "./fallback.js";
import { plainText } from "./fields.js";
import { IMAGE_MIME_TYPES, type ImageItem, type ImageSetSpec, type ImageSpec, madeBySchema, type MediaSpec } from "./media-schemas.js";
import { parseShape } from "./shape.js";

/**
 * The media kinds' checks (DISPLAY-PROTOCOL-v0.1-media §1.3-1.6), pure: no filesystem. The engine probes each path the
 * model names (harness display/media.ts: the workspace jail, a regular file, its size, its magic number, its header,
 * its hash) and hands the facts here; this module checks the model's spec against them and builds the envelope's
 * spec. The magic table and the header readers live here so the engine, the daemon's tests and a client read bytes
 * the same way.
 */

type Path = ReadonlyArray<string | number>;

/** What the engine found at a path the model named, or why it found nothing usable (a typed fault). */
export interface MediaFacts {
  /** Workspace-relative, POSIX. */
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  animated?: boolean;
  gps?: boolean;
}
export type MediaProbeFault = { code: DisplayErrorCode; message: string; hint?: string };
export type MediaProbeResult = MediaFacts | MediaProbeFault;
/** Keyed by the path exactly as the model wrote it. */
export type MediaFactsMap = ReadonlyMap<string, MediaProbeResult>;

// ─── magic numbers ───

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** The type of `head` (a file's first bytes) by its magic number: an image type the image kinds take, SVG (never an
 *  image kind), or null. */
export function sniffMedia(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "image/webp";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head.subarray(0, 1024)).replace(/^﻿/, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return "image/svg+xml";
  return null;
}

/** An image's sides from its header, without decoding it: PNG IHDR (and acTL for an animated PNG), the GIF logical
 *  screen (animated: a second image descriptor), JPEG's first SOFn (and whether its EXIF has a GPS IFD), WebP's VP8,
 *  VP8L or VP8X chunk (animated: the VP8X flag). Null when the header does not parse. */
export function imageInfo(head: Uint8Array, mime: string): { width: number; height: number; animated: boolean; gps?: boolean } | null {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const u16be = (at: number) => (at + 2 <= head.length ? v.getUint16(at, false) : -1);
  const u32be = (at: number) => (at + 4 <= head.length ? v.getUint32(at, false) : -1);
  const u16le = (at: number) => (at + 2 <= head.length ? v.getUint16(at, true) : -1);
  const u24le = (at: number) => (at + 3 <= head.length ? head[at]! | (head[at + 1]! << 8) | (head[at + 2]! << 16) : -1);
  const ok = (w: number, h: number) => (w > 0 && h > 0 ? true : false);
  if (mime === "image/png") {
    if (ascii(head, 12, 4) !== "IHDR") return null;
    const w = u32be(16);
    const h = u32be(20);
    if (!ok(w, h)) return null;
    // an acTL chunk before the first IDAT makes it animated
    let animated = false;
    for (let at = 8; at + 8 <= head.length; ) {
      const len = u32be(at);
      const type = ascii(head, at + 4, 4);
      if (type === "acTL") animated = true;
      if (type === "IDAT" || len < 0) break;
      at += 12 + len;
    }
    return { width: w, height: h, animated };
  }
  if (mime === "image/gif") {
    const w = u16le(6);
    const h = u16le(8);
    if (!ok(w, h)) return null;
    // two image descriptors (0x2C after a block boundary) are animation; a cheap upper bound on the header read
    let frames = 0;
    for (let i = 13; i < head.length && frames < 2; i++) if (head[i] === 0x2c && (head[i - 1] === 0x00 || head[i - 1] === 0x3b || i === 13)) frames++;
    return { width: w, height: h, animated: frames > 1 };
  }
  if (mime === "image/jpeg") {
    let gps: boolean | undefined;
    for (let at = 2; at + 4 <= head.length; ) {
      if (head[at] !== 0xff) return null;
      const marker = head[at + 1]!;
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        at += 2;
        continue;
      }
      const len = u16be(at + 2);
      if (len < 2) return null;
      if (marker === 0xe1 && ascii(head, at + 4, 6) === "Exif\0\0") gps = exifHasGps(head, at + 10, len - 8);
      // SOF0-SOF15 but DHT (C4), JPG (C8) and DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = u16be(at + 5);
        const w = u16be(at + 7);
        return ok(w, h) ? { width: w, height: h, animated: false, ...(gps !== undefined ? { gps } : {}) } : null;
      }
      if (marker === 0xda) return null; // scan data before any frame header
      at += 2 + len;
    }
    return null;
  }
  if (mime === "image/webp") {
    const chunk = ascii(head, 12, 4);
    if (chunk === "VP8 ") {
      if (!startsWith(head, [0x9d, 0x01, 0x2a], 23)) return null;
      const w = u16le(26) & 0x3fff;
      const h = u16le(28) & 0x3fff;
      return ok(w, h) ? { width: w, height: h, animated: false } : null;
    }
    if (chunk === "VP8L") {
      if (head[20] !== 0x2f || head.length < 25) return null;
      const b = (head[21]! | (head[22]! << 8) | (head[23]! << 16) | (head[24]! << 24)) >>> 0;
      const w = (b & 0x3fff) + 1;
      const h = ((b >> 14) & 0x3fff) + 1;
      return { width: w, height: h, animated: false };
    }
    if (chunk === "VP8X") {
      if (head.length < 30) return null;
      const animated = (head[20]! & 0x02) !== 0;
      return { width: u24le(24) + 1, height: u24le(27) + 1, animated };
    }
    return null;
  }
  return null;
}

/** Whether a JPEG's EXIF (the TIFF block at `at`, `len` bytes) points at a GPS IFD from IFD0 (tag 0x8825). */
function exifHasGps(b: Uint8Array, at: number, len: number): boolean | undefined {
  if (at + 8 > b.length) return undefined;
  const le = ascii(b, at, 2) === "II";
  if (!le && ascii(b, at, 2) !== "MM") return undefined;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const end = Math.min(b.length, at + len);
  const u16 = (o: number) => (o + 2 <= end ? v.getUint16(o, le) : -1);
  const u32 = (o: number) => (o + 4 <= end ? v.getUint32(o, le) : -1);
  const ifd0 = u32(at + 4);
  if (ifd0 < 0) return undefined;
  const n = u16(at + ifd0);
  if (n < 0) return undefined;
  for (let i = 0; i < n; i++) {
    const tag = u16(at + ifd0 + 2 + i * 12);
    if (tag < 0) return undefined;
    if (tag === 0x8825) return true;
  }
  return false;
}

/** The extension a type is written with (GenerateImage's file names). */
export const MEDIA_EXTENSION: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// ─── the model's spec ───

/** A media source as the model writes it: a workspace path, never a URL or bytes. */
const mediaPath = z.string().min(1).max(DISPLAY_LIMITS.media.pathChars);
const imageInput = z.object({ path: mediaPath, alt: plainText(DISPLAY_LIMITS.media.altChars) }).strict();
const imageSpecInput = imageInput.extend({ made_by: madeBySchema.optional() }).strict();
const imageSetSpecInput = z
  .object({ images: z.array(imageInput).min(2).max(DISPLAY_LIMITS.media.setImages), chosen: z.number().int().nonnegative().optional(), made_by: madeBySchema.optional() })
  .strict();

/** The paths a media spec names, in order (the engine probes exactly these). Lenient: what does not parse names none. */
export function mediaPaths(kind: MediaKind, spec: unknown): string[] {
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  if (!isObj(spec)) return [];
  const one = (x: unknown) => (isObj(x) && typeof x.path === "string" ? [x.path] : []);
  if (kind === "image") return one(spec);
  return Array.isArray(spec.images) ? spec.images.flatMap(one) : [];
}

/** A path the model wrote that is not a workspace path at all: a URL, a scheme, a network path. */
const NOT_A_PATH = /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|\\\\)/;

export interface MediaCheckOptions {
  /** What the engine found at each path; a path missing here is MEDIA_NOT_FOUND. */
  facts: MediaFactsMap;
  /** The media types this client draws (`run.display.media.formats`); absent: every type the kind takes. */
  formats?: ReadonlySet<string>;
}

/** Check a media kind's spec against the probe's facts and build the envelope's spec, reporting every fault. */
export function checkMediaSpec(kind: MediaKind, spec: unknown, path: Path, opts: MediaCheckOptions): MediaSpec {
  if (kind === "image") {
    const s = parseShape(imageSpecInput, spec, path);
    const item = checkImage(s.path, s.alt, [...path], opts);
    return { ...item, ...(s.made_by ? { made_by: s.made_by } : {}) } satisfies ImageSpec;
  }
  const s = parseShape(imageSetSpecInput, spec, path);
  if (s.chosen !== undefined && s.chosen >= s.images.length) report("VALIDATION_FAILED", [...path, "chosen"], `chosen is ${s.chosen}; the set has ${s.images.length} images, indexed from 0`);
  const images: ImageSetSpec["images"] = [];
  s.images.forEach((im, i) => images.push({ ...checkImage(im.path, im.alt, [...path, "images", i], opts), label: "ABCDEFGH"[i]! }));
  return { images, ...(s.chosen !== undefined ? { chosen: s.chosen } : {}), ...(s.made_by ? { made_by: s.made_by } : {}) };
}

/** One image: the path's form, what the probe found, its type, size and sides. Every fault is reported; the item
 *  is returned only when there is none (a placeholder otherwise, which the caller never uses: the refusal wins). */
function checkImage(p: string, alt: string, at: Array<string | number>, opts: MediaCheckOptions): ImageItem {
  const where = [...at, "path"];
  const placeholder: ImageItem = { media: { path: p, mime: "", bytes: 0, sha256: "0".repeat(64) }, alt, width: 1, height: 1, animated: false };
  if (NOT_A_PATH.test(p)) {
    report("URL_NOT_ALLOWED", where, "a media source is a workspace path, never a URL", "save the file in the workspace (media/ for what you make) and give its path");
    return placeholder;
  }
  if (p.includes("\0")) {
    report("PATH_NOT_ALLOWED", where, "the path has a NUL character");
    return placeholder;
  }
  const f = opts.facts.get(p);
  if (!f) {
    report("MEDIA_NOT_FOUND", where, `no file was checked at ${JSON.stringify(p)}`);
    return placeholder;
  }
  if ("code" in f) {
    report(f.code, where, f.message, f.hint);
    return placeholder;
  }
  const allowed = (IMAGE_MIME_TYPES as readonly string[]).includes(f.mime);
  if (!allowed) {
    const svg = f.mime === "image/svg+xml";
    report("MEDIA_TYPE_NOT_ALLOWED", where, `${f.path} is ${svg ? "SVG" : f.mime || "not an image type this engine knows"}; an image is PNG, JPEG, GIF or WebP (by its bytes)`, svg ? "SVG is never drawn as an image: convert it to PNG" : "save it as PNG, JPEG, GIF or WebP");
    return placeholder;
  }
  if (opts.formats && !opts.formats.has(f.mime)) report("KIND_NOT_ALLOWED", where, `this client does not draw ${f.mime}`, `it draws: ${[...opts.formats].join(", ") || "none"}; convert the image, or answer in text`);
  const L = DISPLAY_LIMITS.media;
  if (f.bytes > L.imageBytes) report("MEDIA_TOO_LARGE", where, `${f.path} is ${f.bytes} bytes; an image is at most ${L.imageBytes}`, "save a smaller or more compressed version");
  if (f.width === undefined || f.height === undefined) {
    report("MEDIA_UNREADABLE", where, `${f.path}'s ${f.mime} header does not parse`, "save the image again, or as PNG");
    return placeholder;
  }
  if (f.width > L.maxSide || f.height > L.maxSide || f.width * f.height > L.maxPixels) {
    report("MEDIA_DIMENSIONS_TOO_LARGE", where, `${f.path} is ${f.width}×${f.height}; an image is at most ${L.maxSide} pixels a side and ${L.maxPixels / 1e6} megapixels`, "save a smaller version");
  }
  return { media: { path: f.path, mime: f.mime, bytes: f.bytes, sha256: f.sha256 }, alt, width: f.width, height: f.height, animated: f.animated ?? false, ...(f.gps !== undefined ? { gps: f.gps } : {}) };
}

// ─── the fallback ───

const TYPE_NAME: Readonly<Record<string, string>> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WebP" };
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** Bytes as a person reads them: 312 KB, 2.1 MB. */
export function humanBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(1)} GB`;
}

/** The engine's lines for a media block's fallback, one per file (§1.5), already neutralised: what a client that
 *  draws no media, a terminal or a mail shows, paths included. */
export function mediaFallbackLines(kind: MediaKind, spec: MediaSpec): string[] {
  const line = (s: string) => inertFallbackText(s.replace(/\s+/g, " ").trim());
  if (kind === "image") {
    const im = spec as ImageSpec;
    return [line(`Image: ${base(im.media.path)} · ${TYPE_NAME[im.media.mime] ?? im.media.mime} · ${im.width}×${im.height} · ${humanBytes(im.media.bytes)} · ${im.media.path}`)];
  }
  const set = spec as ImageSetSpec;
  return set.images.map((im, i) => line(`${im.label}: ${im.alt} · ${im.width}×${im.height} · ${im.media.path}${set.chosen === i ? " (chosen)" : ""}`));
}

/** The complete fallback of a media block: the model's text when it gave one, then the engine's lines; else the alt
 *  texts and the engine's lines. */
export function mediaFallback(kind: MediaKind, spec: MediaSpec, modelText: string | undefined): string {
  const lines = mediaFallbackLines(kind, spec);
  const lead = modelText ?? (kind === "image" ? inertFallbackText((spec as ImageSpec).alt) : `${(spec as ImageSetSpec).images.length} images.`);
  return [lead, ...lines].join("\n");
}
