import { z } from "zod";
import { defineTool, err, ok } from "../types";
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

export const webFetchTool = defineTool({
  name: "WebFetch",
  description:
    "Fetch a URL over HTTP(S) and return its readable text content (HTML is reduced to text). Use for reading docs or pages. Large pages are truncated.",
  readOnly: false,
  schema: z.object({
    url: z.string().url().describe("Absolute http(s) URL"),
  }),
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
    if (!res.ok) return err(`HTTP ${res.status} ${res.statusText}`);

    const type = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return err(`response too large (${(buf.length / 1e6).toFixed(1)} MB)`);
    const body = buf.toString("utf8");

    const isText = /text\/|json|xml|javascript|application\/x-/.test(type);
    if (!isText && type) return err(`unsupported content-type: ${type}`);
    const text = /html/.test(type) ? htmlToText(body) : body;
    const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n[truncated]` : text;
    return ok(`URL: ${input.url}\n\n${clipped}`);
  },
});
