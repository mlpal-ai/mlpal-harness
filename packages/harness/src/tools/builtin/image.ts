import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  checkShowInput,
  DISPLAY_CATALOG,
  humanBytes,
  MEDIA_EXTENSION,
  sniffMedia,
  type DisplayEnvelope,
  type MediaProbeResult,
  type Usage,
} from "@mlpal/harness-protocol";
import { probeMedia } from "../../display/media";
import { ImageGatewayError, type ImageGateway, type ImageReference, type ImageResult } from "../../gateway/images";
import type { ModelInfo } from "../../registry/models";
import { contextRoots, defineTool, err, type Tool, type ToolContext, type ToolResult } from "../types";

/**
 * GenerateImage (WAVE-2-IMAGES-AND-FILES §2): an image from a prompt and up to four reference images in the
 * workspace, made on the gateway with the engine's own credential (no command ever sees it), written under
 * `media/<date>/` and shown as an engine-written `image` or `image_set` block.
 *
 * - References are checked as a media Show's files are (display/media.ts): inside the workspace, a regular file, at
 *   most 5 MiB, PNG, JPEG or WebP by its bytes.
 * - It is always put to the person for more than one image, hd, or an estimate over the HOP's threshold
 *   (`alwaysAsk`); otherwise the mode decides.
 * - The gateway's job form with the tool-use id as the idempotency key: a retried call never pays twice.
 * - Each result is downloaded within its hour (at most 50 MiB, 60 s, its type by magic number) and written by a
 *   temp file and a link, never over an existing file.
 * - Typed errors: IMAGE_NOT_PERMITTED, IMAGE_REFUSED, IMAGE_BUDGET, IMAGE_TIMEOUT, IMAGE_FAILED, and the media codes
 *   for the references.
 */

export interface GenerateImageDeps {
  images: ImageGateway;
  /** The gateway's image models (operation image_generation), for `model` and the listing's names. */
  models: () => ModelInfo[];
  /** The estimated compute units of a call, from the model's pricing; null when unknown (then only the mode asks). */
  estimate?: (model: string, n: number, quality: string) => number | null;
  /** The HOP's `budgets.imageAskOverCu`: an estimate above it is always asked. Default 0.05. */
  askOverCu?: number;
  /** Seams for tests. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval and the longest a render may take. Defaults 2 s and 10 min. */
  pollMs?: number;
  timeoutMs?: number;
}

const L = {
  prompt: 4_000,
  references: 4,
  referenceBytes: 5 * 1024 * 1024,
  resultBytes: 50 * 1024 * 1024,
  downloadMs: 60_000,
} as const;
const REFERENCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const RESULT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const SIZE = /^(?:square|landscape|portrait|wide|tall|auto|\d{1,2}:\d{1,2}|\d{2,5}x\d{2,5})$/;

const inputSchema = z
  .object({
    prompt: z.string().min(1).max(L.prompt).describe("what to make, in words; for an edit, what to change and what to keep"),
    references: z.array(z.string().min(1).max(4_096)).max(L.references).optional().describe("up to 4 workspace images to work from (what the person attached is under uploads/)"),
    n: z.number().int().min(1).max(4).optional().describe("how many images; 1 unless the person asked for options"),
    size: z.string().regex(SIZE).optional().describe('default "1024x1024"; or square, landscape, portrait, a ratio such as 16:9'),
    quality: z.enum(["standard", "hd"]).optional().describe('default "standard"; "hd" costs more'),
    model: z.string().min(1).max(120).optional().describe('default "mlpal" (the gateway picks); ListModels with operation image_generation names the others'),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/).optional().describe("the file's stem; default from the prompt"),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;

/** A typed refusal: its first line is what the model reads and repairs from. */
function refuse(code: string, message: string, hint?: string): ToolResult {
  return err(`${JSON.stringify({ error: code, message, ...(hint ? { hint } : {}) })}\n${message}${hint ? `\n${hint}` : ""}`);
}

/** A file stem from words: lowercase letters, digits and hyphens, at most 40. */
function stemOf(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s || "image";
}

/** Why this call must be asked, whatever the mode, or null. */
export function imageAskReason(input: Partial<Input>, deps: Pick<GenerateImageDeps, "estimate" | "askOverCu">): string | null {
  const n = input.n ?? 1;
  const quality = input.quality ?? "standard";
  const model = input.model ?? "mlpal";
  const est = deps.estimate?.(model, n, quality) ?? null;
  const over = est !== null && est > (deps.askOverCu ?? 0.05);
  const why = [n > 1 ? `${n} images` : null, quality === "hd" ? "hd quality" : null, over ? `an estimated ${est!.toFixed(3)} CU (over ${deps.askOverCu ?? 0.05})` : null].filter(Boolean);
  return why.length ? `GenerateImage: ${why.join(", ")}${est !== null ? `, estimated ${est.toFixed(3)} CU` : ""}` : null;
}

export function createGenerateImageTool(deps: GenerateImageDeps): Tool<Input> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? 2_000;
  const timeoutMs = deps.timeoutMs ?? 600_000;

  async function references(paths: string[], ctx: ToolContext): Promise<ImageReference[] | ToolResult> {
    const out: ImageReference[] = [];
    const faults: string[] = [];
    for (const p of paths) {
      const f: MediaProbeResult = probeMedia({ path: p, maxBytes: L.referenceBytes }, ctx);
      if ("code" in f) {
        faults.push(`${f.code} references: ${f.message}`);
        continue;
      }
      if (!REFERENCE_TYPES.has(f.mime)) {
        faults.push(`MEDIA_TYPE_NOT_ALLOWED references: ${f.path} is ${f.mime}; a reference is PNG, JPEG or WebP`);
        continue;
      }
      const bytes = readFileSync(join(contextRoots(ctx)[0]!, f.path));
      if (createHash("sha256").update(bytes).digest("hex") !== f.sha256) {
        faults.push(`MEDIA_CHANGED references: ${f.path} changed while it was read`);
        continue;
      }
      out.push({ base64: bytes.toString("base64"), mime_type: f.mime });
    }
    if (faults.length) {
      const first = faults[0]!.split(" ")[0]!;
      return refuse(first, faults.join("\n"), "give the workspace path of each image (what the person attached is under uploads/)");
    }
    return out;
  }

  /** The render: submit with the tool-use id as the idempotency key, then poll the job. */
  async function render(input: Input, refs: ImageReference[], key: string, signal?: AbortSignal): Promise<ImageResult | ToolResult> {
    const req = { prompt: input.prompt, model: input.model ?? "mlpal", n: input.n ?? 1, size: input.size ?? "1024x1024", quality: input.quality ?? "standard", ...(refs.length ? { reference_images: refs } : {}) };
    try {
      const submitted = await deps.images.submit(req, { idempotencyKey: key, ...(signal ? { signal } : {}) });
      if ("result" in submitted) return submitted.result;
      let job = submitted.job;
      const deadline = now().getTime() + timeoutMs;
      while (job.status === "queued" || job.status === "running") {
        if (now().getTime() >= deadline) return refuse("IMAGE_TIMEOUT", `the image was not ready after ${Math.round(timeoutMs / 60_000)} minutes`, "try again later, or a smaller size");
        await sleep(pollMs);
        job = await deps.images.job(job.id, signal);
      }
      if (job.status === "succeeded") return job.result;
      if (job.status !== "failed") return refuse("IMAGE_FAILED", `the render ended as ${String((job as { status: unknown }).status)}`);
      const e = job.error;
      if (e.code === "provider_error") return refuse("IMAGE_REFUSED", `the image provider refused: ${e.message.slice(0, 300)}`, "say so in plain words and suggest a change to the prompt; do not retry the same prompt");
      if (e.code === "worker_lost") return refuse("IMAGE_FAILED", "the render was lost on the gateway; nothing was billed", "try again once");
      return refuse("IMAGE_FAILED", `the gateway could not make it: ${e.message.slice(0, 300)}`);
    } catch (e) {
      if (!(e instanceof ImageGatewayError)) return refuse("IMAGE_FAILED", `the gateway could not be reached: ${(e as Error).message.slice(0, 200)}`);
      if (e.status === 403) return refuse("IMAGE_NOT_PERMITTED", "this workspace's gateway key may not make images", "tell the person images are not enabled for this workspace yet");
      if (e.status === 402 || e.status === 429) return refuse("IMAGE_BUDGET", `the spend cap or the wallet stops it: ${e.message.slice(0, 200)}`, "tell the person; do not retry");
      if (e.status === 409) return refuse("IMAGE_FAILED", "this call's id was already used for a different request", "change nothing and answer in text");
      return refuse("IMAGE_FAILED", `the gateway answered ${e.status}: ${e.message.slice(0, 200)}`);
    }
  }

  /** Download each result and write it under media/<date>/, never over an existing file. */
  async function store(result: ImageResult, stem: string, ctx: ToolContext, signal?: AbortSignal): Promise<string[] | ToolResult> {
    const workspace = contextRoots(ctx)[0]!;
    const day = now().toISOString().slice(0, 10);
    const dirRel = `media/${day}`;
    const dir = join(workspace, "media", day);
    try {
      mkdirSync(dir, { recursive: true });
      const real = relative(realpathSync(workspace), realpathSync(dir));
      if (real !== join("media", day)) return refuse("IMAGE_FAILED", `${dirRel} is not a plain folder in the workspace`, "remove the link at media/ and try again");
    } catch (e) {
      return refuse("IMAGE_FAILED", `${dirRel} could not be made: ${(e as Error).message.slice(0, 200)}`);
    }
    const written: string[] = [];
    for (const [i, image] of result.data.entries()) {
      let bytes: Uint8Array;
      try {
        bytes = await deps.images.download(image.url, { maxBytes: L.resultBytes, timeoutMs: L.downloadMs, ...(signal ? { signal } : {}) });
      } catch (e) {
        const status = e instanceof ImageGatewayError ? e.status : 0;
        return refuse("IMAGE_FAILED", status === 403 ? "the image's link expired before it was saved" : `the image could not be saved: ${(e as Error).message.slice(0, 200)}`, "make it again");
      }
      const mime = sniffMedia(bytes);
      if (!mime || !RESULT_TYPES.has(mime)) return refuse("IMAGE_FAILED", "the gateway returned something that is not a PNG, JPEG, WebP or GIF image");
      const ext = MEDIA_EXTENSION[mime]!;
      const tmp = join(dir, `.${stem}.${randomBytes(6).toString("hex")}.tmp`);
      const fd = openSync(tmp, "wx", 0o644);
      try {
        writeSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // link() refuses an existing name, so no file is ever replaced; the next free suffix is taken instead
      let name = "";
      for (let k = 0; k < 1000 && !name; k++) {
        const candidate = `${stem}-${i + 1}${k ? `-${k + 1}` : ""}.${ext}`;
        try {
          linkSync(tmp, join(dir, candidate));
          name = candidate;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
            unlinkSync(tmp);
            return refuse("IMAGE_FAILED", `the image could not be written: ${(e as Error).message.slice(0, 200)}`);
          }
        }
      }
      unlinkSync(tmp);
      if (!name) return refuse("IMAGE_FAILED", `no free file name under ${dirRel} for ${stem}`);
      if (lstatSync(join(dir, name)).isSymbolicLink()) return refuse("IMAGE_FAILED", "the written file is a link");
      written.push(`${dirRel}/${name}`);
    }
    return written;
  }

  return defineTool<Input>({
    name: "GenerateImage",
    hands: "local",
    description:
      "Make an image from a prompt, optionally from up to 4 reference images in the workspace (what the person attached is under uploads/). " +
      "It is written under media/<date>/ and shown to the person; you read where it is, its size and its cost. Make one image unless the person asks for options. " +
      "More than one image, hd, or a costly model always asks the person first.",
    readOnly: false,
    edits: true,
    schema: inputSchema,
    alwaysAsk: (input) => imageAskReason((input ?? {}) as Partial<Input>, deps),
    async call(input, ctx) {
      const model = input.model ?? "mlpal";
      if (model !== "mlpal" && !deps.models().some((m) => m.tag === model && m.capabilities.operation === "image_generation")) {
        const names = deps.models().filter((m) => m.capabilities.operation === "image_generation").map((m) => m.tag);
        return refuse("IMAGE_FAILED", `"${model}" is not an image model this gateway serves`, names.length ? `image models: mlpal, ${names.join(", ")}` : 'use "mlpal"');
      }
      const refs = await references(input.references ?? [], ctx);
      if (!Array.isArray(refs)) return refs;
      const key = ctx.toolUseId ?? `generate-image-${randomBytes(8).toString("hex")}`;
      const result = await render(input, refs, key, ctx.signal);
      if (!("data" in result)) return result;
      if (!result.data.length) return refuse("IMAGE_FAILED", "the gateway returned no image");
      const written = await store(result, stemOf(input.name ?? input.prompt), ctx, ctx.signal);
      if (!Array.isArray(written)) return written;
      return shown(input, result, written, key, ctx);
    },
  });
}

/** The step: what the model reads, and the engine-written image or image_set block. */
function shown(input: Input, result: ImageResult, paths: string[], key: string, ctx: ToolContext): ToolResult {
  const cu = result.cost.compute_units;
  const model = result.routing?.selected_model ?? result.cost.model_name ?? result.model;
  const revised = result.data[0]?.revised_prompt ?? undefined;
  const alt = (revised ?? input.prompt).replace(/\s+/g, " ").slice(0, 300);
  const made_by = { kind: "generated" as const, model: model.slice(0, 120), prompt: input.prompt, ...(revised ? { revised_prompt: revised.slice(0, 4_000) } : {}), compute_units: cu };
  const media = new Map(paths.map((p) => [p, probeMedia({ path: p, maxBytes: L.resultBytes }, ctx)]));
  const blockId = `image-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
  const kind = paths.length === 1 ? "image" : "image_set";
  const spec = kind === "image" ? { path: paths[0], alt, made_by } : { images: paths.map((p) => ({ path: p, alt })), made_by };
  const lead = `Made with ${model} from the prompt: ${input.prompt.replace(/\s+/g, " ").slice(0, 500)}${revised ? `\nAs the model read it: ${revised.replace(/\s+/g, " ").slice(0, 500)}` : ""}\nCost: ${cu} CU.`;
  const check = checkShowInput({ block_id: blockId, kind, spec, fallback: { text: lead } }, { kinds: new Set([kind]), media });
  const usage: Usage = { input_tokens: result.cost.input_tokens ?? 0, output_tokens: result.cost.output_tokens ?? 0, compute_units: cu };
  const sizes = paths.map((p) => {
    const f = media.get(p)!;
    return "code" in f ? p : `${p} (${f.width ?? "?"}×${f.height ?? "?"}, ${humanBytes(f.bytes)})`;
  });
  const line = `wrote ${sizes.join(", ")}; ${cu} CU`;
  if (!check.ok) {
    // the files are written; only the block failed its own checks (an image the probe cannot read): say where they are
    return { content: `${line}\n(not shown as a block: ${check.error.code} ${check.error.message})`, meta: { usage } };
  }
  const v = check.show;
  const envelope = { v: 1, block_id: blockId, revision: 1, op: "snapshot", level: "block", kind: v.kind, catalog: DISPLAY_CATALOG, spec: v.spec, fallback: { text: v.fallback }, source: { by: "engine", tool_use_ids: [key] }, status: "ok" } as DisplayEnvelope;
  return { content: line, meta: { display: [envelope], displayText: `${line}\n${v.fallback}`, usage } };
}
