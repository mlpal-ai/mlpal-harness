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

/** An upstream that writes an endless chunked body as fast as the socket drains, on its own socket: what it wrote, and
 *  when the client closed it. */
function endlessUpstream(): { port: number; written: () => number; closedAt: () => number | null; stop(): void } {
  let written = 0;
  let closedAt: number | null = null;
  const chunk = Buffer.concat([Buffer.from(`${(CHUNK).toString(16)}\r\n`), Buffer.alloc(CHUNK, 97), Buffer.from("\r\n")]);
  let rest: Buffer = Buffer.alloc(0);
  let started = false;
  const pump = (s: { write(b: Buffer): number }) => {
    for (;;) {
      const out = rest.length ? rest : chunk;
      const n = s.write(out);
      written += Math.max(n, 0);
      rest = n < out.length ? out.subarray(Math.max(n, 0)) : Buffer.alloc(0);
      if (rest.length) return;
    }
  };
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(s) {
        if (started) return;
        started = true;
        rest = Buffer.from("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n");
        pump(s);
      },
      drain(s) {
        pump(s);
      },
      close() {
        closedAt ??= Date.now();
      },
      error() {
        closedAt ??= Date.now();
      },
    },
  });
  return { port: server.port, written: () => written, closedAt: () => closedAt, stop: () => server.stop(true) };
}

describe("past the cap, the connection is dropped at once (FIXPASS review M1)", () => {
  for (const kind of ["egress", "local"] as const) {
    test(`${kind}: an endless body is refused as too large and its socket closed within 500 ms, long before the deadline; the fetch reads no further`, async () => {
      const up = endlessUpstream();
      try {
        const tool = kind === "egress"
          ? (createEgressWebFetchTool({ proxyUrl: `http://127.0.0.1:${up.port}`, upstream: "web-fetch", tokenFile }, base, { timeoutMs: 8_000 }) as Tool)
          : (createWebFetchTool({ timeoutMs: 8_000 }) as Tool);
        const url = kind === "egress" ? `${base}endless` : `http://127.0.0.1:${up.port}/v1/u/web-fetch/endless`;
        const t0 = Date.now();
        const cpu0 = process.cpuUsage();
        const r = await tool.call({ url }, { cwd: dir, signal: new AbortController().signal });
        const answered = Date.now();
        expect(String(r.content)).toContain("response too large");
        const deadline = answered + 2_000;
        while (up.closedAt() === null && Date.now() < deadline) await Bun.sleep(10);
        const settled = up.written();
        await Bun.sleep(500);
        const cpu = process.cpuUsage(cpu0);
        console.log(`${kind}: answered in ${answered - t0} ms, socket closed ${up.closedAt() === null ? "never" : `${up.closedAt()! - answered} ms after`}, ${up.written()} bytes written, cpu ${Math.round((cpu.user + cpu.system) / 1000)} ms`);
        expect(answered - t0).toBeLessThan(2_000);
        expect(up.closedAt()).not.toBeNull();
        expect(up.closedAt()! - answered).toBeLessThan(500);
        // Nothing more is read once it closed.
        expect(up.written()).toBe(settled);
      } finally {
        up.stop();
      }
    }, 20_000);
  }
});

