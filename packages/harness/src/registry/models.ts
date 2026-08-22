/**
 * Model registry driven from the gateway catalog. yodex never hardcodes model IDs
 * or capabilities — it reads them at runtime, so new served models work with no
 * client change.
 *
 * Discovery uses TWO endpoints, deliberately:
 *   - GET /v1/models          — the rich catalog: per-model pdf/audio/context/deprecation
 *                               metadata yodex needs (attachment gating, context display).
 *   - GET /v1/messages/models — the authoritative list of what the send endpoint
 *                               (/v1/messages) actually serves — leaner metadata, so we
 *                               use it only as an allow-list.
 * We take the INTERSECTION: the rich metadata, constrained to models /v1/messages can run.
 * (/v1/messages/models can be a strict subset — e.g. Bedrock models are OpenAI-wire only, and
 * a self-hosted box serves just its configured providers.) Best-effort: if the served
 * list is unavailable we keep the full rich catalog rather than hiding everything.
 *
 * The catalog is cached in-process with a TTL (`ensureFresh`) so a long-running REPL or
 * `yodex serve` picks up models added to the gateway after it started, without a restart.
 */

export interface ModelCapabilities {
  operation: string; // "chat" | "embedding" | ...
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  pdf: boolean;
  audio: boolean;
}

export interface ModelInfo {
  tag: string;
  displayName: string;
  provider: string;
  description?: string;
  capabilities: ModelCapabilities;
  contextLength: number | null;
  maxOutputTokens: number | null;
  pricingTier?: string;
  deprecated: boolean;
}

export interface ModelsConfig {
  baseUrl: string;
  apiKey: string;
  /** Rich catalog (metadata source). Default GET /v1/models. */
  modelsPath?: string;
  /** Authoritative served-set allow-list (what /v1/messages runs). Default /v1/messages/models. */
  servedPath?: string;
  aliasesPath?: string;
  anthropicVersion?: string;
}

/** Meta-models are server-side routing aliases; they won't appear in the catalog. */
export const META_MODELS = new Set(["mlpal", "mlpal-flash", "mlpal-lite"]);

interface RawModel {
  model_tag: string;
  display_name?: string;
  provider?: string;
  description?: string;
  capabilities?: Partial<ModelCapabilities>;
  context_length?: number | null;
  max_output_tokens?: number | null;
  pricing_tier?: string;
  is_deprecated?: boolean;
}

function toModelInfo(r: RawModel): ModelInfo {
  const c = r.capabilities ?? {};
  return {
    tag: r.model_tag,
    displayName: r.display_name ?? r.model_tag,
    provider: r.provider ?? "unknown",
    description: r.description,
    capabilities: {
      operation: c.operation ?? "chat",
      streaming: c.streaming ?? false,
      tools: c.tools ?? false,
      vision: c.vision ?? false,
      pdf: c.pdf ?? false,
      audio: c.audio ?? false,
    },
    contextLength: r.context_length ?? null,
    maxOutputTokens: r.max_output_tokens ?? null,
    pricingTier: r.pricing_tier,
    deprecated: r.is_deprecated ?? false,
  };
}

interface RawAliases {
  meta_models?: Array<{
    meta_model_tag: string;
    routings?: Array<{ operation: string; resolved_model: string }>;
  }>;
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelInfo>();
  /** meta-model tag → concrete chat model (from the gateway's published alias table) */
  private readonly chatAliases = new Map<string, string>();
  private loaded = false;
  private loadedAt = 0;

  constructor(private readonly cfg: ModelsConfig) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg.apiKey}`,
      "anthropic-version": this.cfg.anthropicVersion ?? "2023-06-01",
    };
  }

  private base(): string {
    return this.cfg.baseUrl.replace(/\/$/, "");
  }

  async load(): Promise<void> {
    // Rich catalog (metadata source).
    const res = await fetch(`${this.base()}${this.cfg.modelsPath ?? "/v1/models"}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`failed to load models: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { models?: RawModel[] };
    this.models.clear();
    for (const raw of body.models ?? []) {
      this.models.set(raw.model_tag, toModelInfo(raw));
    }
    // Constrain to what /v1/messages actually serves, and load meta-model aliases — both
    // best-effort so a transient failure doesn't wipe the catalog / block discovery.
    await this.constrainToServed().catch(() => undefined);
    await this.loadAliases().catch(() => undefined);
    this.loaded = true;
    this.loadedAt = Date.now();
  }

  /** Drop catalog entries that the send endpoint (/v1/messages) can't run, using its own
   *  model list as an allow-list — so we never offer a model that would fail on send. If the
   *  served list is unavailable or empty, leave the catalog intact (fail open, not closed). */
  private async constrainToServed(): Promise<void> {
    const res = await fetch(`${this.base()}${this.cfg.servedPath ?? "/v1/messages/models"}`, {
      headers: this.headers(),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const served = new Set((body.data ?? []).map((m) => m.id));
    if (served.size === 0) return;
    for (const tag of [...this.models.keys()]) {
      if (!served.has(tag)) this.models.delete(tag);
    }
  }

  /** Reload if the catalog is stale (or never loaded), so long-running processes pick up
   *  models added to the gateway after startup. Best-effort: keep the current catalog on a
   *  transient failure rather than throwing. Pass ttlMs=0 to force a fresh fetch. */
  async ensureFresh(ttlMs = 5 * 60_000): Promise<void> {
    if (this.loaded && Date.now() - this.loadedAt < ttlMs) return;
    await this.load().catch(() => undefined);
  }

  private async loadAliases(): Promise<void> {
    const res = await fetch(`${this.base()}${this.cfg.aliasesPath ?? "/v1/models/aliases"}`, {
      headers: this.headers(),
    });
    if (!res.ok) return;
    const body = (await res.json()) as RawAliases;
    this.chatAliases.clear();
    for (const meta of body.meta_models ?? []) {
      const chat = meta.routings?.find((r) => r.operation === "chat")?.resolved_model;
      if (chat) this.chatAliases.set(meta.meta_model_tag, chat);
    }
  }

  /** Resolve a meta-model to its concrete chat model; pass concrete tags through. */
  resolveChat(tag: string): string {
    return this.chatAliases.get(tag) ?? tag;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  get(tag: string): ModelInfo | undefined {
    return this.models.get(tag);
  }

  /** A tag is usable if it's in the catalog or is a known meta-model alias. */
  isValid(tag: string): boolean {
    return this.models.has(tag) || this.chatAliases.has(tag) || META_MODELS.has(tag);
  }

  list(opts?: { chatOnly?: boolean; includeDeprecated?: boolean }): ModelInfo[] {
    let out = [...this.models.values()];
    if (opts?.chatOnly) out = out.filter((m) => m.capabilities.operation === "chat");
    if (!opts?.includeDeprecated) out = out.filter((m) => !m.deprecated);
    return out.sort((a, b) => a.provider.localeCompare(b.provider) || a.tag.localeCompare(b.tag));
  }

  /** Suggest close matches for a mistyped tag. */
  suggest(tag: string, limit = 5): string[] {
    const needle = tag.toLowerCase();
    return [...this.models.keys()]
      .filter((t) => t.toLowerCase().includes(needle) || needle.includes(t.toLowerCase().split("-")[0]!))
      .slice(0, limit);
  }
}
