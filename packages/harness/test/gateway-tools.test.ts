import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@mlpal/harness-protocol";
import type { Catalog } from "../src/catalog/catalog";
import type { ModelClient, ModelRequest, ModelResult } from "../src/gateway/client";
import type { ModelInfo } from "../src/registry/models";
import { createAskModelTool, createListModelsTool, type GatewayToolDeps, resolveModelRef } from "../src/tools/builtin/gateway";

const chat = (tag: string, provider: string, over: Partial<ModelInfo> = {}, caps: Partial<ModelInfo["capabilities"]> = {}): ModelInfo => ({
  tag,
  displayName: tag,
  provider,
  capabilities: { operation: "chat", streaming: true, tools: true, vision: true, pdf: true, audio: false, ...caps },
  effortLevels: [],
  contextLength: 1_000_000,
  maxOutputTokens: 128_000,
  deprecated: false,
  ...over,
});
const MODELS: ModelInfo[] = [
  chat("claude-opus-5", "anthropic"),
  chat("gpt-6-astra", "openai", { contextLength: 1_050_000, effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" }),
  chat("gpt-5.6-luna", "openai", {}, { vision: false, pdf: false }),
  chat("old-model", "openai", { deprecated: true }),
  { ...chat("text-embed", "openai"), capabilities: { operation: "embedding", streaming: true, tools: false, vision: false, pdf: false, audio: false } },
];
const tier = (model: string, rel_cost: number) => ({ model, provider: "x", rel_cost, good_for: `${model} things`, caps: ["tools"], served_alternate: false, alternates: [] });
const CATALOG: Catalog = {
  schema: 3,
  profile: "coding",
  updated: "2026-09-07",
  tiers: { max: tier("gpt-6-astra", 100), frontier: tier("claude-opus-5", 50), mid: tier("gpt-5.6-luna", 22), cheap: tier("gpt-5.6-luna", 2) },
  routing_ladder: ["cheap", "mid", "frontier", "max"],
  quality_dimensions: ["coding", "reasoning"],
  flagships: { anthropic: "claude-opus-5", openai: "gpt-6-astra" },
  benchmark_rankings: { coding: [{ model: "gpt-6-astra", score: 74.1, source: "x" }, { model: "claude-opus-5", score: 70, source: "x" }] },
  models: { "gpt-6-astra": { provider: "openai", lineage: { provider: "openai", generation: 6, tier: "astra", tier_rank: 1, latest_in_tier: true }, context: { input: 1_050_000, output: 128_000 }, caps: ["tools"], cost: { input_cu_per_1m: 1, output_cu_per_1m: 5 }, throughput: { samples: 0 }, card: null, measured: null } },
} as unknown as Catalog;

class FakeClient implements ModelClient {
  readonly seen: ModelRequest[] = [];
  constructor(private readonly reply: (req: ModelRequest) => ModelResult | Error) {}
  async *stream(req: ModelRequest): AsyncGenerator<never, ModelResult, void> {
    this.seen.push(req);
    const r = this.reply(req);
    if (r instanceof Error) throw r;
    return r;
  }
}
const reply = (model: string, text: string): ModelResult => ({ model, message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 20, output_tokens: 7 }, stopReason: "end_turn" });

function deps(client: ModelClient, over: Partial<GatewayToolDeps> = {}): GatewayToolDeps {
  return {
    model_client: client,
    models: () => MODELS,
    getModel: (t) => MODELS.find((m) => m.tag === t),
    resolveAlias: (t) => (t === "mlpal" ? "claude-opus-5" : t),
    catalog: () => CATALOG,
    mainModel: () => "claude-opus-5",
    ...over,
  };
}
const ctx = { cwd: "/tmp", sessionId: "s1" };

describe("resolveModelRef", () => {
  test("tier alias, meta tag, id; unknown/deprecated/non-chat refused with guidance", () => {
    const d = deps(new FakeClient(() => new Error("x")));
    expect(resolveModelRef(d, "max")).toEqual({ model: "gpt-6-astra" });
    expect(resolveModelRef(d, "mlpal")).toEqual({ model: "claude-opus-5" });
    expect(resolveModelRef(d, "gpt-6-astra")).toEqual({ model: "gpt-6-astra" });
    expect(String((resolveModelRef(d, "gpt-7") as { error: string }).error)).toContain("not served");
    expect(String((resolveModelRef(d, "old-model") as { error: string }).error)).toContain("deprecated");
    expect(String((resolveModelRef(d, "text-embed") as { error: string }).error)).toContain("embedding model");
  });
});

describe("ListModels", () => {
  test("names the running model, tiers with cost, flagships, benchmark leaders, meta-models, and served chat models with cost", async () => {
    const tool = createListModelsTool(deps(new FakeClient(() => new Error("x"))));
    const out = String((await tool.call({}, ctx)).content);
    expect(out).toContain("You are running on: claude-opus-5");
    expect(out).toContain("- max: gpt-6-astra  rel_cost 100");
    expect(out).toContain("Flagships by provider: anthropic → claude-opus-5; openai → gpt-6-astra");
    expect(out).toContain("- coding: gpt-6-astra 74.1, claude-opus-5 70");
    expect(out).toContain("mlpal-flash = lowest latency");
    expect(out).toContain("- gpt-6-astra · openai · 1.05M/128k · tools,vision,pdf · 1/5 · effort low…max (default medium)");
    expect(out).toContain("- claude-opus-5 · anthropic · 1M/128k · tools,vision,pdf · ?"); // no rungs known => no effort column
    expect(out).not.toContain("old-model"); // deprecated hidden
    expect(out).not.toContain("text-embed"); // not a chat model
  });

  test("filters by capability and provider", async () => {
    const tool = createListModelsTool(deps(new FakeClient(() => new Error("x"))));
    const out = String((await tool.call({ capability: "vision", provider: "openai" }, ctx)).content);
    expect(out).toContain("gpt-6-astra");
    expect(out).not.toContain("- gpt-5.6-luna ·"); // no vision
    expect(out).not.toContain("- claude-opus-5 ·"); // other provider
  });
});

describe("AskModel", () => {
  test("one model: resolves the ref, sends prompt + system, reports tokens, records usage", async () => {
    const client = new FakeClient((req) => reply(req.model, `${req.model} says: looks right`));
    const usage: string[] = [];
    const tool = createAskModelTool(deps(client, { onUsage: (m, u) => usage.push(`${m}:${u.output_tokens}`) }));
    const r = await tool.call({ model: "max", prompt: "Is this diff safe?", maxTokens: 300 }, ctx);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("### max → gpt-6-astra (in 20, out 7 tokens)");
    expect(String(r.content)).toContain("gpt-6-astra says: looks right");
    expect(client.seen[0]!.maxTokens).toBe(300);
    expect(client.seen[0]!.system).toContain("second opinion");
    expect(usage).toEqual(["gpt-6-astra:7"]);
  });

  test("a panel asks every model in parallel and labels each answer; one failure does not sink the rest", async () => {
    const client = new FakeClient((req) => (req.model === "gpt-6-astra" ? new Error("upstream 503") : reply(req.model, "fine")));
    const tool = createAskModelTool(deps(client));
    const r = await tool.call({ models: ["gpt-6-astra", "claude-opus-5"], prompt: "review" }, ctx);
    expect(r.isError).toBeFalsy();
    expect(String(r.content)).toContain("### gpt-6-astra → gpt-6-astra\n(error: upstream 503)");
    expect(String(r.content)).toContain("### claude-opus-5 (in 20, out 7 tokens)\nfine");
  });

  test("context=recent prepends the rendered conversation; the HOP policy can refuse a model", async () => {
    const client = new FakeClient((req) => reply(req.model, "ok"));
    const tool = createAskModelTool(deps(client, {
      transcript: async (sid, max) => `[${sid}] user: fix the bug (max ${max})`,
      policy: (m) => (m === "gpt-6-astra" ? "this HOP allows only its declared tiers" : null),
    }));
    const r = await tool.call({ model: "claude-opus-5", prompt: "what did they ask?", context: "recent", contextChars: 5000 }, ctx);
    const sent = client.seen[0]!.messages[0]!.content as ContentBlock[];
    expect((sent[0] as { text: string }).text).toContain("<conversation>\n[s1] user: fix the bug (max 5000)\n</conversation>");
    const refused = await tool.call({ model: "gpt-6-astra", prompt: "x" }, ctx);
    expect(refused.isError).toBe(true);
    expect(String(refused.content)).toContain("not allowed: this HOP allows only its declared tiers");
  });

  test("attachments are capability-gated per model and sent as blocks", async () => {
    const client = new FakeClient((req) => reply(req.model, "I see a chart"));
    const png: ContentBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const tool = createAskModelTool(deps(client, { loadAttachments: async () => [{ name: "chart.png", block: png, kind: "image" }] }));
    const r = await tool.call({ models: ["gpt-6-astra", "gpt-5.6-luna"], prompt: "describe", attachments: ["chart.png"] }, ctx);
    expect(String(r.content)).toContain("### gpt-6-astra (in 20, out 7 tokens)\nI see a chart");
    expect(String(r.content)).toContain("gpt-5.6-luna cannot read images");
    expect((client.seen[0]!.messages[0]!.content as ContentBlock[])[0]!.type).toBe("image");
  });

  test("effort is sent to any provider and the applied rung is reported, with a clamp called out", async () => {
    const client = new FakeClient((req) => ({
      ...reply(req.model, "ok"),
      effort: req.effort === "none" ? { requested: "none", applied: "low" } : { requested: String(req.effort), applied: String(req.effort) },
    }));
    const tool = createAskModelTool(deps(client));
    const r = await tool.call({ models: ["gpt-6-astra", "claude-opus-5"], prompt: "x", effort: "xhigh" }, ctx);
    expect(client.seen.every((q) => q.effort === "xhigh")).toBe(true); // universal lever, not Anthropic-only
    expect(String(r.content)).toContain("### gpt-6-astra (in 20, out 7 tokens, effort xhigh)");
    const c = await tool.call({ model: "claude-opus-5", prompt: "x", effort: "none" }, ctx);
    expect(String(c.content)).toContain("effort none→low (clamped)");
  });

  test("maxTokens is capped by the host budget and the model's own output limit", async () => {
    const client = new FakeClient((req) => reply(req.model, "ok"));
    const tool = createAskModelTool(deps(client, { maxTokensCap: 2000 }));
    await tool.call({ model: "gpt-6-astra", prompt: "x", maxTokens: 999_999 }, ctx);
    expect(client.seen[0]!.maxTokens).toBe(2000);
  });

  test("Anthropic models are floored at 1024 tokens (thinking precedes text); an all-thinking reply says so", async () => {
    const client = new FakeClient((req) =>
      req.model === "claude-opus-5"
        ? { model: req.model, message: { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "s" }] }, usage: { input_tokens: 2, output_tokens: 64, cache_read_input_tokens: 1400 }, stopReason: "max_tokens" }
        : reply(req.model, "ok"),
    );
    const tool = createAskModelTool(deps(client));
    const r = await tool.call({ models: ["claude-opus-5", "gpt-6-astra"], prompt: "x", maxTokens: 64 }, ctx);
    expect(client.seen.find((q) => q.model === "claude-opus-5")!.maxTokens).toBe(1024);
    expect(client.seen.find((q) => q.model === "gpt-6-astra")!.maxTokens).toBe(64);
    expect(String(r.content)).toContain("### claude-opus-5 (in 2 (+1400 cached), out 64 tokens, truncated at maxTokens)\n(no text: the model used its whole maxTokens budget before writing an answer — raise maxTokens)");
  });
});
