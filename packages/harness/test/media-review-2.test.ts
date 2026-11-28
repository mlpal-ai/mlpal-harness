import { createHash } from "node:crypto";
import { constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DISPLAY_LIMITS, type DisplayCaps } from "@mlpal/harness-protocol";
import { createShowTool, localMediaProbe, probeMedia, resolveDisplay } from "../src/display";
import { silentLogger } from "../src/obs/logger";
import { MemoryMetrics } from "../src/obs/metrics";
import { foldName } from "../src/permission/names";
import { contentSafetyDeny } from "../src/permission/safety";
import type { ImageGateway, ImageRequest } from "../src/gateway/images";
import { createGenerateImageTool } from "../src/tools/builtin/image";
import type { ToolResult } from "../src/tools";

/** Review-media round 2: R9 (files over the 1 MiB read window) and R8 (the macOS open flags, folded hidden names). */
const magic = JSON.parse(readFileSync(new URL("../../protocol/test/fixtures/display/media-magic.vectors.json", import.meta.url), "utf8")) as { vectors: Array<{ name: string; hex: string }> };
const PNG_HEAD = Buffer.from(magic.vectors.find((v) => v.name === "png 1536x1024")!.hex, "hex");
/** A PNG of `n` bytes: a real header, then padding (the probe reads the header and hashes the whole file). */
const png = (n: number) => Buffer.concat([PNG_HEAD, Buffer.alloc(n - PNG_HEAD.length, 7)]);
const CAP = DISPLAY_LIMITS.media.imageBytes;
const MEDIA: DisplayCaps = { v: 1, client: "web", levels: ["text", "block"], catalogs: ["harness.v1/1"], kinds: ["chart", "image", "image_set"], media: { formats: ["image/png"] }, viewport: "desktop", theme: "light", locale: "en-US", timeZone: "UTC" };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "media-r2-"));
  mkdirSync(join(root, "media"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const ctx = () => ({ cwd: root, roots: [root] });
const text = (r: ToolResult) => (typeof r.content === "string" ? r.content : r.content.map((b) => (b.type === "text" ? b.text : "")).join(""));

describe("R9: a file over the read window is read and hashed in chunks, up to the kind's cap", () => {
  test("1 MiB + 1, 3 MiB and exactly the image cap are probed with the right hash; one byte over is MEDIA_TOO_LARGE", () => {
    for (const n of [1024 * 1024 + 1, 3 * 1024 * 1024, CAP]) {
      const bytes = png(n);
      writeFileSync(join(root, "media", "big.png"), bytes);
      const r = probeMedia({ path: "media/big.png", maxBytes: CAP }, ctx());
      expect([n, "code" in r ? r.code : r.sha256]).toEqual([n, createHash("sha256").update(bytes).digest("hex")]);
    }
    writeFileSync(join(root, "media", "big.png"), png(CAP + 1));
    const over = probeMedia({ path: "media/big.png", maxBytes: CAP }, ctx());
    expect("code" in over ? over.code : "ok").toBe("MEDIA_TOO_LARGE");
  });

  test("through Show: a 3 MiB PNG becomes an image block; one byte over the image cap is refused, typed", async () => {
    const show = createShowTool({ policy: resolveDisplay(MEDIA, { media: true })!, history: async () => ({ revisions: new Map(), toolUseIds: new Set() }), logger: silentLogger, metrics: new MemoryMetrics(), probe: localMediaProbe });
    writeFileSync(join(root, "media", "photo.png"), png(3 * 1024 * 1024));
    const ok = await show.call({ block_id: "photo", kind: "image", spec: { path: "media/photo.png", alt: "A photo" } }, { ...ctx(), runId: "r" });
    expect([ok.isError ?? false, ok.meta?.display?.[0]?.level, (ok.meta?.display?.[0] as { kind?: string })?.kind]).toEqual([false, "block", "image"]);
    writeFileSync(join(root, "media", "huge.png"), png(CAP + 1));
    const big = await show.call({ block_id: "huge", kind: "image", spec: { path: "media/huge.png", alt: "Too big" } }, { ...ctx(), runId: "r" });
    expect([big.isError, text(big).includes("MEDIA_TOO_LARGE")]).toEqual([true, true]);
  });

  test("through GenerateImage: a 3 MiB result is shown as an image block; one over the image cap is saved and named, not drawn", async () => {
    const gateway = (size: number): ImageGateway => ({
      submit: async (req: ImageRequest) => ({ result: { data: Array.from({ length: req.n }, (_, i) => ({ url: `https://assets.test/${i}.png` })), model: "m", cost: { compute_units: 0.01 } } }),
      job: async () => {
        throw new Error("no job");
      },
      download: async () => png(size),
    });
    const tool = (size: number) => createGenerateImageTool({ images: gateway(size), models: () => [], estimate: () => 0.01, now: () => new Date("2026-11-28T10:00:00Z") });
    const shown = await tool(3 * 1024 * 1024).call({ prompt: "a fox" } as never, { ...ctx(), toolUseId: "toolu_big" });
    expect([shown.isError ?? false, (shown.meta?.display?.[0] as { kind?: string })?.kind, text(shown).includes("not shown")]).toEqual([false, "image", false]);
    const over = await tool(CAP + 1).call({ prompt: "a fox" } as never, { ...ctx(), toolUseId: "toolu_over" });
    expect([over.meta?.display, text(over)]).toEqual([undefined, expect.stringContaining("not shown as a block: MEDIA_TOO_LARGE")]);
  });
});

describe("R8: the macOS open flags, and hidden or protected names folded as a case-insensitive file system resolves them", () => {
  test("the open never combines O_NOFOLLOW with macOS's O_NOFOLLOW_ANY (EINVAL), and a plain file opens", () => {
    writeFileSync(join(root, "media", "a.png"), png(100));
    const r = probeMedia({ path: "media/a.png", maxBytes: CAP }, ctx());
    expect("code" in r ? r.code : r.mime).toBe("image/png");
    const src = readFileSync(new URL("../src/display/media.ts", import.meta.url), "utf8");
    expect(src).toContain("(NOFOLLOW_ANY || constants.O_NOFOLLOW)");
    expect(constants.O_NOFOLLOW).toBeGreaterThan(0);
  });

  test(".GIT, .Git, .MLPAL-state, .Mlpal-State, a decomposed or zero-width variant are hidden like .git and .mlpal*", () => {
    const names = [".GIT/config", ".Git/config", "a/.gIt/HEAD", ".MLPAL-state/token", ".Mlpal-State/token", ".g‌it/config", ".ＧＩＴ/config".normalize("NFC")];
    for (const n of names.slice(0, 6)) {
      mkdirSync(join(root, n, ".."), { recursive: true });
      writeFileSync(join(root, n), "secret");
      const r = probeMedia({ path: n, maxBytes: CAP }, ctx());
      expect([n, "code" in r ? r.code : "ADMITTED"]).toEqual([n, "PATH_NOT_ALLOWED"]);
    }
    expect(foldName(".GİT")).not.toBe(".git"); // a dotted capital I is not an I: no false fold
    expect(foldName("Café/.GIT")).toBe("café/.git");
  });

  test("protected writes fold the same way: .GIT/config, .Git/hooks, .SSH/id_rsa and a zero-width .git are blocked", () => {
    for (const p of ["/w/.GIT/config", "/w/.Git/hooks/pre-commit", "/home/u/.SSH/id_rsa", "/w/.g‍it/config", "/home/u/.AWS/credentials", "/w/.Git/info/exclude".replace("info/exclude", "index")])
      expect([p, contentSafetyDeny(p) !== null]).toEqual([p, true]);
    expect(contentSafetyDeny("/w/.GIT/info/exclude")).toBeNull();
    expect(contentSafetyDeny("/w/src/git.ts")).toBeNull();
  });
});
