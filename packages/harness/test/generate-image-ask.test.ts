import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineEvent, ImageAskDetail } from "@mlpal/harness-protocol";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import type { ImageGateway, ImageRequest } from "../src/gateway/images";
import { AgentSession, type AskContext } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import type { ModelInfo } from "../src/registry/models";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";
import { createGenerateImageTool, type GenerateImageDeps } from "../src/tools/builtin/image";

/** The approval card's detail (protocol ToolAskDetail): it states exactly what the call then submits. */
const magic = JSON.parse(readFileSync(new URL("../../protocol/test/fixtures/display/media-magic.vectors.json", import.meta.url), "utf8")) as { vectors: Array<{ name: string; hex: string }> };
const PNG = Buffer.from(magic.vectors.find((v) => v.name === "png 1536x1024")!.hex, "hex");
const DAY = "2026-11-28";
const MODEL: ModelInfo = { tag: "gpt-image-2", displayName: "GPT Image 2", provider: "openai", capabilities: { operation: "image_generation", streaming: false, tools: false, vision: false, pdf: false, audio: false }, contextLength: null, maxOutputTokens: null, deprecated: false, effortLevels: [] };

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "genimg-ask-"));
  mkdirSync(join(root, "uploads"));
  writeFileSync(join(root, "uploads", "ref.png"), PNG);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function gateway() {
  const submits: ImageRequest[] = [];
  const gw: ImageGateway = {
    submit: async (req) => (submits.push(req), { result: { data: Array.from({ length: req.n }, (_, i) => ({ url: `https://a.test/${i}.png` })), model: req.model, cost: { compute_units: 0.08 } } }),
    job: async () => {
      throw new Error("no job");
    },
    download: async () => PNG,
  };
  return { gw, submits };
}
const deps = (gw: ImageGateway, extra: Partial<GenerateImageDeps> = {}): GenerateImageDeps => ({ images: gw, models: () => [MODEL], estimate: ({ n, quality }) => n * (quality === "hd" ? 0.04 : 0.01), now: () => new Date(`${DAY}T10:00:00Z`), ...extra });

describe("GenerateImage's ask detail is what the call then submits", () => {
  test("count, size, quality, model, references, destination and estimate match the submit and the files written", async () => {
    const { gw, submits } = gateway();
    const tool = createGenerateImageTool(deps(gw));
    const input = { prompt: "two foxes", n: 2, quality: "hd", size: "landscape", model: "gpt-image-2", references: ["uploads/ref.png"] };
    const detail = tool.askDetail!(input) as ImageAskDetail;
    expect(detail).toEqual({ kind: "generate_image", count: 2, size: "landscape", quality: "hd", model: "gpt-image-2", routed: false, destination: `media/${DAY}`, references: ["uploads/ref.png"], estimateCu: 0.08, reasons: ["several_images", "hd", "over_threshold"] });
    const r = await tool.call(input as never, { cwd: root, roots: [root], toolUseId: "toolu_a" });
    expect(r.isError ?? false).toBe(false);
    const sent = submits[0]!;
    expect([sent.n, sent.size, sent.quality, sent.model, sent.reference_images?.length]).toEqual([detail.count, detail.size, detail.quality, detail.model, detail.references.length]);
    expect(readdirSync(join(root, detail.destination)).length).toBe(2);
  });

  test("the defaults are the submit's; no estimate is absent (never 0) with its reason; mlpal is routed; a re-save has none", async () => {
    const { gw, submits } = gateway();
    const tool = createGenerateImageTool(deps(gw, { estimate: () => null }));
    const detail = tool.askDetail!({ prompt: "a fox" }) as ImageAskDetail;
    expect(detail).toEqual({ kind: "generate_image", count: 1, size: "1024x1024", quality: "standard", model: "mlpal", routed: true, destination: `media/${DAY}`, references: [], reasons: ["no_estimate"] });
    expect("estimateCu" in detail).toBe(false);
    await tool.call({ prompt: "a fox" } as never, { cwd: root, roots: [root], toolUseId: "toolu_b" });
    expect([submits[0]!.n, submits[0]!.size, submits[0]!.quality, submits[0]!.model]).toEqual([1, "1024x1024", "standard", "mlpal"]);
    expect(tool.askDetail!({ job: "job-1" })).toBeNull();
    // a cheap single image asks only by the mode: the detail is still there, with no reason of its own
    expect((createGenerateImageTool(deps(gw)).askDetail!({ prompt: "a fox", model: "gpt-image-2" }) as ImageAskDetail).reasons).toEqual([]);
  });

  test("through the engine: the person's answerer receives the detail on the ask, and the call submits exactly it", async () => {
    const { gw, submits } = gateway();
    const tools = new ToolRegistry();
    tools.register(createGenerateImageTool(deps(gw)) as never);
    const input = { prompt: "four robots", n: 4, model: "gpt-image-2" };
    const scripts: ModelResult[] = [
      { model: "test", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_c", name: "GenerateImage", input }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "tool_use" },
      { model: "test", message: { role: "assistant", content: [{ type: "text", text: "done" }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" },
    ];
    let i = 0;
    const model: ModelClient = {
      async *stream(_r: ModelRequest): AsyncGenerator<never, ModelResult, void> {
        const r = scripts[i++];
        if (!r) throw new GatewayError("script exhausted", 500);
        return r;
      },
    };
    const seen: AskContext[] = [];
    const s = new AgentSession({ agentId: "a", sessionId: "s1", workspace: "w", cwd: root, model: "test", systemPrompt: "t", tools, store: new LocalStore(join(root, ".store")), model_client: model, canUseTool: createPolicy({ mode: "autopilot" }), onAsk: async (_req, ask) => (seen.push(ask!), { behavior: "allow" }) });
    const events: EngineEvent[] = [];
    for await (const e of s.run({ text: "robots" })) events.push(e);
    const detail = seen[0]!.askDetail as ImageAskDetail;
    expect([detail.count, detail.model, detail.reasons, detail.estimateCu]).toEqual([4, "gpt-image-2", ["several_images", "over_threshold"], 0.04]);
    expect([submits.length, submits[0]!.n, submits[0]!.model, submits[0]!.size, submits[0]!.quality]).toEqual([1, detail.count, detail.model, detail.size, detail.quality]);
  });
});
