import { z } from "zod";
import { EgressRefusedError, egressFetch, egressUrl, type EgressRoute } from "../../egress/proxy";
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

/** A fetched page as the model reads it. */
async function readable(url: string, res: Response): Promise<ToolResult> {
  if (!res.ok) return err(`HTTP ${res.status} ${res.statusText}`);
  const type = res.headers.get("content-type") ?? "";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return err(`response too large (${(buf.length / 1e6).toFixed(1)} MB)`);
  const body = buf.toString("utf8");

  const isText = /text\/|json|xml|javascript|application\/x-/.test(type);
  if (!isText && type) return err(`unsupported content-type: ${type}`);
  const text = /html/.test(type) ? htmlToText(body) : body;
  const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[truncated]` : text;
  return ok(`URL: ${url}\n\n${clipped}`);
}

export const webFetchTool = defineTool({
  name: "WebFetch",
  description:
    "Fetch a URL over HTTP(S) and return its readable text content (HTML is reduced to text). Use for reading docs or pages. Large pages are truncated.",
  readOnly: false,
  schema: webFetchSchema,
  async call(input, ctx) {
    if (!/^https?:\/\//i.test(input.url)) return err("URL must start with http:// or https://");
    const signal = ctx.signal ?? AbortSignal.timeout(15_000);
    let res: Response;
    try {
      res = await fetch(input.url, {
        signal,
        redirect: "follow",
        headers: { "user-agent": `${host().name}/1.0 (+https://mlpal.ai)` },
      });
    } catch (e) {
      return err(`fetch failed: ${(e as Error).message}`);
    }
    return readable(input.url, res);
  },
});

/** `url`'s path and query relative to `base`, or null when it is not under it: same origin, the parsed (dot
 *  segments resolved, `%2e` included) path under the base's on a segment boundary, and still so after one decoding. */
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
  let decoded: string;
  try {
    decoded = decodeURIComponent(t.pathname);
  } catch {
    return null;
  }
  const again = new URL(decoded, t.origin);
  if (again.origin !== t.origin || !again.pathname.startsWith(prefix)) return null;
  return t.pathname.slice(prefix.length) + t.search;
}

/**
 * WebFetch on the platform (P6): no generic egress, so it reaches only the session's `web-fetch` upstream, through
 * the egress proxy. A URL under the upstream's `base_url` (compared parsed, see pathUnderBase) is fetched at
 * `<proxy>/v1/u/web-fetch/<rest>`; any other URL is refused before a request. A redirect is reported, never followed.
 */
export function createEgressWebFetchTool(route: EgressRoute, baseUrl: string) {
  const fetchVia = egressFetch(route);
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return defineTool({
    name: "WebFetch",
    description: `Fetch a page under ${base} and return its readable text content (HTML is reduced to text). Only that site is reachable from this session. Large pages are truncated.`,
    readOnly: false,
    schema: webFetchSchema,
    async call(input, ctx) {
      const rest = pathUnderBase(input.url, base);
      if (rest === null) return err(`WebFetch reaches ${base} only in this session (its web-fetch upstream); ${input.url} is outside it`);
      let res: Response;
      try {
        res = await fetchVia(egressUrl(route, rest), {
          signal: ctx.signal ?? AbortSignal.timeout(15_000),
          headers: { "user-agent": `${host().name}/1.0 (+https://mlpal.ai)` },
        });
      } catch (e) {
        if (e instanceof EgressRefusedError) return err(e.message);
        return err(`fetch failed: ${(e as Error).message}`);
      }
      if (res.status >= 300 && res.status < 400) return err(`HTTP ${res.status}: a redirect, not followed through the egress proxy`);
      return readable(input.url, res);
    },
  });
}
