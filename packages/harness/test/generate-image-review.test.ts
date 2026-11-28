import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Usage } from "@mlpal/harness-protocol";
import { readMedia, probeMedia } from "../src/display/media";
import { gatewayImages, ImageGatewayError, loadImagePrices, type ImageGateway, type ImageJob, type ImagePrice, type ImageRequest, type ImageResult } from "../src/gateway/images";
import type { ModelInfo } from "../src/registry/models";
import { createGenerateImageTool, estimateFromPrices, imageAskReason, type GenerateImageDeps } from "../src/tools/builtin/image";
import type { ToolResult } from "../src/tools";

/** Review-media R2, R3, R4, R5, R6: each finding's input, run against the fix. Never a real gateway. */
const magic = JSON.parse(readFileSync(new URL("../../protocol/test/fixtures/display/media-magic.vectors.json", import.meta.url), "utf8")) as { vectors: Array<{ name: string; hex: string }> };
const head = (name: string) => Buffer.from(magic.vectors.find((v) => v.name === name)!.hex, "hex");
const PNG = head("png 1536x1024");
const DAY = "2026-11-28";
const now = () => new Date(`${DAY}T10:00:00Z`);
const model = (tag: string): ModelInfo => ({ tag, displayName: tag, provider: "p", capabilities: { operation: "image_generation", streaming: false, tools: false, vision: false, pdf: false, audio: false }, contextLength: null, maxOutputTokens: null, deprecated: false, effortLevels: [] });
const result = (n = 1, cu = 0.19): ImageResult => ({ data: Array.from({ length: n }, (_, i) => ({ url: `https://assets.test/img-${i}.png` })), model: "mlpal", cost: { compute_units: cu } });

class Scripted implements ImageGateway {
  submits: ImageRequest[] = [];
  polls = 0;
  constructor(private readonly s: { submit?: () => { job: ImageJob } | { result: ImageResult }; job?: (i: number) => ImageJob; download?: (url: string, i: number) => Uint8Array } = {}) {}
  private downloads = 0;
  async submit(req: ImageRequest) {
    this.submits.push(req);
    return this.s.submit ? this.s.submit() : { result: result(req.n) };
  }
  async job() {
    return this.s.job!(this.polls++);
  }
  async download(url: string) {
    return this.s.download ? this.s.download(url, this.downloads++) : PNG;
  }
}

let root: string;
let outside: string;
let spent: Usage[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genimg-r-"));
  outside = mkdtempSync(join(tmpdir(), "genimg-r-out-"));
  spent = [];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
function call(gw: ImageGateway, input: Record<string, unknown>, extra: Partial<GenerateImageDeps> = {}, signal?: AbortSignal): Promise<ToolResult> {
  const t = createGenerateImageTool({ images: gw, models: () => [], estimate: () => 0.01, now, sleep: async () => {}, ...extra });
  return t.call(input as never, { cwd: root, roots: [root], toolUseId: "toolu_r", spend: (u) => spent.push(u), ...(signal ? { signal } : {}) });
}
const first = (r: ToolResult) => JSON.parse(String(r.content).split("\n")[0]!) as { error: string; message: string; hint?: string };

describe("R2: a result is downloaded only from the gateway's asset origin, https, never through a redirect", () => {
  const servers: Array<{ stop: () => void }> = [];
  afterEach(() => servers.splice(0).forEach((s) => s.stop()));
  function serve(handler: (path: string) => Response) {
    const hits: string[] = [];
    const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => (hits.push(new URL(req.url).pathname), handler(new URL(req.url).pathname)) });
    servers.push(s);
    return { origin: `http://127.0.0.1:${s.port}`, hits };
  }

  test("the review's inputs: localhost, a redirect to the metadata path, file://, data: and credentials in the URL are refused", async () => {
    const internal = serve(() => new Response(PNG));
    const redirector = serve(() => new Response(null, { status: 302, headers: { location: `${internal.origin}/latest/meta-data/iam` } }));
    const secret = join(outside, "private.png");
    writeFileSync(secret, PNG);
    const opts = { maxBytes: 1 << 20, timeoutMs: 2_000 };
    // a test gateway on loopback and no origins configured: nothing is fetched (loopback is never admitted by pattern)
    const plain = gatewayImages({ baseUrl: internal.origin, authorization: () => "Bearer k" });
    for (const url of [`${internal.origin}/direct`, `${redirector.origin}/presigned`, `file://${secret}`, `data:image/png;base64,${PNG.toString("base64")}`])
      await expect(plain.download(url, opts)).rejects.toMatchObject({ code: "asset_origin" });
    expect([internal.hits, redirector.hits]).toEqual([[], []]);
    // both named by configuration: the redirect is still not followed
    const named = gatewayImages({ baseUrl: internal.origin, authorization: () => "Bearer k", assetOrigins: [internal.origin, redirector.origin] });
    expect(Buffer.from(await named.download(`${internal.origin}/direct`, opts)).equals(PNG)).toBe(true);
    await expect(named.download(`${redirector.origin}/presigned`, opts)).rejects.toMatchObject({ status: 302, code: "asset_origin" });
    await expect(named.download(`http://user:pw@${internal.origin.slice(7)}/direct`, opts)).rejects.toMatchObject({ code: "asset_origin" });
    expect(internal.hits).toEqual(["/direct"]);
  });

  test("by default only the gateway's own https origin; another host, plain http on it, or another port is refused", async () => {
    const fetched: string[] = [];
    const fake = (async (url: string) => (fetched.push(url), new Response(PNG))) as unknown as typeof fetch;
    const gw = gatewayImages({ baseUrl: "https://models.example/", authorization: () => "Bearer k", fetch: fake });
    const opts = { maxBytes: 1 << 20, timeoutMs: 1_000 };
    await gw.download("https://models.example/assets/a.png", opts);
    for (const url of ["https://example-bucket.s3.example-region.amazonaws.com/a.png", "http://models.example/a.png", "https://models.example:8443/a.png", "https://169.254.169.254/latest/meta-data/"])
      await expect(gw.download(url, opts)).rejects.toMatchObject({ code: "asset_origin" });
    expect(fetched).toEqual(["https://models.example/assets/a.png"]);
  });

  test("the bound applies while streaming: a body over the cap with no length is stopped at the cap", async () => {
    // 8 MiB in 64 KiB chunks and no content-length (a server stream is not back-pressured, so it is finite)
    let left = 128;
    const big = serve(() => new Response(new ReadableStream({ pull(c) { if (left-- > 0) c.enqueue(new Uint8Array(65536)); else c.close(); } })));
    const gw = gatewayImages({ baseUrl: big.origin, authorization: () => "k", assetOrigins: [big.origin] });
    await expect(gw.download(`${big.origin}/x`, { maxBytes: 1 << 20, timeoutMs: 5_000 })).rejects.toMatchObject({ status: 413 });
  });
});

describe("R5: everything that can refuse is checked before the job; a paid render records its spend on every exit", () => {
  test("a symlinked media/ is refused before any submit, and nothing is made outside the workspace", async () => {
    symlinkSync(outside, join(root, "media"));
    const gw = new Scripted();
    const r = await call(gw, { prompt: "x" });
    expect([first(r).error, gw.submits.length, readdirSync(outside), spent]).toEqual(["IMAGE_FAILED", 0, [], []]);
    expect(first(r).hint).toContain("nothing was paid for");
  });

  test("media/<date> that is a file, or a link to a folder, is refused before any submit", async () => {
    mkdirSync(join(root, "media"));
    writeFileSync(join(root, "media", DAY), "x");
    const gw = new Scripted();
    expect([first(await call(gw, { prompt: "x" })).error, gw.submits.length]).toEqual(["IMAGE_FAILED", 0]);
    rmSync(join(root, "media", DAY));
    symlinkSync(outside, join(root, "media", DAY));
    expect([first(await call(gw, { prompt: "x" })).error, gw.submits.length]).toEqual(["IMAGE_FAILED", 0]);
  });

  test("a download that fails (500), and one that is HTML, are paid and not saved: the job id, the spend once", async () => {
    const job = { submit: () => ({ job: { status: "queued", id: "job-42" } as ImageJob }), job: () => ({ status: "succeeded", id: "job-42", result: result(1) }) as ImageJob };
    const r500 = await call(new Scripted({ ...job, download: () => { throw new ImageGatewayError(500, "the image's link answered 500"); } }), { prompt: "x" });
    expect([first(r500).error, first(r500).message.includes("job job-42"), first(r500).message.includes("0.19 CU")]).toEqual(["IMAGE_NOT_SAVED", true, true]);
    expect(first(r500).hint).toContain("pays a second time");
    const html = await call(new Scripted({ ...job, download: () => head("html") }), { prompt: "x" });
    expect(first(html).error).toBe("IMAGE_NOT_SAVED");
    expect(spent.map((u) => u.compute_units)).toEqual([0.19, 0.19]);
    expect(readdirSync(join(root, "media", DAY))).toEqual([]);
  });

  test("a failure part way through four names the files already written", async () => {
    const r = await call(new Scripted({ download: (_u, i) => { if (i === 2) throw new ImageGatewayError(0, "timed out"); return PNG; } }), { prompt: "four foxes", n: 4 });
    expect(first(r).error).toBe("IMAGE_NOT_SAVED");
    expect(first(r).message).toContain(`saved before it failed: media/${DAY}/four-foxes-1.png, media/${DAY}/four-foxes-2.png`);
    expect(spent.length).toBe(1);
  });

  test("a poll that fails after submit is retried, more slowly, until the job ends", async () => {
    const waits: number[] = [];
    const gw = new Scripted({ submit: () => ({ job: { status: "queued", id: "j" } }), job: (i) => { if (i < 3) throw new ImageGatewayError(502, "bad gateway"); return { status: "succeeded", id: "j", result: result(1) }; } });
    const r = await call(gw, { prompt: "x" }, { sleep: async (ms) => void waits.push(ms), pollMs: 1_000 });
    expect([r.isError, gw.polls, waits]).toEqual([undefined, 4, [1_000, 2_000, 4_000, 8_000]]);
    expect(spent.length).toBe(1);
  });

  test("polls that keep failing, or a stop, end with the job id and that it may still bill; nothing is recorded unseen", async () => {
    let t = now().getTime();
    const failing = new Scripted({ submit: () => ({ job: { status: "queued", id: "job-7" } }), job: () => { throw new Error("network down"); } });
    const late = await call(failing, { prompt: "x" }, { now: () => new Date((t += 60_000)), timeoutMs: 600_000 });
    expect([first(late).error, first(late).message.includes("job job-7 may still finish and bill")]).toEqual(["IMAGE_TIMEOUT", true]);
    const ctl = new AbortController();
    const running = new Scripted({ submit: () => ({ job: { status: "queued", id: "job-8" } }), job: () => (ctl.abort(), { status: "running", id: "job-8" }) });
    const stopped = await call(running, { prompt: "x" }, {}, ctl.signal);
    expect([first(stopped).error, first(stopped).message.includes("job-8")]).toEqual(["IMAGE_TIMEOUT", true]);
    expect(spent).toEqual([]);
  });
});

describe("R6: the budget ask fails closed, and the estimate comes from the gateway's prices", () => {
  const prices = new Map<string, ImagePrice>([
    ["gemini-3.1-flash-lite-image", { rateUnit: "per_image", inputCuRate: 0.01008, outputCuRate: 0.01008 }],
    ["gemini-3-pro-image", { rateUnit: "per_image", inputCuRate: 0.0402, outputCuRate: 0.0402 }],
    ["gpt-image-2", { rateUnit: "per_1m_tokens", inputCuRate: 1.5, outputCuRate: 9 }],
  ]);
  test("no estimator, no price, an unknown model or any size: asked", () => {
    expect(imageAskReason({}, {})).toMatch(/known only after the render/);
    expect(imageAskReason({ model: "gpt-image-2-ultra" }, {})).not.toBeNull();
    expect(imageAskReason({ size: "16384x16384" }, {})).not.toBeNull();
    expect(imageAskReason({ model: "gpt-image-2", size: "4096x4096" }, { prices: () => prices })).toMatch(/gpt-image-2 is known only after/);
  });
  test("a per-image model: n × its rate against the HOP's threshold (default 0.02 CU)", () => {
    const deps = { prices: () => prices, models: () => [model("gemini-3.1-flash-lite-image"), model("gemini-3-pro-image")] };
    expect(imageAskReason({ model: "gemini-3.1-flash-lite-image" }, deps)).toBeNull();
    expect(imageAskReason({ model: "gemini-3-pro-image" }, deps)).toMatch(/0\.040 CU \(over 0\.02\)/);
    expect(imageAskReason({ model: "gemini-3-pro-image" }, { ...deps, askOverCu: 0.05 })).toBeNull();
    // "mlpal" may route to the dearest: priced at the highest when every image model is per-image, else asked
    expect(imageAskReason({}, deps)).toMatch(/0\.040 CU/);
    expect(imageAskReason({}, { ...deps, models: () => [model("gemini-3.1-flash-lite-image"), model("gpt-image-2")] })).toMatch(/known only after/);
    expect(estimateFromPrices(prices, [])({ model: "mlpal", n: 1, quality: "standard", size: "1024x1024", references: 0 })).toBeNull();
  });
  test("loadImagePrices reads each model's pricing; one that cannot be read is left out (and so asked)", async () => {
    const fake = (async (url: string) => {
      if (url.endsWith("/v1/models/a")) return Response.json({ tag: "a", pricing: { input_cu_rate: 0.0201, output_cu_rate: 0.0201, rate_unit: "per_image" } });
      if (url.endsWith("/v1/models/b")) return Response.json({ tag: "b", pricing: null });
      return new Response("no", { status: 500 });
    }) as unknown as typeof fetch;
    const got = await loadImagePrices({ baseUrl: "https://gw.test/", authorization: () => "Bearer k", fetch: fake }, ["a", "b", "c"]);
    expect([...got]).toEqual([["a", { rateUnit: "per_image", inputCuRate: 0.0201, outputCuRate: 0.0201 }]]);
  });
});

describe("R4: a reference is read once, from the verified descriptor, within its bound", () => {
  test("the bytes sent are the bytes probed, with the same hash", () => {
    mkdirSync(join(root, "uploads"));
    writeFileSync(join(root, "uploads", "ref.png"), PNG);
    const r = readMedia({ path: "uploads/ref.png", maxBytes: 5 << 20 }, { cwd: root, roots: [root] });
    if ("code" in r) throw new Error(r.message);
    expect([Buffer.from(r.bytes).equals(PNG), r.facts.sha256]).toEqual([true, createHash("sha256").update(PNG).digest("hex")]);
  });
  test("a FIFO reference is refused at once, and nothing is submitted", async () => {
    mkdirSync(join(root, "uploads"));
    Bun.spawnSync(["/usr/bin/mkfifo", join(root, "uploads", "ref.png")]);
    const gw = new Scripted();
    const r = await call(gw, { prompt: "x", references: ["uploads/ref.png"] });
    expect([first(r).error, gw.submits.length]).toEqual(["MEDIA_NOT_REGULAR", 0]);
  });
});

/** R3 and R4 under a real race: a swapper exchanges a directory (or the reference) with a link (or a FIFO) as fast as
 *  it can, with renamex_np (macOS) or renameat2 (Linux). Skipped where neither runs. */
const SWAP = `
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
a, b, stop = sys.argv[1].encode(), sys.argv[2].encode(), sys.argv[3]
if sys.platform == "darwin":
    swap = lambda: libc.renamex_np(a, b, 2)
else:
    AT = -100
    swap = lambda: libc.renameat2(AT, a, AT, b, 2)
print("ready", flush=True)
n = 0
while not (n % 1024 == 0 and os.path.exists(stop)):
    if swap() != 0: print("unsupported", flush=True); sys.exit(3)
    n += 1
print("swaps", n, flush=True)
`;
const python = ["/usr/bin/python3", "/usr/local/bin/python3"].find((p) => existsSync(p));
async function race(a: string, b: string, ms: number, each: () => Promise<void> | void): Promise<number> {
  const stop = join(root, "..", `stop-${process.pid}-${Math.random()}`);
  const sw = spawn(python!, ["-I", "-c", SWAP, a, b, stop], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  sw.stdout!.on("data", (d) => (out += String(d)));
  const exited = new Promise((r) => sw.on("exit", r));
  const settle = (ms: number) => Promise.race([exited, new Promise((r) => setTimeout(r, ms))]);
  try {
    // the swapper must be running before the race starts: a stalled interpreter fails the test, it never hangs it
    for (const start = Date.now(); !out.includes("ready"); await new Promise((r) => setTimeout(r, 20))) {
      if (Date.now() - start > 10_000 || sw.exitCode !== null) throw new Error(`the swapper did not start: ${out || "no output"}`);
    }
    const end = Date.now() + ms;
    while (Date.now() < end) await each();
    writeFileSync(stop, "");
    await settle(5_000);
  } finally {
    if (sw.exitCode === null) sw.kill("SIGKILL");
    await settle(1_000);
    rmSync(stop, { force: true });
  }
  return Number(/swaps (\d+)/.exec(out)?.[1] ?? 0);
}

describe.skipIf(!python)("R3, R4 under a real swap race", () => {
  test("a directory swapped for a link to outside never yields the outside file's hash", async () => {
    const secret = Buffer.concat([PNG, Buffer.from("OUTSIDE")]);
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d", "a.png"), PNG);
    writeFileSync(join(outside, "a.png"), secret);
    symlinkSync(outside, join(root, "l"));
    const bad = createHash("sha256").update(secret).digest("hex");
    const seen: Record<string, number> = {};
    const swaps = await race(join(root, "d"), join(root, "l"), 1_500, () => {
      const r = probeMedia({ path: "d/a.png", maxBytes: 1 << 20 }, { cwd: root, roots: [root] });
      const k = "code" in r ? r.code : r.sha256 === bad ? "LEAKED" : "inside";
      seen[k] = (seen[k] ?? 0) + 1;
    });
    expect(swaps).toBeGreaterThan(0);
    expect(seen.LEAKED ?? 0).toBe(0);
  }, 20_000);

  test("a reference swapped with a FIFO never blocks the engine", async () => {
    mkdirSync(join(root, "uploads"));
    writeFileSync(join(root, "uploads", "ref.png"), PNG);
    Bun.spawnSync(["/usr/bin/mkfifo", join(root, "uploads", "fifo")]);
    const gw = new Scripted({ submit: () => { throw new Error("stop here"); } });
    let calls = 0;
    const swaps = await race(join(root, "uploads", "ref.png"), join(root, "uploads", "fifo"), 1_500, async () => {
      await call(gw, { prompt: "x", references: ["uploads/ref.png"] });
      calls++;
    });
    expect(swaps).toBeGreaterThan(0);
    expect(calls).toBeGreaterThan(50);
  }, 20_000);
});
