import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkDownload, presignedUrl } from "./image-gateway-fixture";
import { displayEnvelopeSchema, type DisplayCaps, type Usage } from "@mlpal/harness-protocol";
import { gatewayImages, ImageGatewayError, type ImageGateway, type ImageJob, type ImageRequest, type ImageResult } from "../src/gateway/images";
import { createPolicy } from "../src/permission/engine";
import type { ModelInfo } from "../src/registry/models";
import { createGenerateImageTool, imageAskReason, type GenerateImageDeps } from "../src/tools/builtin/image";
import type { ToolResult } from "../src/tools";

/** GenerateImage against a scripted gateway: never a real call. */
type Vector = { name: string; hex: string };
const magic = JSON.parse(readFileSync(new URL("../../protocol/test/fixtures/display/media-magic.vectors.json", import.meta.url), "utf8")) as { vectors: Vector[] };
const head = (name: string) => Buffer.from(magic.vectors.find((v) => v.name === name)!.hex, "hex");
const PNG = head("png 1536x1024");
const DAY = "2026-11-28";
const now = () => new Date(`${DAY}T10:00:00Z`);

/** A scripted gateway: records every submit, answers from `script`, serves `files` by URL. */
class FakeGateway implements ImageGateway {
  submits: Array<{ req: ImageRequest; key: string }> = [];
  polls = 0;
  downloads: string[] = [];
  constructor(
    private readonly script: { submit?: (req: ImageRequest, key: string) => { job: ImageJob } | { result: ImageResult }; jobs?: ImageJob[]; files?: Record<string, Uint8Array | ImageGatewayError> } = {},
  ) {}
  async submit(req: ImageRequest, opts: { idempotencyKey: string }) {
    this.submits.push({ req, key: opts.idempotencyKey });
    return this.script.submit ? this.script.submit(req, opts.idempotencyKey) : { result: result(req.n) };
  }
  async job(_id: string) {
    const j = this.script.jobs?.[Math.min(this.polls, (this.script.jobs?.length ?? 1) - 1)];
    this.polls++;
    if (!j) throw new Error("no job scripted");
    return j;
  }
  async download(url: string) {
    checkDownload(url);
    this.downloads.push(url);
    const f = this.script.files?.[url] ?? PNG;
    if (f instanceof ImageGatewayError) throw f;
    return f;
  }
}
const result = (n = 1, cu = 0.04): ImageResult => ({
  data: Array.from({ length: n }, (_, i) => ({ url: presignedUrl("img", i), content_type: "image/png", size_bytes: PNG.length, ...(i === 0 ? { revised_prompt: "a red fox on fresh snow at dawn" } : {}) })),
  model: "mlpal",
  cost: { model_name: "gpt-image-2", provider: "openai", images_generated: n, compute_units: cu },
});
const IMAGE_MODEL: ModelInfo = { tag: "gpt-image-2", displayName: "GPT Image 2", provider: "openai", capabilities: { operation: "image_generation", streaming: false, tools: false, vision: false, pdf: false, audio: false }, contextLength: null, maxOutputTokens: null, deprecated: false, effortLevels: [] };

let root: string;
let spent: Usage[] = [];
beforeEach(() => {
  spent = [];
  root = mkdtempSync(join(tmpdir(), "genimg-"));
  mkdirSync(join(root, "uploads"), { recursive: true });
  writeFileSync(join(root, "uploads", "ref-a.png"), PNG);
  writeFileSync(join(root, "uploads", "ref-b.jpg"), head("jpeg 800x600, EXIF without GPS"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function tool(gw: ImageGateway, extra: Partial<GenerateImageDeps> = {}) {
  const t = createGenerateImageTool({ images: gw, models: () => [IMAGE_MODEL], now, sleep: async () => {}, ...extra });
  return (input: Record<string, unknown>, toolUseId = "toolu_01") => t.call(input as never, { cwd: root, roots: [root], toolUseId, spend: async (u) => void spent.push(u) });
}
const text = (r: ToolResult) => (typeof r.content === "string" ? r.content : "");
const code = (r: ToolResult) => (JSON.parse(text(r).split("\n")[0]!) as { error: string }).error;

describe("GenerateImage writes the result under media/<date>/ and shows it", () => {
  test("one image: the file, an engine-written image block, the cost on the step", async () => {
    const gw = new FakeGateway();
    const r = await tool(gw)({ prompt: "A red fox on snow", name: "Fox" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toBe(`wrote media/${DAY}/fox-1.png (1536×1024, ${PNG.length} B); 0.04 CU`);
    const file = join(root, "media", DAY, "fox-1.png");
    expect(readFileSync(file).equals(PNG)).toBe(true);
    const env = r.meta!.display![0]!;
    expect(displayEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(env).toMatchObject({
      level: "block", kind: "image", source: { by: "engine", tool_use_ids: ["toolu_01"] },
      spec: { media: { path: `media/${DAY}/fox-1.png`, mime: "image/png", sha256: createHash("sha256").update(PNG).digest("hex") }, width: 1536, height: 1024, alt: "a red fox on fresh snow at dawn", made_by: { kind: "generated", model: "gpt-image-2", prompt: "A red fox on snow", compute_units: 0.04 } },
    });
    expect(env.fallback.text).toContain("Cost: 0.04 CU.");
    expect(env.fallback.text).toContain(`media/${DAY}/fox-1.png`);
    expect(spent).toEqual([{ input_tokens: 0, output_tokens: 0, compute_units: 0.04 }]);
    expect(gw.submits[0]).toMatchObject({ key: "toolu_01", req: { prompt: "A red fox on snow", model: "mlpal", n: 1, size: "1024x1024", quality: "standard" } });
    // the temp file is gone
    expect(readdirSync(join(root, "media", DAY))).toEqual(["fox-1.png"]);
  });

  test("the job form: queued, running, then succeeded, polled with the tool-use id as the idempotency key", async () => {
    const gw = new FakeGateway({ submit: () => ({ job: { status: "queued", id: "job-1" } }), jobs: [{ status: "running", id: "job-1" }, { status: "succeeded", id: "job-1", result: result(1) }] });
    const r = await tool(gw)({ prompt: "fox" }, "toolu_77");
    expect(r.isError).toBeUndefined();
    expect([gw.submits.map((s) => s.key), gw.polls]).toEqual([["toolu_77"], 2]);
  });

  test("a retried call sends the same idempotency key (the gateway replays the job, so nothing is paid twice), and never overwrites", async () => {
    const gw = new FakeGateway();
    await tool(gw)({ prompt: "fox", name: "fox" }, "toolu_9");
    const original = readFileSync(join(root, "media", DAY, "fox-1.png"));
    const again = await tool(gw)({ prompt: "fox", name: "fox" }, "toolu_9");
    expect(gw.submits.map((s) => s.key)).toEqual(["toolu_9", "toolu_9"]);
    expect(text(again)).toContain(`media/${DAY}/fox-1-2.png`);
    expect(readFileSync(join(root, "media", DAY, "fox-1.png")).equals(original)).toBe(true);
  });

  test("four images make an image_set of four files", async () => {
    const r = await tool(new FakeGateway())({ prompt: "robot hero", n: 4 });
    expect(r.meta!.display![0]).toMatchObject({ kind: "image_set", spec: { images: [{ label: "A" }, { label: "B" }, { label: "C" }, { label: "D" }] } });
    expect(readdirSync(join(root, "media", DAY)).sort()).toEqual(["robot-hero-1.png", "robot-hero-2.png", "robot-hero-3.png", "robot-hero-4.png"]);
  });

  test("references from uploads/ go as base64 with their magic type; bad ones are refused before any call", async () => {
    const gw = new FakeGateway();
    expect((await tool(gw)({ prompt: "combine", references: ["uploads/ref-a.png", "uploads/ref-b.jpg"] })).isError).toBeUndefined();
    expect(gw.submits[0]!.req.reference_images).toEqual([{ base64: PNG.toString("base64"), mime_type: "image/png" }, { base64: head("jpeg 800x600, EXIF without GPS").toString("base64"), mime_type: "image/jpeg" }]);
    writeFileSync(join(root, "uploads", "anim.gif"), head("gif 320x200"));
    writeFileSync(join(root, "uploads", "big.png"), PNG);
    truncateSync(join(root, "uploads", "big.png"), 6 * 1024 * 1024);
    const outside = mkdtempSync(join(tmpdir(), "genimg-out-"));
    writeFileSync(join(outside, "x.png"), PNG);
    symlinkSync(join(outside, "x.png"), join(root, "uploads", "link.png"));
    const cases: Array<[string, string]> = [["../x.png", "PATH_OUTSIDE_WORKSPACE"], ["uploads/link.png", "PATH_OUTSIDE_WORKSPACE"], ["uploads/anim.gif", "MEDIA_TYPE_NOT_ALLOWED"], ["uploads/big.png", "MEDIA_TOO_LARGE"], ["uploads/none.png", "MEDIA_NOT_FOUND"]];
    const before = gw.submits.length;
    for (const [p, c] of cases) expect([p, code(await tool(gw)({ prompt: "x", references: [p] }))]).toEqual([p, c]);
    expect(gw.submits.length).toBe(before);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("GenerateImage's typed errors", () => {
  const failing = (e: ImageGatewayError) => new FakeGateway({ submit: () => { throw e; } });
  test("403, 402, 429 and 409 from the gateway", async () => {
    expect(code(await tool(failing(new ImageGatewayError(403, "needs images")))({ prompt: "x" }))).toBe("IMAGE_NOT_PERMITTED");
    expect(code(await tool(failing(new ImageGatewayError(402, "wallet empty", "wallet_empty")))({ prompt: "x" }))).toBe("IMAGE_BUDGET");
    expect(code(await tool(failing(new ImageGatewayError(429, "cap", "budget_exceeded")))({ prompt: "x" }))).toBe("IMAGE_BUDGET");
    expect(code(await tool(failing(new ImageGatewayError(409, "different body")))({ prompt: "x" }))).toBe("IMAGE_FAILED");
  });

  test("a provider's refusal is IMAGE_REFUSED with its words; a lost worker is IMAGE_FAILED, nothing billed", async () => {
    const job = (error: { code: string; message: string }) => new FakeGateway({ submit: () => ({ job: { status: "queued", id: "j" } }), jobs: [{ status: "failed", id: "j", error }] });
    const refused = await tool(job({ code: "provider_error", message: "Your request was rejected by the safety system" }))({ prompt: "x" });
    expect(code(refused)).toBe("IMAGE_REFUSED");
    expect(text(refused)).toContain("rejected by the safety system");
    expect(text(refused)).toContain("do not retry the same prompt");
    expect(code(await tool(job({ code: "worker_lost", message: "lost" }))({ prompt: "x" }))).toBe("IMAGE_FAILED");
  });

  test("a render that outlasts the limit is IMAGE_TIMEOUT", async () => {
    let t = now().getTime();
    const gw = new FakeGateway({ submit: () => ({ job: { status: "queued", id: "j" } }), jobs: [{ status: "running", id: "j" }] });
    const r = await tool(gw, { now: () => new Date((t += 60_000)), timeoutMs: 600_000 })({ prompt: "x" });
    expect(code(r)).toBe("IMAGE_TIMEOUT");
  });

  test("an expired link, and a result that is not an image, write nothing: paid and not saved, the spend recorded", async () => {
    const expired = new FakeGateway({ files: { [presignedUrl("img", 0)]: new ImageGatewayError(403, "expired") } });
    expect(code(await tool(expired)({ prompt: "x" }))).toBe("IMAGE_NOT_SAVED");
    const html = new FakeGateway({ files: { [presignedUrl("img", 0)]: head("html") } });
    expect(code(await tool(html)({ prompt: "x" }))).toBe("IMAGE_NOT_SAVED");
    expect(spent.map((u) => u.compute_units)).toEqual([0.04, 0.04]);
    expect(existsSync(join(root, "media", DAY)) ? readdirSync(join(root, "media", DAY)).filter((f) => !f.startsWith(".")) : []).toEqual([]);
  });

  test("a model that is not an image model is refused before any call", async () => {
    const gw = new FakeGateway();
    expect(code(await tool(gw)({ prompt: "x", model: "claude-sonnet-5" }))).toBe("IMAGE_FAILED");
    expect(gw.submits).toEqual([]);
  });
});

describe("GenerateImage asks the person when it costs more", () => {
  test("more than one image, hd, or an estimate over the threshold; one cheap image is the mode's", () => {
    const estimate = ({ n, quality }: { n: number; quality: string }) => n * (quality === "hd" ? 0.08 : 0.01);
    expect(imageAskReason({ prompt: "x" }, { estimate })).toBeNull();
    expect(imageAskReason({ prompt: "x", n: 4 }, { estimate })).toMatch(/4 images/);
    expect(imageAskReason({ prompt: "x", quality: "hd" }, { estimate })).toMatch(/hd quality/);
    expect(imageAskReason({ prompt: "x" }, { estimate: () => 0.06 })).toMatch(/over 0.02/);
    expect(imageAskReason({ prompt: "x" }, { estimate: () => 0.06, askOverCu: 0.1 })).toBeNull();
  });

  test("the permission engine asks in every mode but recon, whatever allow rules say", () => {
    const req = { toolName: "GenerateImage", input: { prompt: "x", n: 4 }, readOnly: false, isEdit: true, principal: { type: "human" as const }, alwaysAsk: "GenerateImage: 4 images" };
    for (const mode of ["autopilot", "cruise", "manual"] as const) expect([mode, (createPolicy({ mode, allow: ["GenerateImage"] })(req) as { behavior: string }).behavior]).toEqual([mode, "ask"]);
    expect((createPolicy({ mode: "recon" })(req) as { behavior: string }).behavior).toBe("deny");
  });
});

describe("the gateway's images API over HTTP", () => {
  test("submit sends wait false, the idempotency key and the credential; a download sends no credential and is capped", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/images/generations")) return new Response(JSON.stringify({ id: "job-1", status: "queued", created_at: "t" }), { status: 202 });
      if (url.includes("/v1/images/jobs/")) return new Response(JSON.stringify({ id: "job-1", status: "failed", error: { code: "provider_error", message: "no" } }), { status: 200 });
      return new Response(new Uint8Array(2048), { status: 200 });
    }) as unknown as typeof fetch;
    const gw = gatewayImages({ baseUrl: "https://gw.test/", authorization: () => "Bearer k", fetch: fake, assetPrefixes: ["https://gw.test/assets/"] });
    const s = await gw.submit({ prompt: "p", model: "mlpal", n: 1, size: "1024x1024", quality: "standard" }, { idempotencyKey: "toolu_1" });
    expect(s).toEqual({ job: { id: "job-1", status: "queued", created_at: "t" } as never });
    const body = JSON.parse(String(calls[0]!.init!.body)) as Record<string, unknown>;
    expect([body.wait, body.idempotency_key, (calls[0]!.init!.headers as Record<string, string>).authorization]).toEqual([false, "toolu_1", "Bearer k"]);
    expect((await gw.job("job-1")).status).toBe("failed");
    await gw.download("https://gw.test/assets/a.png", { maxBytes: 4096, timeoutMs: 1000 });
    expect(calls.at(-1)!.init?.headers).toBeUndefined();
    await expect(gw.download("https://gw.test/assets/a.png", { maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow(/over 1000 bytes/);
  });

  test("a gateway error carries its status and code", async () => {
    const fake = (async () => new Response(JSON.stringify({ error: { message: "wallet is empty", code: "wallet_empty" } }), { status: 402 })) as unknown as typeof fetch;
    const gw = gatewayImages({ baseUrl: "https://gw.test", authorization: () => "Bearer k", fetch: fake });
    await expect(gw.submit({ prompt: "p", model: "mlpal", n: 1, size: "1024x1024", quality: "standard" }, { idempotencyKey: "k" })).rejects.toMatchObject({ status: 402, code: "wallet_empty" });
  });
});

describe("in the engine: the block reaches only a client that draws images, and the cost reaches the turn", () => {
  const { AgentSession } = require("../src/loop/agent") as typeof import("../src/loop/agent");
  const { LocalStore } = require("../src/store/local") as typeof import("../src/store/local");
  const { defaultRegistry } = require("../src/tools") as typeof import("../src/tools");
  const { GatewayError } = require("../src/gateway/client") as typeof import("../src/gateway/client");
  type MR = import("../src/gateway/client").ModelResult;
  const scripted = (results: MR[]) => {
    let i = 0;
    return {
      async *stream(): AsyncGenerator<never, MR, void> {
        const r = results[i++];
        if (!r) throw new GatewayError("script exhausted", 500);
        return r;
      },
    };
  };
  const use: MR = { model: "test", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_g1", name: "GenerateImage", input: { prompt: "a fox" } }] }, usage: { input_tokens: 10, output_tokens: 5 }, stopReason: "tool_use" };
  const done: MR = { model: "test", message: { role: "assistant", content: [{ type: "text", text: "Here it is." }] }, usage: { input_tokens: 10, output_tokens: 5 }, stopReason: "end_turn" };
  const caps = (kinds: string[]): DisplayCaps => ({ v: 1, client: "web", levels: ["text", "block"], catalogs: ["harness.v1/1"], kinds, media: { formats: ["image/png"] }, viewport: "desktop", theme: "light", locale: "en-US", timeZone: "UTC" });
  async function run(kinds: string[] | null) {
    const tools = defaultRegistry().withTools([createGenerateImageTool({ images: new FakeGateway(), models: () => [], estimate: () => 0.01, now, sleep: async () => {} }) as never]);
    const s = new AgentSession({ agentId: "a", sessionId: `s-${kinds?.length ?? 0}`, workspace: "w", cwd: root, model: "test", systemPrompt: "t", tools, store: new LocalStore(join(root, ".store")), model_client: scripted([use, done]), canUseTool: createPolicy({ mode: "autopilot" }), ...(kinds ? { display: caps(kinds) } : {}) });
    const events: Array<Record<string, unknown>> = [];
    for await (const e of s.run({ text: "make a fox" })) events.push(e as never);
    return events;
  }
  test("a client that names image gets the block; one that does not, and one with no display, get the text", async () => {
    const tr = (es: Array<Record<string, unknown>>) => es.find((e) => e.type === "tool_result") as { display?: unknown[]; content: string };
    expect(tr(await run(["chart", "image", "image_set"])).display?.length).toBe(1);
    expect(tr(await run(["chart"])).display).toBeUndefined();
    const none = tr(await run(null));
    expect([none.display, none.content.includes(`media/${DAY}/a-fox-`)]).toEqual([undefined, true]);
  });
  test("the image's compute units are in the turn's usage", async () => {
    const r = (await run(null)).find((e) => e.type === "result") as { usage: { compute_units?: number } };
    expect(r.usage.compute_units).toBeCloseTo(0.04, 6);
  });
});
