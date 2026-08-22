import { afterEach, describe, expect, test } from "bun:test";
import { ModelRegistry } from "../src/registry/models";

const SAMPLE = {
  models: [
    {
      model_tag: "claude-haiku-4-5-20251001",
      display_name: "Claude Haiku 4.5",
      provider: "anthropic",
      capabilities: { pdf: true, audio: false, tools: true, vision: true, operation: "chat", streaming: true },
      context_length: 200000,
      max_output_tokens: 8192,
      pricing_tier: "economy",
      is_deprecated: false,
    },
    {
      model_tag: "amazon.titan-embed-text-v2:0",
      display_name: "Titan Embed",
      provider: "bedrock",
      capabilities: { operation: "embedding", streaming: true },
      context_length: null,
      max_output_tokens: null,
      pricing_tier: "standard",
      is_deprecated: false,
    },
    {
      model_tag: "old-model",
      provider: "anthropic",
      capabilities: { operation: "chat", streaming: true, tools: true },
      is_deprecated: true,
    },
  ],
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ModelRegistry (mocked)", () => {
  async function loaded(): Promise<ModelRegistry> {
    globalThis.fetch = (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as unknown as typeof fetch;
    const r = new ModelRegistry({ baseUrl: "http://x", apiKey: "k" });
    await r.load();
    return r;
  }

  test("loads and exposes capability metadata", async () => {
    const r = await loaded();
    const haiku = r.get("claude-haiku-4-5-20251001")!;
    expect(haiku.provider).toBe("anthropic");
    expect(haiku.capabilities.tools).toBe(true);
    expect(haiku.contextLength).toBe(200000);
    expect(haiku.maxOutputTokens).toBe(8192);
  });

  test("chatOnly filter excludes embeddings; deprecated excluded by default", async () => {
    const r = await loaded();
    const chat = r.list({ chatOnly: true });
    expect(chat.map((m) => m.tag)).toContain("claude-haiku-4-5-20251001");
    expect(chat.map((m) => m.tag)).not.toContain("amazon.titan-embed-text-v2:0");
    expect(chat.map((m) => m.tag)).not.toContain("old-model"); // deprecated
  });

  test("isValid accepts catalog tags and meta-models, rejects unknown", async () => {
    const r = await loaded();
    expect(r.isValid("claude-haiku-4-5-20251001")).toBe(true);
    expect(r.isValid("mlpal-flash")).toBe(true); // meta-model, not in catalog
    expect(r.isValid("gpt-does-not-exist")).toBe(false);
  });

  test("resolves meta-models from the alias table", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("/aliases")) {
        return new Response(
          JSON.stringify({
            meta_models: [
              {
                meta_model_tag: "mlpal",
                routings: [
                  { operation: "chat", resolved_model: "gpt-5.4" },
                  { operation: "embedding", resolved_model: "text-embedding-3-large" },
                ],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as unknown as typeof fetch;

    const r = new ModelRegistry({ baseUrl: "http://x", apiKey: "k" });
    await r.load();
    expect(r.resolveChat("mlpal")).toBe("gpt-5.4"); // meta → concrete chat model
    expect(r.resolveChat("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001"); // passthrough
    expect(r.isValid("mlpal")).toBe(true);
  });

  test("throws on non-200", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const r = new ModelRegistry({ baseUrl: "http://x", apiKey: "k" });
    await expect(r.load()).rejects.toThrow(/failed to load models/);
  });
});

const liveTest = process.env.YODEX_API_KEY ? test : test.skip;
describe("ModelRegistry live", () => {
  liveTest(
    "loads the real catalog",
    async () => {
      const r = new ModelRegistry({
        baseUrl: process.env.YODEX_GATEWAY_URL ?? "https://models.mlpal.ai",
        apiKey: process.env.YODEX_API_KEY!,
      });
      await r.load();
      const chat = r.list({ chatOnly: true });
      expect(chat.length).toBeGreaterThan(5);
      // a known launch model should be present and tool-capable
      const haiku = chat.find((m) => m.tag.startsWith("claude-haiku-4-5"));
      expect(haiku?.capabilities.tools).toBe(true);
    },
    30000,
  );
});

describe("ModelRegistry — served-set intersection + refresh", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  /** URL-aware mock: v1 catalog, v2 served allow-list, aliases; counts fetches. */
  function mock(getCatalog: () => any[], getServed: () => string[]) {
    let calls = 0;
    globalThis.fetch = (async (url: string) => {
      calls++;
      const u = String(url);
      if (u.includes("/v1/messages/models"))
        return new Response(JSON.stringify({ data: getServed().map((id) => ({ id })) }), { status: 200 });
      if (u.includes("/aliases")) return new Response(JSON.stringify({}), { status: 200 });
      return new Response(JSON.stringify({ models: getCatalog() }), { status: 200 });
    }) as unknown as typeof fetch;
    return () => calls;
  }

  test("constrains to the /v1/messages served set, keeping the rich metadata", async () => {
    mock(
      () => [
        { model_tag: "claude-x", capabilities: { operation: "chat", pdf: true, tools: true }, context_length: 200000 },
        { model_tag: "llama-bedrock", capabilities: { operation: "chat", tools: true } },
      ],
      () => ["claude-x"], // /v1/messages serves only claude-x
    );
    const r = new ModelRegistry({ baseUrl: "http://x", apiKey: "k" });
    await r.load();
    expect(r.isValid("claude-x")).toBe(true);
    expect(r.isValid("llama-bedrock")).toBe(false); // dropped — not servable via /v1/messages
    expect(r.get("claude-x")!.capabilities.pdf).toBe(true); // rich metadata retained from v1
    expect(r.get("claude-x")!.contextLength).toBe(200000);
  });

  test("fails open — keeps the full catalog when the served list is empty/unavailable", async () => {
    mock(
      () => [{ model_tag: "a", capabilities: { operation: "chat" } }, { model_tag: "b", capabilities: { operation: "chat" } }],
      () => [], // served list empty → don't hide anything
    );
    const r = new ModelRegistry({ baseUrl: "http://x", apiKey: "k" });
    await r.load();
    expect(r.isValid("a")).toBe(true);
    expect(r.isValid("b")).toBe(true);
  });

  test("ensureFresh reloads when stale (picks up new models), skips when fresh", async () => {
    let catalog = [{ model_tag: "a", capabilities: { operation: "chat" } }];
    let served = ["a"];
    const calls = mock(() => catalog, () => served);
    const r = new ModelRegistry({ baseUrl: "http://x", apiKey: "k" });
    await r.load();
    expect(r.isValid("b")).toBe(false);
    const afterLoad = calls();

    await r.ensureFresh(60_000); // fresh → no refetch
    expect(calls()).toBe(afterLoad);

    // gateway adds model "b"
    catalog = [...catalog, { model_tag: "b", capabilities: { operation: "chat" } }];
    served = ["a", "b"];
    await r.ensureFresh(0); // force refresh
    expect(calls()).toBeGreaterThan(afterLoad);
    expect(r.isValid("b")).toBe(true);
  });
});
