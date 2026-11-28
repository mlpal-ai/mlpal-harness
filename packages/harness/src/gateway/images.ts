import { sniffMedia } from "@mlpal/harness-protocol";

/**
 * The gateway's images API as the engine uses it (mlpal-assistants-service `api/v1/images.py`,
 * `schemas/images.py`): `POST /v1/images/generations` with `wait: false` and an idempotency key, then
 * `GET /v1/images/jobs/{id}` until the job ends. Results are presigned URLs valid for an hour, downloaded
 * without the gateway's credential. The key never leaves the engine: no command or script sees it.
 */

export interface ImageReference {
  base64: string;
  mime_type: string;
}

export interface ImageRequest {
  prompt: string;
  model: string;
  n: number;
  size: string;
  quality: string;
  reference_images?: ImageReference[];
}

export interface GeneratedImage {
  url: string;
  expires_at?: string;
  revised_prompt?: string | null;
  content_type?: string;
  size_bytes?: number;
}

export interface ImageResult {
  data: GeneratedImage[];
  model: string;
  cost: { model_name?: string; provider?: string; images_generated?: number; compute_units: number; input_tokens?: number | null; output_tokens?: number | null };
  routing?: { requested_model?: string; selected_model?: string } | null;
}

export type ImageJob =
  | { status: "queued" | "running"; id: string }
  | { status: "succeeded"; id: string; result: ImageResult }
  | { status: "failed"; id: string; error: { code: string; message: string } };

/** A submit's answer: a job to poll (202, or 200 for an idempotent replay), or a sync result. */
export type ImageSubmit = { job: ImageJob } | { result: ImageResult };

/** An HTTP failure the tool maps to its typed errors. */
export class ImageGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The gateway's error code when it sent one (`wallet_empty`, `budget_exceeded`, …). */
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface ImageGateway {
  submit(req: ImageRequest, opts: { idempotencyKey: string; signal?: AbortSignal }): Promise<ImageSubmit>;
  job(id: string, signal?: AbortSignal): Promise<ImageJob>;
  /** A result's presigned URL, at most `maxBytes`, within `timeoutMs`; no credential is sent. */
  download(url: string, opts: { maxBytes: number; timeoutMs: number; signal?: AbortSignal }): Promise<Uint8Array>;
}

export interface ImageGatewayConfig {
  baseUrl: string;
  /**
   * Review R2: the URL prefixes a result may be downloaded from (`parseAssetPrefix`): scheme, host, port and a path
   * ending in `/`, supplied by the caller (yodex's `images.assetPrefixes`), never by a job answer. Absent or empty:
   * no result is fetched; a `data:` result is still decoded in process.
   */
  assetPrefixes?: readonly string[];
  /** The Authorization header's value for one request, read when it is made. */
  authorization: () => string;
  /** Headers every gateway request carries (the on-behalf-of header of an owner-paid run). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

async function failure(res: Response): Promise<ImageGatewayError> {
  let message = res.statusText;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { detail?: unknown; error?: { message?: unknown; code?: unknown; type?: unknown } };
    const detail = body.detail ?? body.error?.message;
    if (typeof detail === "string") message = detail;
    else if (detail && typeof detail === "object" && typeof (detail as { message?: unknown }).message === "string") message = (detail as { message: string }).message;
    const c = body.error?.code ?? (detail && typeof detail === "object" ? (detail as { code?: unknown }).code : undefined);
    if (typeof c === "string") code = c;
  } catch {
    // not JSON: the status text stands
  }
  return new ImageGatewayError(res.status, message.slice(0, 500), code);
}

/**
 * An image model's price as `GET /v1/models/{tag}` reports it (`pricing`: ModelPricingInfo). The listing
 * (`GET /v1/models`) carries only `pricing_tier`, so prices are read per model, once, when the tool is made.
 * `per_image` models bill `n × input_cu_rate` (the gateway's PricingService.calculate_image_cost: n images as input
 * units, none as output, whatever the size or quality); a token-priced model's cost is known only after the render.
 */
export interface ImagePrice {
  rateUnit: string;
  inputCuRate: number;
  outputCuRate: number;
}

/** The prices of `tags`; a model whose price cannot be read is left out (its calls are then always asked). */
export async function loadImagePrices(cfg: Pick<ImageGatewayConfig, "baseUrl" | "authorization" | "headers" | "fetch">, tags: readonly string[], signal?: AbortSignal): Promise<Map<string, ImagePrice>> {
  const f = cfg.fetch ?? fetch;
  const base = cfg.baseUrl.replace(/\/$/, "");
  const out = new Map<string, ImagePrice>();
  await Promise.all(
    tags.map(async (tag) => {
      try {
        const res = await f(`${base}/v1/models/${encodeURIComponent(tag)}`, { headers: { ...cfg.headers, authorization: cfg.authorization() }, ...(signal ? { signal } : {}) });
        if (!res.ok) return;
        const p = ((await res.json()) as { pricing?: { rate_unit?: unknown; input_cu_rate?: unknown; output_cu_rate?: unknown } | null }).pricing;
        if (p && typeof p.rate_unit === "string" && typeof p.input_cu_rate === "number" && typeof p.output_cu_rate === "number") out.set(tag, { rateUnit: p.rate_unit, inputCuRate: p.input_cu_rate, outputCuRate: p.output_cu_rate });
      } catch {
        // unpriced: asked
      }
    }),
  );
  return out;
}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
/** A `data:` result's decoded cap (a 3840x2160 PNG is 8 to 12 MB). */
export const DATA_IMAGE_BYTES = 16 * 1024 * 1024;
/** A submit or job answer's cap: four inline images at the cap, as base64, and the rest of the answer. */
const ANSWER_BYTES = 4 * (Math.ceil(DATA_IMAGE_BYTES / 3) * 4) + 1024 * 1024;
const DATA_TYPES = /^data:image\/(png|jpeg|webp);base64$/i;
const DATA_DECODED = new Set(["image/png", "image/jpeg", "image/webp"]);

/** A configured or offered URL's own faults, on the string as sent: what parsing would silently change. */
function rawFault(raw: string): string | null {
  if (raw.includes("#")) return "has a fragment";
  // the scheme, authority and path are checked; the query is opaque (a presigned URL's X-Amz-Credential carries %2F,
  // and its signature covers the query as sent), so it is never decoded, normalised or judged here
  const q = raw.indexOf("?");
  const head = q < 0 ? raw : raw.slice(0, q);
  if (head.includes("\\")) return "has a backslash";
  if (/%2f|%5c/i.test(head)) return "has an encoded slash or backslash";
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)(\/[^?#]*)?/i.exec(head);
  if (!m) return "is not an absolute URL";
  if (m[1]!.includes("@")) return "carries credentials";
  const path = m[2] ?? "/";
  if (path.split("/").some((seg) => /^(?:\.|%2e){1,2}$/i.test(seg))) return "has a dot segment";
  try {
    if (new URL(raw).pathname !== path) return "has a path that changes when it is parsed";
  } catch {
    return "is not a URL";
  }
  return null;
}

/** What is fetched for a checked result URL: its parsed origin and path, then its query exactly as the answer sent it
 *  (a parser may re-encode a query character, and a presigned signature covers the bytes). */
function fetchTarget(url: string): string {
  const u = new URL(url);
  const q = url.indexOf("?");
  return `${u.origin}${u.pathname}${q < 0 ? "" : url.slice(q)}`;
}

/** An asset prefix, parsed: its exact origin and its path, which ends in `/`. */
export interface AssetPrefix {
  origin: string;
  path: string;
}

/**
 * One asset prefix, validated for a host to pass at start: `https://host/one/or/more/segments/` (the default port;
 * http, and a port, only on a loopback host), with no user, query, fragment, wildcard, dot segment or encoded slash.
 * Throws, naming the entry, otherwise. A host alone is never a prefix: a shared endpoint (path-style S3) serves
 * every bucket on it.
 */
export function parseAssetPrefix(raw: string): AssetPrefix {
  const s = raw.trim();
  const bad = (why: string): never => {
    throw new Error(`image asset prefix "${s.slice(0, 200)}" ${why}`);
  };
  if (s.includes("*")) bad("has a wildcard");
  if (s.includes("?")) bad("has a query");
  const fault = rawFault(s);
  if (fault) bad(fault);
  const u = new URL(s);
  const loopback = LOOPBACK.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) bad("is not https (http only on a loopback host)");
  if (u.port && !loopback) bad("names a port (only the default https port)");
  if (!u.pathname.endsWith("/") || u.pathname === "/") bad("is not a path prefix ending in / (a host alone is never one)");
  return { origin: u.origin, path: u.pathname };
}

/** Why a result's URL may not be fetched, or null: strictly parsed, it is on a listed prefix's exact origin and under
 *  its path. A job answer names the URL, so it is untrusted input; a refusal names the host only. */
export function resultUrlRefusal(url: string, prefixes: readonly AssetPrefix[]): string | null {
  const fault = rawFault(url);
  const u = URL.canParse(url) ? new URL(url) : null;
  if (!u) return "the image's link is not a URL";
  const host = u.protocol === "https:" || u.protocol === "http:" ? u.hostname : null;
  if (!host) return `the image's link is a ${u.protocol} URL`;
  if (fault) return `the image's link on ${host} ${fault}`;
  const listedLoopback = prefixes.some((p) => p.origin === u.origin && LOOPBACK.test(u.hostname));
  if (u.port && !listedLoopback) return `the image's link on ${host} names a port`;
  if (!prefixes.some((p) => p.origin === u.origin && u.pathname.startsWith(p.path))) return `the image's link is on ${host}, not under an allowed asset prefix`;
  return null;
}

/** A `data:image/{png,jpeg,webp};base64,` result, decoded in process and bounded before decoding by its length. */
function decodeDataUrl(url: string, maxBytes: number): Uint8Array {
  const cap = Math.min(maxBytes, DATA_IMAGE_BYTES);
  const comma = url.indexOf(",");
  if (comma < 0 || !DATA_TYPES.test(url.slice(0, comma))) throw new ImageGatewayError(0, "the image's data: link is not a PNG, JPEG or WebP in base64", "asset_origin");
  if (url.length - comma - 1 > Math.ceil(cap / 3) * 4) throw new ImageGatewayError(413, `the image is over ${cap} bytes`);
  const b64 = url.slice(comma + 1);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new ImageGatewayError(0, "the image's data: link is not valid base64", "asset_origin");
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > cap) throw new ImageGatewayError(413, `the image is over ${cap} bytes`);
  const out = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
  // the type from the bytes, not from what the link says
  if (!DATA_DECODED.has(sniffMedia(out) ?? "")) throw new ImageGatewayError(0, "the image's data: bytes are not a PNG, JPEG or WebP", "asset_origin");
  return out;
}

/** A controller that also aborts when `signal` does: a bounded read ends its own request. */
function linked(signal?: AbortSignal): AbortController {
  const ctl = new AbortController();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener("abort", () => ctl.abort(), { once: true });
  return ctl;
}

/** A gateway answer's JSON, read with a cap (an answer carries up to four inline images). */
async function boundedJson(res: Response, max: number, abort: () => void): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) throw new ImageGatewayError(0, "the gateway sent no body");
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      // the request itself is ended, not only this reader: nothing more is received
      abort();
      await reader.cancel().catch(() => {});
      throw new ImageGatewayError(413, `the gateway's answer is over ${max} bytes`);
    }
    parts.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new ImageGatewayError(0, "the gateway's answer is not JSON");
  }
}

export function gatewayImages(cfg: ImageGatewayConfig): ImageGateway {
  const f = cfg.fetch ?? fetch;
  const base = cfg.baseUrl.replace(/\/$/, "");
  const prefixes = (cfg.assetPrefixes ?? []).map(parseAssetPrefix);
  const headers = () => ({ ...cfg.headers, authorization: cfg.authorization(), "content-type": "application/json" });
  return {
    async submit(req, opts) {
      const ctl = linked(opts.signal);
      const res = await f(`${base}/v1/images/generations`, { method: "POST", headers: headers(), body: JSON.stringify({ ...req, wait: false, idempotency_key: opts.idempotencyKey }), signal: ctl.signal });
      if (!res.ok) throw await failure(res);
      const body = (await boundedJson(res, ANSWER_BYTES, () => ctl.abort())) as Record<string, unknown>;
      if (Array.isArray(body.data)) return { result: body as unknown as ImageResult };
      return { job: body as unknown as ImageJob };
    },
    async job(id, signal) {
      const ctl = linked(signal);
      const res = await f(`${base}/v1/images/jobs/${encodeURIComponent(id)}`, { headers: headers(), signal: ctl.signal });
      if (!res.ok) throw await failure(res);
      return (await boundedJson(res, ANSWER_BYTES, () => ctl.abort())) as ImageJob;
    },
    async download(url, opts) {
      // the gateway's own fallback when its storage fails: the bytes are in the answer, so nothing is fetched
      if (/^data:/i.test(url)) return decodeDataUrl(url, opts.maxBytes);
      const refused = resultUrlRefusal(url, prefixes);
      if (refused) throw new ImageGatewayError(0, refused, "asset_origin");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
      const onAbort = () => ctl.abort();
      opts.signal?.addEventListener("abort", onAbort);
      try {
        // never followed: a redirect would leave the checked origin
        // the origin as parsed, the path as checked (it equals its parsed form), and the query byte for byte
        const res = await f(fetchTarget(url), { signal: ctl.signal, redirect: "manual", credentials: "omit" });
        if (res.status >= 300 && res.status < 400) throw new ImageGatewayError(res.status, `the image's link redirected (${res.status}); redirects are not followed`, "asset_origin");
        if (!res.ok) throw new ImageGatewayError(res.status, `the image's link answered ${res.status}`);
        const reader = res.body?.getReader();
        if (!reader) throw new ImageGatewayError(0, "the image's link sent no body");
        const parts: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > opts.maxBytes) {
            ctl.abort();
            await reader.cancel().catch(() => {});
            throw new ImageGatewayError(413, `the image is over ${opts.maxBytes} bytes`);
          }
          parts.push(value);
        }
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
          out.set(p, at);
          at += p.byteLength;
        }
        return out;
      } catch (e) {
        if (e instanceof ImageGatewayError) throw e;
        throw new ImageGatewayError(0, ctl.signal.aborted ? "the image's download timed out" : `the image could not be downloaded: ${(e as Error).message}`);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
