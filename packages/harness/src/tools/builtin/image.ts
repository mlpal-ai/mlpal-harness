import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  checkShowInput,
  DISPLAY_CATALOG,
  humanBytes,
  MEDIA_EXTENSION,
  sniffMedia,
  type DisplayEnvelope,
  type ImageAskDetail,
} from "@mlpal/harness-protocol";
import { probeMedia, readMedia } from "../../display/media";
import { ImageGatewayError, type ImageGateway, type ImageJob, type ImagePrice, type ImageReference, type ImageResult } from "../../gateway/images";
import type { ModelInfo } from "../../registry/models";
import { contextRoots, defineTool, err, type Tool, type ToolContext, type ToolResult } from "../types";

/**
 * GenerateImage (WAVE-2-IMAGES-AND-FILES §2): an image from a prompt and up to four reference images in the
 * workspace, made on the gateway with the engine's own credential (no command ever sees it), written under
 * `media/<date>/` and shown as an engine-written `image` or `image_set` block.
 *
 * - References are checked as a media Show's files are (display/media.ts): inside the workspace, a regular file, at
 *   most 5 MiB, PNG, JPEG or WebP by its bytes. The bytes sent are the bytes checked: one bounded read of the
 *   verified descriptor.
 * - It is always put to the person (`alwaysAsk`) for more than one image, hd, an estimate over the HOP's threshold,
 *   or a cost that is not known before the render.
 * - Everything that can refuse locally (the folder, the free space) is checked before the job is created.
 * - The gateway's job form with the tool-use id as the idempotency key: a retried call never pays twice.
 * - The spend is recorded (`ctx.spend`) the moment the gateway reports the charge, whatever happens after; a paid
 *   image that cannot be saved is IMAGE_NOT_SAVED, with the job id and what was saved.
 * - Each result is downloaded within its hour (at most 50 MiB, 60 s, only from the gateway's asset origin, its type
 *   by magic number before anything is written) and written by a temp file and a link, never over an existing file.
 * - Typed errors: IMAGE_NOT_PERMITTED, IMAGE_REFUSED, IMAGE_BUDGET, IMAGE_TIMEOUT, IMAGE_FAILED, IMAGE_NOT_SAVED, and
 *   the media codes for the references.
 */

/** What a call would make, for its estimate. */
export interface ImageEstimateQuery {
  model: string;
  n: number;
  quality: string;
  size: string;
  references: number;
}

export interface GenerateImageDeps {
  images: ImageGateway;
  /** The gateway's image models (operation image_generation), for `model` and the listing's names. */
  models: () => ModelInfo[];
  /** The image models' prices (`loadImagePrices`), for the default estimate. */
  prices?: () => ReadonlyMap<string, ImagePrice>;
  /** The estimated compute units of a call, or null when the price is known only after the render (then it is
   *  asked). Default: `estimateFromPrices` over `prices` and `models`. */
  estimate?: (q: ImageEstimateQuery) => number | null;
  /** The HOP's `budgets.imageAskOverCu`: an estimate above it is always asked. Default IMAGE_ASK_OVER_CU. */
  askOverCu?: number;
  /** Seams for tests. */
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval and the longest a render may take. Defaults 2 s and 10 min. */
  pollMs?: number;
  timeoutMs?: number;
  /** How long after its request a call whose engine died before the gateway named its job may submit the same request
   *  under the same idempotency key again (the gateway answers with the original job). Default RESUBMIT_WITHIN_MS. */
  resubmitWithinMs?: number;
  /** A non-secret fingerprint of the user who pays (the host's account id), when the host knows it. A resumed call
   *  never repeats a submit for a different payer: the gateway's idempotency is per user, so it would bill twice. */
  payer?: () => string | undefined;
}

/**
 * The engine's own bound on repeating a submit under its idempotency key: 24 hours. The gateway keeps the key's job
 * for as long as the row exists (mlpal-assistants-service image_jobs: a unique index on (user_id, idempotency_key),
 * no expiry, no sweeper), scoped to the user, not the API key, so a workspace's new key at wake keeps it. The engine
 * stays well inside that, so a sweeper added there later cannot turn a replay into a second render unnoticed.
 */
export const RESUBMIT_WITHIN_MS = 24 * 60 * 60 * 1000;

/** The threshold when the HOP sets none: 0.02 CU (US$0.20 at 1 CU = US$10), under one image of the dearer per-image
 *  models the gateway lists, so one of those is asked. */
export const IMAGE_ASK_OVER_CU = 0.02;

const L = {
  prompt: 4_000,
  references: 4,
  referenceBytes: 5 * 1024 * 1024,
  resultBytes: 50 * 1024 * 1024,
  downloadMs: 60_000,
  pollBackoffMs: 30_000,
} as const;
const REFERENCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const RESULT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const SIZE = /^(?:square|landscape|portrait|wide|tall|auto|\d{1,2}:\d{1,2}|\d{2,5}x\d{2,5})$/;

const inputSchema = z
  .object({
    prompt: z.string().min(1).max(L.prompt).optional().describe("what to make, in words; for an edit, what to change and what to keep (required unless job is given)"),
    job: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional().describe("only after IMAGE_NOT_SAVED: that error's job id, to save the same images again without a new render or charge"),
    references: z.array(z.string().min(1).max(4_096)).max(L.references).optional().describe("up to 4 workspace images to work from (what the person attached is under uploads/)"),
    n: z.number().int().min(1).max(4).optional().describe("how many images; 1 unless the person asked for options"),
    size: z.string().regex(SIZE).optional().describe('default "1024x1024"; or square, landscape, portrait, a ratio such as 16:9'),
    quality: z.enum(["standard", "hd"]).optional().describe('default "standard"; "hd" costs more'),
    model: z.string().min(1).max(120).optional().describe('default "mlpal" (the gateway picks); ListModels with operation image_generation names the others'),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/).optional().describe("the file's stem; default from the prompt"),
  })
  .strict()
  .refine((v) => v.job !== undefined || v.prompt !== undefined, { message: "prompt is required (or job, to save an unsaved render)", path: ["prompt"] });
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

/**
 * The estimate the gateway's prices allow: a `per_image` model costs n × its rate (the gateway bills images as input
 * units, whatever the size or quality). A token-priced model, an unpriced one, and "mlpal" when any model the router
 * may pick is not per-image priced, are null: known only after the render.
 */
export function estimateFromPrices(prices: ReadonlyMap<string, ImagePrice>, models: readonly ModelInfo[]): (q: ImageEstimateQuery) => number | null {
  const perImage = (tag: string): number | null => {
    const p = prices.get(tag);
    return p && p.rateUnit === "per_image" ? p.inputCuRate : null;
  };
  return (q) => {
    if (q.model !== "mlpal") {
      const rate = perImage(q.model);
      return rate === null ? null : q.n * rate;
    }
    const rates = models.filter((m) => m.capabilities.operation === "image_generation").map((m) => perImage(m.tag));
    if (!rates.length || rates.some((r) => r === null)) return null;
    return q.n * Math.max(...(rates as number[]));
  };
}

/** A call's estimated compute units, or null when the price is known only after the render. */
function estimateOf(input: Partial<Input>, deps: Partial<Pick<GenerateImageDeps, "estimate" | "prices" | "models">>): { q: ImageEstimateQuery; est: number | null } {
  const q: ImageEstimateQuery = { model: input.model ?? "mlpal", n: input.n ?? 1, quality: input.quality ?? "standard", size: input.size ?? "1024x1024", references: input.references?.length ?? 0 };
  const estimate = deps.estimate ?? estimateFromPrices(deps.prices?.() ?? new Map(), deps.models?.() ?? []);
  return { q, est: estimate(q) };
}

type AskReason = ImageAskDetail["reasons"][number];

/** Why a call is always asked, as flags, with its estimate: what imageAskReason words and the ask detail carries. */
function askReasons(input: Partial<Input>, deps: Partial<Pick<GenerateImageDeps, "estimate" | "askOverCu" | "prices" | "models">>): { q: ImageEstimateQuery; est: number | null; limit: number; reasons: AskReason[] } {
  const { q, est } = estimateOf(input, deps);
  const limit = deps.askOverCu ?? IMAGE_ASK_OVER_CU;
  const reasons: AskReason[] = [];
  if (q.n > 1) reasons.push("several_images");
  if (q.quality === "hd") reasons.push("hd");
  if (est === null) reasons.push("no_estimate");
  else if (est > limit) reasons.push("over_threshold");
  return { q, est, limit, reasons };
}

/** Why this call must be asked, whatever the mode, or null. Fails closed: no estimate is an ask. */
export function imageAskReason(input: Partial<Input>, deps: Partial<Pick<GenerateImageDeps, "estimate" | "askOverCu" | "prices" | "models">>): string | null {
  const { q, est, limit, reasons } = askReasons(input, deps);
  const words: Record<AskReason, string> = {
    several_images: `${q.n} images`,
    hd: "hd quality",
    no_estimate: `the cost of ${q.model} is known only after the render`,
    over_threshold: `an estimated ${(est ?? 0).toFixed(3)} CU (over ${limit})`,
  };
  return reasons.length ? `GenerateImage: ${reasons.map((r) => words[r]).join(", ")}${est !== null ? `, estimated ${est.toFixed(3)} CU` : ""}` : null;
}

/** The ask's detail for the approval card: exactly what `call` submits (the same defaults), where it writes, and why
 *  it asks. Null for a re-save by job id, which costs nothing. */
export function imageAskDetail(input: Partial<Input>, deps: Partial<Pick<GenerateImageDeps, "estimate" | "askOverCu" | "prices" | "models" | "now">>): ImageAskDetail | null {
  if (input.job) return null;
  const { q, est, reasons } = askReasons(input, deps);
  const day = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10);
  return {
    kind: "generate_image",
    count: q.n,
    size: q.size,
    quality: q.quality === "hd" ? "hd" : "standard",
    model: q.model,
    routed: q.model === "mlpal",
    destination: `media/${day}`,
    references: input.references ?? [],
    ...(est !== null ? { estimateCu: est } : {}),
    reasons,
  };
}

/** A render the gateway finished: the result and the job it came from. */
interface Rendered {
  result: ImageResult;
  jobId: string;
}

export function createGenerateImageTool(deps: GenerateImageDeps): Tool<Input> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? 2_000;
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const resubmitWithinMs = deps.resubmitWithinMs ?? RESUBMIT_WITHIN_MS;

  function references(paths: string[], ctx: ToolContext): (ImageReference & { path: string; sha256: string })[] | ToolResult {
    const out: (ImageReference & { path: string; sha256: string })[] = [];
    const faults: string[] = [];
    for (const p of paths) {
      const f = readMedia({ path: p, maxBytes: L.referenceBytes }, ctx);
      if ("code" in f) {
        faults.push(`${f.code} references: ${f.message}`);
        continue;
      }
      if (!REFERENCE_TYPES.has(f.facts.mime)) {
        faults.push(`MEDIA_TYPE_NOT_ALLOWED references: ${f.facts.path} is ${f.facts.mime}; a reference is PNG, JPEG or WebP`);
        continue;
      }
      out.push({ base64: Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength).toString("base64"), mime_type: f.facts.mime, path: f.facts.path, sha256: f.facts.sha256 });
    }
    if (faults.length) {
      const first = faults[0]!.split(" ")[0]!;
      return refuse(first, faults.join("\n"), "give the workspace path of each image (what the person attached is under uploads/)");
    }
    return out;
  }

  /**
   * media/<date>/ as plain folders in the workspace, made one level at a time and never through a link, with room for
   * every result: checked before anything is paid for.
   */
  function destination(ctx: ToolContext, n: number): { dir: string; dirRel: string } | ToolResult {
    const workspace = contextRoots(ctx)[0]!;
    const day = now().toISOString().slice(0, 10);
    const dirRel = `media/${day}`;
    let dir: string;
    try {
      dir = realpathSync(workspace);
      for (const part of ["media", day]) {
        dir = join(dir, part);
        try {
          mkdirSync(dir);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
        const st = lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) return refuse("IMAGE_FAILED", `${dirRel} is not a plain folder in the workspace`, "nothing was paid for; remove the link or file at media/ and try again");
      }
      if (relative(realpathSync(workspace), realpathSync(dir)) !== join("media", day)) return refuse("IMAGE_FAILED", `${dirRel} is not a plain folder in the workspace`, "nothing was paid for; remove the link at media/ and try again");
    } catch (e) {
      return refuse("IMAGE_FAILED", `${dirRel} could not be made: ${(e as Error).message.slice(0, 200)}`, "nothing was paid for");
    }
    const denied = ctx.exec?.writeDenied?.(join(dir, "image.png"));
    if (denied) return refuse("IMAGE_FAILED", `${dirRel} may not be written: ${denied.slice(0, 200)}`, "nothing was paid for");
    try {
      const fs = statfsSync(dir);
      if (fs.bavail * fs.bsize < n * L.resultBytes) return refuse("IMAGE_FAILED", `not enough free space under ${dirRel} for ${n} image${n > 1 ? "s" : ""}`, "nothing was paid for; tell the person the disk is full");
    } catch (e) {
      return refuse("IMAGE_FAILED", `the free space under ${dirRel} could not be read: ${(e as Error).message.slice(0, 200)}`, "nothing was paid for");
    }
    return { dir, dirRel };
  }

  /** The render: submit with the tool-use id as the idempotency key (`onJob` records the job id durably the moment the
   *  gateway names it), then poll the job until it ends or the deadline. */
  async function render(prompt: string, input: Input, refs: ImageReference[], key: string, onJob: (id: string) => Promise<void>, signal?: AbortSignal): Promise<Rendered | ToolResult> {
    const req = { prompt, model: input.model ?? "mlpal", n: input.n ?? 1, size: input.size ?? "1024x1024", quality: input.quality ?? "standard", ...(refs.length ? { reference_images: refs.map(({ base64, mime_type }) => ({ base64, mime_type })) } : {}) };
    let submitted;
    try {
      submitted = await deps.images.submit(req, { idempotencyKey: key, ...(signal ? { signal } : {}) });
    } catch (e) {
      return submitRefusal(e);
    }
    if ("result" in submitted) return { result: submitted.result, jobId: key };
    await onJob(submitted.job.id);
    return poll(submitted.job, signal);
  }

  /** A job polled until it ends or the deadline; never a submit. */
  async function poll(first: ImageJob, signal?: AbortSignal): Promise<Rendered | ToolResult> {
    let job = first;
    const pending = (why: string) =>
      refuse("IMAGE_TIMEOUT", `${why}; job ${job.id} may still finish and bill`, `tell the person the job id (${job.id}); GenerateImage {job: "${job.id}"} saves it once it is done and records its charge then. Do not make it again, which would pay a second time`);
    const deadline = now().getTime() + timeoutMs;
    let wait = pollMs;
    while (job.status === "queued" || job.status === "running") {
      if (signal?.aborted) return pending("the call was stopped while the image was being made");
      if (now().getTime() >= deadline) return pending(`the image was not ready after ${Math.round(timeoutMs / 60_000)} minutes`);
      await sleep(wait);
      try {
        job = await deps.images.job(job.id, signal);
        wait = pollMs;
      } catch {
        // the job is the gateway's and bills on whatever the poll met: keep asking, more slowly, until the deadline
        wait = Math.min(wait * 2, L.pollBackoffMs);
      }
    }
    if (job.status === "succeeded") return { result: job.result, jobId: job.id };
    if (job.status !== "failed") return refuse("IMAGE_FAILED", `the render ended as ${String((job as { status: unknown }).status)}`);
    const e = job.error;
    if (e.code === "provider_error") return refuse("IMAGE_REFUSED", `the image provider refused: ${e.message.slice(0, 300)}`, "say so in plain words and suggest a change to the prompt; do not retry the same prompt");
    if (e.code === "worker_lost") return refuse("IMAGE_FAILED", "the render was lost on the gateway; nothing was billed", "try again once");
    return refuse("IMAGE_FAILED", `the gateway could not make it: ${e.message.slice(0, 300)}`);
  }

  /** A finished render: its charge on record (at most once per call), then its files saved and shown. */
  async function finish(rendered: Rendered, o: { prompt: string; stem: string; key: string; charge: boolean }, ctx: ToolContext): Promise<ToolResult> {
    const { result, jobId } = rendered;
    // the charge is recorded where the engine first learns of it, on any path, once per job (review R5b)
    if (o.charge) await ctx.spend?.({ input_tokens: result.cost.input_tokens ?? 0, output_tokens: result.cost.output_tokens ?? 0, compute_units: result.cost.compute_units }, { once: `job:${jobId}` });
    if (!result.data.length) return notSaved(result, jobId, [], "the gateway returned no image");
    const where = destination(ctx, result.data.length);
    if (!("dir" in where)) return notSaved(result, jobId, [], "media/<date> could not be used");
    const { written, failure } = await store(result, o.stem, where, ctx.signal);
    if (failure) return notSaved(result, jobId, written, failure);
    return shown(o.prompt, result, written, o.key, ctx);
  }

  /** A request whose job the gateway never named before its engine died: the same request under the same key, inside
   *  the window, else the charge as an unconfirmed estimate. */
  async function resubmit(asked: Record<string, unknown>, input: Input, ctx: ToolContext): Promise<ToolResult> {
    const at = typeof asked.at === "string" ? Date.parse(asked.at) : NaN;
    const key = String(asked.key);
    const prompt = typeof asked.prompt === "string" ? asked.prompt : "";
    if (!Number.isFinite(at) || now().getTime() - at > resubmitWithinMs || !prompt) return unconfirmed(asked, ctx, "too long ago to ask the gateway again under its key");
    // a session cannot change owner: if the engine can tell the payer differs, the key's idempotency is not this user's
    const payer = deps.payer?.();
    if (typeof asked.payer === "string" && payer !== undefined && payer !== asked.payer) return unconfirmed(asked, ctx, "the paying user is not the one who made the request");
    const files = Array.isArray(asked.references) ? (asked.references as Array<{ path: string; sha256: string }>) : [];
    const refs = references(files.map((f) => f.path), ctx);
    if (!Array.isArray(refs) || refs.some((r, i) => r.sha256 !== files[i]!.sha256)) return unconfirmed(asked, ctx, "a reference image changed since, so the same request cannot be made again");
    const again: Input = { prompt, model: String(asked.model ?? "mlpal"), n: Number(asked.n ?? 1), size: String(asked.size ?? "1024x1024"), quality: (asked.quality === "hd" ? "hd" : "standard") as Input["quality"] };
    const where = destination(ctx, again.n ?? 1);
    if (!("dir" in where)) return where;
    const rendered = await render(prompt, again, refs, key, async (id) => ctx.journal?.append({ phase: "job", jobId: id }), ctx.signal);
    if (!("result" in rendered)) {
      // a 409: the key's job exists with another body; whether it billed cannot be told from here
      return String(rendered.content).includes("already used for a different request") ? unconfirmed(asked, ctx, "the gateway holds another request under this key") : rendered;
    }
    return finish(rendered, { prompt, stem: typeof asked.stem === "string" ? asked.stem : stemOf(input.name ?? prompt), key, charge: true }, ctx);
  }

  /** A charge that may have happened and cannot be confirmed: on the session as a flagged estimate, said once. */
  async function unconfirmed(asked: Record<string, unknown>, ctx: ToolContext, why: string): Promise<ToolResult> {
    const est = typeof asked.estimate === "number" ? asked.estimate : null;
    // with no estimate the amount is unknown, never zero: counted as an unpriced charge (review O-b)
    await ctx.spend?.({ input_tokens: 0, output_tokens: 0, ...(est !== null ? { compute_units_unconfirmed: est } : { unpriced_charges: 1 }) }, { once: `unconfirmed:${String(asked.key)}` });
    return refuse(
      "IMAGE_UNCONFIRMED",
      `the engine stopped while an image was being requested at ${String(asked.at ?? "an unknown time")} (key ${String(asked.key)}), and it was not asked again (${why}). It may have been charged${est !== null ? `, an estimated ${est.toFixed(3)} CU` : ", an unknown amount (its price is known only after a render)"}; that could not be confirmed, and the gateway has no lookup that could confirm it later. Nothing was saved.`,
      "tell the person this once, with the time and the estimate; making it again may pay a second time, so only on their word",
    );
  }

  /** This call's journal entries (what it asked for, and its job once the gateway named it). */
  async function entriesOf(ctx: ToolContext): Promise<{ asked?: Record<string, unknown>; jobId?: string }> {
    const mine = ((await ctx.journal?.read()) ?? []).filter((e) => e.toolUseId === ctx.toolUseId);
    const asked = mine.find((e) => e.data.phase === "asked")?.data;
    const jobId = mine.find((e) => e.data.phase === "job" && typeof e.data.jobId === "string")?.data.jobId as string | undefined;
    return { ...(asked ? { asked } : {}), ...(jobId ? { jobId } : {}) };
  }

  /** A job this session created, saved again: the gateway keeps the job, and nothing is submitted or charged. */
  async function saveAgain(jobId: string, input: Input, ctx: ToolContext): Promise<ToolResult> {
    const journal = (await ctx.journal?.read()) ?? [];
    const own = journal.find((e) => e.data.phase === "job" && e.data.jobId === jobId);
    if (!own) return refuse("IMAGE_FAILED", `job ${jobId} is not one this session made`, "give the job id from this session's IMAGE_NOT_SAVED");
    const asked = journal.find((e) => e.toolUseId === own.toolUseId && e.data.phase === "asked")?.data ?? {};
    let job: ImageJob;
    try {
      job = await deps.images.job(jobId, ctx.signal);
    } catch (e) {
      return refuse("IMAGE_FAILED", `job ${jobId} could not be read from the gateway: ${(e as Error).message.slice(0, 200)}`);
    }
    const rendered = await poll(job, ctx.signal);
    if (!("result" in rendered)) return rendered;
    const prompt = typeof asked.prompt === "string" ? asked.prompt : "an image made earlier in this session";
    // a timed-out or stopped call never learned the charge: this one may be the first to (once per job)
    return finish(rendered, { prompt, stem: stemOf(input.name ?? (typeof asked.stem === "string" ? asked.stem : prompt)), key: ctx.toolUseId ?? jobId, charge: true }, ctx);
  }

  /** Download each result and write it into `dir`, never over an existing file. Stops at the first failure and says
   *  what was written before it. */
  async function store(result: ImageResult, stem: string, where: { dir: string; dirRel: string }, signal?: AbortSignal): Promise<{ written: string[]; failure?: string }> {
    const { dir, dirRel } = where;
    const written: string[] = [];
    for (const [i, image] of result.data.entries()) {
      let bytes: Uint8Array;
      try {
        bytes = await deps.images.download(image.url, { maxBytes: L.resultBytes, timeoutMs: L.downloadMs, ...(signal ? { signal } : {}) });
      } catch (e) {
        const status = e instanceof ImageGatewayError ? e.status : 0;
        return { written, failure: status === 403 ? "the image's link expired before it was saved" : `the image could not be downloaded: ${(e as Error).message.slice(0, 200)}` };
      }
      const mime = sniffMedia(bytes);
      if (!mime || !RESULT_TYPES.has(mime)) return { written, failure: "the gateway returned something that is not a PNG, JPEG, WebP or GIF image" };
      const ext = MEDIA_EXTENSION[mime]!;
      const tmp = join(dir, `.${stem}.${randomBytes(6).toString("hex")}.tmp`);
      let name = "";
      try {
        const fd = openSync(tmp, "wx", 0o644);
        try {
          writeSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        // link() refuses an existing name, so no file is ever replaced; the next free suffix is taken instead
        for (let k = 0; k < 1000 && !name; k++) {
          const candidate = `${stem}-${i + 1}${k ? `-${k + 1}` : ""}.${ext}`;
          try {
            linkSync(tmp, join(dir, candidate));
            name = candidate;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          }
        }
      } catch (e) {
        return { written, failure: `the image could not be written: ${(e as Error).message.slice(0, 200)}` };
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          // never made
        }
      }
      if (!name) return { written, failure: `no free file name under ${dirRel} for ${stem}` };
      written.push(`${dirRel}/${name}`);
    }
    return { written };
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
    // saving an unsaved render again costs nothing, so it is the mode's
    alwaysAsk: (input) => ((input as Partial<Input> | undefined)?.job ? null : imageAskReason((input ?? {}) as Partial<Input>, deps)),
    askDetail: (input) => imageAskDetail((input ?? {}) as Partial<Input>, deps),
    async call(input, ctx) {
      if (input.job) return saveAgain(input.job, input, ctx);
      const prompt = input.prompt!;
      const model = input.model ?? "mlpal";
      if (model !== "mlpal" && !deps.models().some((m) => m.tag === model && m.capabilities.operation === "image_generation")) {
        const names = deps.models().filter((m) => m.capabilities.operation === "image_generation").map((m) => m.tag);
        return refuse("IMAGE_FAILED", `"${model}" is not an image model this gateway serves`, names.length ? `image models: mlpal, ${names.join(", ")}` : 'use "mlpal"');
      }
      const refs = references(input.references ?? [], ctx);
      if (!Array.isArray(refs)) return refs;
      const where = destination(ctx, input.n ?? 1);
      if (!("dir" in where)) return where;
      const key = ctx.toolUseId ?? `generate-image-${randomBytes(8).toString("hex")}`;
      const stem = stemOf(input.name ?? prompt);
      // on record before anything can be paid for (review R5): what was asked, under which key
      // the exact request (its references by hash) and when, so a resumed engine can repeat it under the same key
      await ctx.journal?.append({
        phase: "asked",
        key,
        at: now().toISOString(),
        estimate: estimateOf(input, deps).est,
        model,
        n: input.n ?? 1,
        size: input.size ?? "1024x1024",
        quality: input.quality ?? "standard",
        stem,
        prompt,
        references: refs.map((r) => ({ path: r.path, sha256: r.sha256 })),
        ...(deps.payer?.() !== undefined ? { payer: deps.payer!() } : {}),
      });
      const rendered = await render(prompt, input, refs, key, async (jobId) => ctx.journal?.append({ phase: "job", jobId }), ctx.signal);
      if (!("result" in rendered)) return rendered;
      return finish(rendered, { prompt, stem, key, charge: true }, ctx);
    },
    /**
     * Resumed after its engine died mid-call (review R5): reconciled from the journal. With its job on record, the job is
     * polled; a finished one is charged once (the engine keeps one charge per call) and saved. With no job on record
     * the key is the lookup: within RESUBMIT_WITHIN_MS of the request, the same request under the same key is submitted
     * again, and the gateway answers with the original job if it arrived (no second charge) or makes it once if it never
     * did. Past that, or when the request can no longer be repeated exactly (a reference changed), nothing is submitted
     * and the charge is counted as an unconfirmed estimate.
     */
    async recover(input, ctx) {
      const { asked, jobId } = await entriesOf(ctx);
      if (!asked) return refuse("IMAGE_FAILED", "the engine stopped before the image was requested; nothing was made or paid", "make it again if the person still wants it");
      if (!jobId) return resubmit(asked, input, ctx);
      let job: ImageJob;
      try {
        job = await deps.images.job(jobId, ctx.signal);
      } catch (e) {
        return refuse("IMAGE_TIMEOUT", `job ${jobId} could not be read after the restart: ${(e as Error).message.slice(0, 200)}; it may still finish and bill`, `tell the person the job id (${jobId}); GenerateImage {job: "${jobId}"} saves it once it is done`);
      }
      const rendered = await poll(job, ctx.signal);
      if (!("result" in rendered)) return rendered;
      const prompt = typeof asked.prompt === "string" ? asked.prompt : input.prompt ?? "an image";
      return finish(rendered, { prompt, stem: typeof asked.stem === "string" ? asked.stem : stemOf(prompt), key: ctx.toolUseId ?? jobId, charge: true }, ctx);
    },
  });
}

/** A paid render that was not (all) saved: what it cost, the job, what was saved, and that making it again pays again. */
function notSaved(result: ImageResult, jobId: string, written: string[], failure: string): ToolResult {
  const cu = result.cost.compute_units;
  const saved = written.length ? `; saved before it failed: ${written.join(", ")}` : "; nothing was saved";
  return refuse(
    "IMAGE_NOT_SAVED",
    `the render was paid (${cu} CU, job ${jobId}) but ${result.data.length > 1 ? "not every image was" : "the image was not"} saved: ${failure}${saved}`,
    `GenerateImage {job: "${jobId}"} saves the same images again with no new render or charge, while the gateway still serves them: it keeps the job, but its image links expire one hour after the render (an inline result does not). After that, making it again pays a second time, so only on the person's word`,
  );
}

/** The step: what the model reads, and the engine-written image or image_set block. */
function shown(prompt: string, result: ImageResult, paths: string[], key: string, ctx: ToolContext): ToolResult {
  const cu = result.cost.compute_units;
  const model = result.routing?.selected_model ?? result.cost.model_name ?? result.model;
  const revised = result.data[0]?.revised_prompt ?? undefined;
  const alt = (revised ?? prompt).replace(/\s+/g, " ").slice(0, 300);
  const made_by = { kind: "generated" as const, model: model.slice(0, 120), prompt, ...(revised ? { revised_prompt: revised.slice(0, 4_000) } : {}), compute_units: cu };
  const media = new Map(paths.map((p) => [p, probeMedia({ path: p, maxBytes: L.resultBytes }, ctx)]));
  const blockId = `image-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
  const kind = paths.length === 1 ? "image" : "image_set";
  const spec = kind === "image" ? { path: paths[0], alt, made_by } : { images: paths.map((p) => ({ path: p, alt })), made_by };
  const lead = `Made with ${model} from the prompt: ${prompt.replace(/\s+/g, " ").slice(0, 500)}${revised ? `\nAs the model read it: ${revised.replace(/\s+/g, " ").slice(0, 500)}` : ""}\nCost: ${cu} CU.`;
  const check = checkShowInput({ block_id: blockId, kind, spec, fallback: { text: lead } }, { kinds: new Set([kind]), media });
  const sizes = paths.map((p) => {
    const f = media.get(p)!;
    return "code" in f ? p : `${p} (${f.width ?? "?"}×${f.height ?? "?"}, ${humanBytes(f.bytes)})`;
  });
  const line = `wrote ${sizes.join(", ")}; ${cu} CU`;
  if (!check.ok) {
    // the files are written; only the block failed its own checks (an image the probe cannot read): say where they are
    return { content: `${line}\n(not shown as a block: ${check.error.code} ${check.error.message})` };
  }
  const v = check.show;
  const envelope = { v: 1, block_id: blockId, revision: 1, op: "snapshot", level: "block", kind: v.kind, catalog: DISPLAY_CATALOG, spec: v.spec, fallback: { text: v.fallback }, source: { by: "engine", tool_use_ids: [key] }, status: "ok" } as DisplayEnvelope;
  return { content: line, meta: { display: [envelope], displayText: `${line}\n${v.fallback}` } };
}

function submitRefusal(e: unknown): ToolResult {
  if (!(e instanceof ImageGatewayError)) return refuse("IMAGE_FAILED", `the gateway could not be reached: ${(e as Error).message.slice(0, 200)}`);
  if (e.status === 403) return refuse("IMAGE_NOT_PERMITTED", "this workspace's gateway key may not make images", "tell the person images are not enabled for this workspace yet");
  if (e.status === 402 || e.status === 429) return refuse("IMAGE_BUDGET", `the spend cap or the wallet stops it: ${e.message.slice(0, 200)}`, "tell the person; do not retry");
  if (e.status === 409) return refuse("IMAGE_FAILED", "this call's id was already used for a different request", "change nothing and answer in text");
  return refuse("IMAGE_FAILED", `the gateway answered ${e.status}: ${e.message.slice(0, 200)}`);
}
