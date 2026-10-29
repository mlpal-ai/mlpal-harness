import { z } from "zod";
import { EgressRefusedError, egressFetch, egressUrl, type EgressRoute, segmentsSafe } from "../../egress/proxy";
import { defineTool, err, ok, type ToolResult } from "../types";
import { host } from "../../host";

/**
 * Fetch a URL and return its readable text. Not read-only: it's network egress, so it is
 * gated by the permission layer (asks in manual/cruise, allowed in autopilot). HTML is
 * reduced to text locally — good enough for reading docs/pages; not a full browser. In
 * hosted/multi-tenant mode this needs an SSRF allowlist (don't let it reach internal hosts).
 */
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_TEXT = 60_000;
const TIMEOUT_MS = 15_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

const webFetchSchema = z.object({
  url: z.string().url().describe("Absolute http(s) URL"),
});

/** One fetch's signal: the turn's, the tool's own deadline and the fetch's own stop (`drop`, once the body is past the
 *  cap: cancelling the reader alone leaves Bun draining the connection until the deadline), whichever fires first; and
 *  which one it was. */
function fetchBounds(turn: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; drop(): void; why(e: unknown): string } {
  const deadline = AbortSignal.timeout(timeoutMs);
  const own = new AbortController();
  return {
    signal: AbortSignal.any(turn ? [turn, deadline, own.signal] : [deadline, own.signal]),
    drop: () => own.abort(),
    why: (e) => (turn?.aborted ? "fetch aborted: the turn was cancelled" : deadline.aborted ? `fetch timed out after ${timeoutMs / 1000} s` : `fetch failed: ${(e as Error).message}`),
  };
}

/** The body as it streams, abandoned once it passes `max` bytes (the reader cancelled and the request dropped, so
 *  nothing more is read): null then. */
async function readCapped(res: Response, max: number, drop: () => void): Promise<Buffer | null> {
  if (Number(res.headers.get("content-length")) > max) {
    drop();
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    n += value.length;
    if (n > max) {
      drop();
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}

/** A fetched page as the model reads it. */
async function readable(url: string, res: Response, drop: () => void): Promise<ToolResult> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return err(`HTTP ${res.status} ${res.statusText}`);
  }
  const type = res.headers.get("content-type") ?? "";
  const buf = await readCapped(res, MAX_BYTES, drop);
  if (!buf) return err(`response too large (over ${(MAX_BYTES / 1e6).toFixed(1)} MB)`);
  const body = buf.toString("utf8");

  const isText = /text\/|json|xml|javascript|application\/x-/.test(type);
  if (!isText && type) return err(`unsupported content-type: ${type}`);
  const text = /html/.test(type) ? htmlToText(body) : body;
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[truncated]` : text;
  return ok(`URL: ${url}\n\n${clipped}`);
}

/** A fetch's own bounds; `timeoutMs` is the deadline beside the turn's signal. */
export interface WebFetchOptions {
  timeoutMs?: number;
}

export function createWebFetchTool(opts: WebFetchOptions = {}) {
  return defineTool({
  name: "WebFetch",
  hands: "local",
  description:
    "Fetch a URL over HTTP(S) and return its readable text content (HTML is reduced to text). Use for reading docs or pages. Large pages are truncated.",
  readOnly: false,
  schema: webFetchSchema,
  async call(input, ctx) {
    if (!/^https?:\/\//i.test(input.url)) return err("URL must start with http:// or https://");
    const bounds = fetchBounds(ctx.signal, opts.timeoutMs ?? TIMEOUT_MS);
    try {
      const res = await fetch(input.url, {
        signal: bounds.signal,
        redirect: "follow",
        headers: { "user-agent": `${host().name}/1.0 (+https://mlpal.ai)` },
      });
      return await readable(input.url, res, bounds.drop);
    } catch (e) {
      return err(bounds.why(e));
    }
  },
  });
}

export const webFetchTool = createWebFetchTool();

/** `url`'s path and query relative to `base`, or null when it is not under it: same origin, the parsed (dot
 *  segments resolved, `%2e` included) path under the base's on a segment boundary, leading slashes of the rest
 *  stripped (egressUrl strips them too, so both see one path), and every segment of the rest safe (segmentsSafe). */
export function pathUnderBase(url: string, base: string): string | null {
  let t: URL;
  let b: URL;
  try {
    t = new URL(url);
    b = new URL(base);
  } catch {
    return null;
  }
  const prefix = b.pathname.endsWith("/") ? b.pathname : `${b.pathname}/`;
  if (t.origin !== b.origin || !t.pathname.startsWith(prefix)) return null;
  const rest = t.pathname.slice(prefix.length).replace(/^\/+/, "");
  return segmentsSafe(rest) ? rest + t.search : null;
}

/**
 * WebFetch on the platform (P6): no generic egress, so it reaches only the session's `web-fetch` upstream, through
 * the egress proxy. A URL under the upstream's `base_url` (compared parsed, see pathUnderBase) is fetched at
 * `<proxy>/v1/u/web-fetch/<rest>`; any other URL is refused before a request. A redirect is reported, never followed.
 */
export function createEgressWebFetchTool(route: EgressRoute, baseUrl: string, opts: WebFetchOptions = {}) {
  const fetchVia = egressFetch(route);
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return defineTool({
    name: "WebFetch",
    hands: "routed",
    description: `Fetch a page under ${base} and return its readable text content (HTML is reduced to text). Only that site is reachable from this session. Large pages are truncated.`,
    readOnly: false,
    schema: webFetchSchema,
    async call(input, ctx) {
      const rest = pathUnderBase(input.url, base);
      if (rest === null) return err(`WebFetch reaches ${base} only in this session (its web-fetch upstream); ${input.url} is outside it`);
      const bounds = fetchBounds(ctx.signal, opts.timeoutMs ?? TIMEOUT_MS);
      try {
        const res = await fetchVia(egressUrl(route, rest), {
          signal: bounds.signal,
          headers: { "user-agent": `${host().name}/1.0 (+https://mlpal.ai)` },
        });
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          return err(`HTTP ${res.status}: a redirect, not followed through the egress proxy`);
        }
        return await readable(input.url, res, bounds.drop);
      } catch (e) {
        if (e instanceof EgressRefusedError) return err(e.message);
        return err(bounds.why(e));
      }
    },
  });
}
