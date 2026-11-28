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

export function gatewayImages(cfg: ImageGatewayConfig): ImageGateway {
  const f = cfg.fetch ?? fetch;
  const base = cfg.baseUrl.replace(/\/$/, "");
  const headers = () => ({ ...cfg.headers, authorization: cfg.authorization(), "content-type": "application/json" });
  return {
    async submit(req, opts) {
      const res = await f(`${base}/v1/images/generations`, { method: "POST", headers: headers(), body: JSON.stringify({ ...req, wait: false, idempotency_key: opts.idempotencyKey }), ...(opts.signal ? { signal: opts.signal } : {}) });
      if (!res.ok) throw await failure(res);
      const body = (await res.json()) as Record<string, unknown>;
      if (Array.isArray(body.data)) return { result: body as unknown as ImageResult };
      return { job: body as unknown as ImageJob };
    },
    async job(id, signal) {
      const res = await f(`${base}/v1/images/jobs/${encodeURIComponent(id)}`, { headers: headers(), ...(signal ? { signal } : {}) });
      if (!res.ok) throw await failure(res);
      return (await res.json()) as ImageJob;
    },
    async download(url, opts) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
      const onAbort = () => ctl.abort();
      opts.signal?.addEventListener("abort", onAbort);
      try {
        const res = await f(url, { signal: ctl.signal });
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
            await reader.cancel();
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
