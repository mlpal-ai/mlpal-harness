/**
 * WebFetch's own bounds (W3 fix pass, item 4b): a response is read as it streams and abandoned past 3 MiB, never
 * buffered whole (a large page could exhaust an engine pod's memory), and a fetch has its own deadline beside the
 * turn's signal: whichever fires first ends it, and a timeout reads differently from a cancelled turn. Both the
 * platform's WebFetch (through the egress route) and the local one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEgressWebFetchTool, createWebFetchTool } from "../src/tools/builtin/web";
import type { Tool } from "../src/tools/types";

const MIB = 1024 * 1024;
const CHUNK = 64 * 1024;
let dir: string;
let tokenFile: string;
/** Stands for the egress proxy's route and the page behind it: `/v1/u/web-fetch/big` streams 8 MiB slowly, counting
 *  what the client pulled; `/v1/u/web-fetch/hang` sends headers and never finishes. */
let server: ReturnType<typeof Bun.serve>;
/** Bytes each `/big` request's stream produced, by its `?id=`. */
const produced = new Map<string, number>();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "webfetch-bounds-"));
  tokenFile = join(dir, "egress.token");
  writeFileSync(tokenFile, "test-egress-token-webfetch");
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/big")) {
        const id = new URL(req.url).searchParams.get("id") ?? "";
        produced.set(id, 0);
        const body = new ReadableStream<Uint8Array>({
          async pull(c) {
            if (produced.get(id)! >= 8 * MIB) return c.close();
            await Bun.sleep(2);
            produced.set(id, produced.get(id)! + CHUNK);
            c.enqueue(new Uint8Array(CHUNK).fill(97));
          },
        }, { highWaterMark: 0 });
        return new Response(body, { headers: { "content-type": "text/plain" } });
      }
      if (path.endsWith("/hang")) return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { headers: { "content-type": "text/plain" } });
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const base = "https://pages.example.org/";
const egress = (opts?: { timeoutMs?: number }) => createEgressWebFetchTool({ proxyUrl: `http://127.0.0.1:${server.port}`, upstream: "web-fetch", tokenFile }, base, opts) as Tool;
const local = (opts?: { timeoutMs?: number }) => createWebFetchTool(opts) as Tool;
const urlOf = (tool: "egress" | "local", page: string) => (tool === "egress" ? `${base}${page}` : `http://127.0.0.1:${server.port}/v1/u/web-fetch/${page}`);

for (const kind of ["egress", "local"] as const) {
  describe(`${kind} WebFetch`, () => {
    const make = kind === "egress" ? egress : local;

    test("a response over 3 MiB is abandoned as it streams: refused as too large, no partial content, at most a few chunks read past the cap", async () => {
      const r = await make().call({ url: urlOf(kind, `big?id=${kind}`) }, { cwd: dir, signal: new AbortController().signal });
      expect(r.isError).toBe(true);
      expect(String(r.content)).toContain("response too large");
      expect(String(r.content)).not.toContain("aaaa");
      // What the server produced is what the client pulled, plus what the socket buffers held: never the whole 8 MiB.
      const n = produced.get(kind)!;
      console.log(`${kind}: the server produced ${n} bytes (cap ${3 * MIB})`);
      expect(n).toBeLessThanOrEqual(3 * MIB + 2 * CHUNK);
    }, 30_000);

    test("a page that never finishes ends at the tool's own deadline even while the turn's signal is live, and says it timed out", async () => {
      const turn = new AbortController();
      const r = await Promise.race([make({ timeoutMs: 300 }).call({ url: urlOf(kind, "hang") }, { cwd: dir, signal: turn.signal }), Bun.sleep(5_000).then(() => "hung" as const)]);
      expect(r).not.toBe("hung");
      expect(r).toMatchObject({ isError: true });
      expect(String((r as { content: unknown }).content)).toContain("timed out after 0.3 s");
    }, 10_000);

    test("a cancelled turn ends the fetch at once and says so, distinguishable from the timeout", async () => {
      const turn = new AbortController();
      setTimeout(() => turn.abort(), 100);
      const r = await Promise.race([make({ timeoutMs: 4_000 }).call({ url: urlOf(kind, "hang") }, { cwd: dir, signal: turn.signal }), Bun.sleep(3_000).then(() => "hung" as const)]);
      expect(r).toMatchObject({ isError: true });
      expect(String((r as { content: unknown }).content)).toContain("the turn was cancelled");
    }, 10_000);
  });
}
