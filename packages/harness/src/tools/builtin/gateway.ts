/**
 * Gateway-awareness tools: the loop runs on ONE model but sits on a multi-model gateway (every
 * provider on the same wire, tiers, meta-models, flagships, benchmark rankings, per-model cost).
 * Until now the only way to reach another model was to delegate a full sub-agent, which is the
 * wrong shape for "what does gpt-6-astra think of this diff?" — heavy, tool-bearing, and blind
 * to the conversation. Two read-only tools close that gap:
 *
 *   ListModels — what the key can reach: tiers with cost, flagships, benchmark leaders, served
 *                chat models with context/caps/cost. Host-provided registry + catalog; no network.
 *   AskModel   — one completion (no tools) on a named model, tier, or meta-model; a panel of
 *                up to four in parallel; optional recent-conversation context; optional image /
 *                PDF attachments (capability-gated). Reports tokens per model.
 *
 * Read-only for the permission layer (no workspace side effects) but cost-bearing: every call
 * reports its usage through `onUsage` so the host's cost meter and records stay honest, and a
 * HOP's model policy (`allowInvokeAny: false`) can restrict which models may be consulted.
 */
import { z } from "zod";
import type { ContentBlock, Message } from "@mlpal/harness-protocol";
import type { Catalog } from "../../catalog/catalog";
import { isTier, TIERS, tierModelOrNearest } from "../../catalog/catalog";
import type { ModelClient } from "../../gateway/client";
import type { ModelInfo } from "../../registry/models";
import { defineTool, type Tool } from "../types";

export interface GatewayToolDeps {
  model_client: ModelClient;
  /** Served models (chat + others) as the registry knows them; called per invocation (fresh). */
  models: () => ModelInfo[];
  getModel: (tag: string) => ModelInfo | undefined;
  /** Meta-model / alias resolution the registry publishes (e.g. mlpal → a concrete model). */
  resolveAlias: (tag: string) => string;
  /** The curated catalog (tiers, flagships, rankings, per-model cost), or null offline. */
  catalog: () => Catalog | null;
  /** The main loop's model, so the listing can say "you are running on …". */
  mainModel: () => string;
  /** HOP model policy: a refusal reason for a model the loop may not consult, or null. */
  policy?: (model: string) => string | null;
  /** The recent conversation of the calling session, rendered as text within `maxChars`. */
  transcript?: (sessionId: string, maxChars: number) => Promise<string>;
  /** Resolve workspace paths to image/document blocks (host owns the roots and size caps). */
  loadAttachments?: (paths: string[]) => Promise<{ name: string; block: ContentBlock; kind: "image" | "pdf" }[]>;
  /** Cost accounting: every completion reports its model and usage. */
  onUsage?: (model: string, usage: { input_tokens: number; output_tokens: number }) => void;
  /** Hard cap on maxTokens per completion (host budget). Default 16384. */
  maxTokensCap?: number;
}

const META_MODELS: Record<string, string> = {
  mlpal: "best quality (router picks)",
  "mlpal-flash": "lowest latency",
  "mlpal-lite": "lowest cost",
};

function fmtK(n: number | null | undefined): string {
  return n == null ? "?" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 2 : 0)}M` : `${Math.round(n / 1000)}k`;
}

/** Resolve what the model asked for (tier alias, meta tag, or id) to a served model tag. */
export function resolveModelRef(deps: GatewayToolDeps, ref: string): { model: string } | { error: string } {
  const r = ref.trim();
  if (!r) return { error: "empty model reference" };
  if (isTier(r)) {
    const cat = deps.catalog();
    const m = cat ? tierModelOrNearest(cat, r) : null;
    if (!m) return { error: `tier "${r}" has no served model right now` };
    return { model: m };
  }
  const resolved = deps.resolveAlias(r);
  const info = deps.getModel(resolved);
  if (!info) {
    const names = deps.models().filter((m) => m.capabilities.operation === "chat").map((m) => m.tag);
    const near = names.filter((n) => n.includes(r.split(/[-@]/)[0] ?? r)).slice(0, 5);
    return { error: `model "${r}" is not served by this gateway${near.length ? ` — did you mean: ${near.join(", ")}?` : ""} (ListModels shows what is)` };
  }
  if (info.capabilities.operation !== "chat") return { error: `model "${r}" is a ${info.capabilities.operation} model, not a chat model` };
  if (info.deprecated) return { error: `model "${r}" is deprecated on this gateway` };
  return { model: resolved };
}

export function createListModelsTool(deps: GatewayToolDeps): Tool<{ capability?: string; provider?: string; dimension?: string }> {
  return defineTool({
    name: "ListModels",
    description:
      "List the models this gateway serves to you: the tier aliases (cheap|mid|frontier|max) with cost and what each is good for, the meta-models (mlpal, mlpal-flash, mlpal-lite), each provider's flagship, benchmark leaders per quality dimension, and every served chat model with context window, capabilities (tools/vision/pdf/audio), and cost per million tokens in compute units. Use it before AskModel or Agent(model=…) when you need a specific strength (long context, vision, a provider's latest) rather than a tier alias. Filter with capability (vision|pdf|audio|tools), provider (anthropic|openai|google|bedrock), or dimension (a benchmark dimension) to keep the answer short.",
    readOnly: true,
    schema: z.object({
      capability: z.enum(["vision", "pdf", "audio", "tools"]).optional(),
      provider: z.string().optional(),
      dimension: z.string().optional().describe("a quality dimension from the catalog (e.g. coding, reasoning, tool_use) to rank by"),
    }),
    async call(input) {
      const cat = deps.catalog();
      const main = deps.mainModel();
      const lines: string[] = [];
      lines.push(`You are running on: ${main}${deps.getModel(main) ? ` (${deps.getModel(main)!.provider}, ctx ${fmtK(deps.getModel(main)!.contextLength)})` : ""}`);
      if (cat) {
        lines.push("", `Tiers (profile ${cat.profile}, updated ${cat.updated}; rel_cost is relative to max=100):`);
        for (const t of TIERS) {
          const ti = cat.tiers[t];
          const alts = ti.alternates.filter((a) => a.available && a.model).map((a) => a.model).join(", ");
          lines.push(`- ${t}: ${ti.model ?? "(none served)"}  rel_cost ${ti.rel_cost}  — ${ti.good_for}${alts ? `  (alternates: ${alts})` : ""}`);
        }
        if (cat.flagships && Object.keys(cat.flagships).length) {
          lines.push("", `Flagships by provider: ${Object.entries(cat.flagships).map(([p, m]) => `${p} → ${m}`).join("; ")}`);
        }
        const dims = input.dimension ? [input.dimension] : (cat.quality_dimensions ?? []);
        const br = cat.benchmark_rankings ?? {};
        const ranked = dims.filter((d) => br[d]?.length);
        if (ranked.length) {
          lines.push("", "Benchmark leaders (published scores, per dimension):");
          for (const d of ranked) lines.push(`- ${d}: ${br[d]!.slice(0, input.dimension ? 8 : 3).map((r) => `${r.model} ${r.score}`).join(", ")}`);
        }
      } else {
        lines.push("", "(catalog unavailable — tiers unknown offline; served models below are still exact)");
      }
      lines.push("", `Meta-models: ${Object.entries(META_MODELS).map(([t, d]) => `${t} = ${d}`).join("; ")}`);
      const rows = deps
        .models()
        .filter((m) => m.capabilities.operation === "chat" && !m.deprecated)
        .filter((m) => !input.provider || m.provider === input.provider)
        .filter((m) => !input.capability || m.capabilities[input.capability])
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.tag.localeCompare(b.tag));
      lines.push("", `Served chat models (${rows.length}${input.provider || input.capability ? ", filtered" : ""}): tag · provider · ctx/out · caps · cost CU per 1M in/out`);
      const cm = cat?.models ?? {};
      for (const m of rows.slice(0, 80)) {
        const caps = [m.capabilities.tools && "tools", m.capabilities.vision && "vision", m.capabilities.pdf && "pdf", m.capabilities.audio && "audio"].filter(Boolean).join(",");
        const cost = cm[m.tag]?.cost ? `${cm[m.tag]!.cost.input_cu_per_1m}/${cm[m.tag]!.cost.output_cu_per_1m}` : "?";
        lines.push(`- ${m.tag} · ${m.provider} · ${fmtK(m.contextLength)}/${fmtK(m.maxOutputTokens)} · ${caps || "-"} · ${cost}`);
      }
      if (rows.length > 80) lines.push(`… ${rows.length - 80} more (filter by provider or capability)`);
      lines.push("", "Consult a model with AskModel (one answer, no tools, sees the prompt you give it + optional recent context); give it repo access with Agent(model=…).");
      return { content: lines.join("\n") };
    },
  });
}

function textOf(message: Message): string {
  const c = message.content;
  if (typeof c === "string") return c;
  return c
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export interface AskModelInput {
  model?: string;
  models?: string[];
  prompt: string;
  system?: string;
  context?: "none" | "recent";
  contextChars?: number;
  attachments?: string[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

export function createAskModelTool(deps: GatewayToolDeps): Tool<AskModelInput> {
  const cap = deps.maxTokensCap ?? 16384;
  return defineTool({
    name: "AskModel",
    description:
      "Ask another model a question and get its answer — one completion, no tools, in parallel across up to four models when you pass `models`. This is the way to get a second opinion, a specialist's take (a stronger reasoner, a longer-context reader, a different provider), a vision/PDF read, or a quick draft from a cheaper tier. The model sees ONLY what you send: `prompt` (+ `system`), optional `attachments` (image/PDF paths, capability-gated), and, with context=\"recent\", the recent turns of this conversation rendered as text. `model` is a tier alias (cheap|mid|frontier|max), a meta-model (mlpal|mlpal-flash|mlpal-lite), or any served id (see ListModels). It costs tokens on that model; keep maxTokens tight. For work that needs repo access or tools, use Agent(model=…) instead. Never hand-roll HTTP calls to the gateway.",
    readOnly: true,
    schema: z.object({
      model: z.string().optional().describe("tier alias, meta-model, or served model id"),
      models: z.array(z.string()).min(1).max(4).optional().describe("a panel: ask each in parallel and get every answer, labeled"),
      prompt: z.string().min(1),
      system: z.string().optional().describe("a system prompt for the consulted model (default: a neutral expert-reviewer framing)"),
      context: z.enum(["none", "recent"]).optional().describe("recent = include the recent turns of this conversation (default none)"),
      contextChars: z.number().int().min(500).max(60000).optional().describe("cap for the recent-context excerpt (default 12000)"),
      attachments: z.array(z.string()).max(8).optional().describe("image or PDF paths in the workspace to show the model"),
      maxTokens: z.number().int().min(16).optional().describe(`answer cap (default 4096, max ${cap}; Anthropic models are floored at 1024 because they think before they write)`),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("reasoning effort (Anthropic models only; others ignore it)"),
    }),
    async call(input, ctx) {
      const refs = input.models?.length ? input.models : [input.model ?? ""];
      if (refs.length === 1 && !refs[0]) return { content: "give `model` (tier alias, meta-model, or id) or `models` (a panel)", isError: true };
      const maxTokens = Math.min(input.maxTokens ?? 4096, cap);

      // Shared inputs, built once.
      let contextText = "";
      if (input.context === "recent" && deps.transcript && ctx.sessionId) {
        contextText = await deps.transcript(ctx.sessionId, input.contextChars ?? 12000);
      }
      let attachmentBlocks: { name: string; block: ContentBlock; kind: "image" | "pdf" }[] = [];
      if (input.attachments?.length) {
        if (!deps.loadAttachments) return { content: "attachments are not supported by this host", isError: true };
        attachmentBlocks = await deps.loadAttachments(input.attachments);
      }
      const userBlocks: ContentBlock[] = [
        ...attachmentBlocks.map((a) => a.block),
        {
          type: "text",
          text:
            (contextText ? `Recent conversation between a developer and their coding agent, for context:\n<conversation>\n${contextText}\n</conversation>\n\n` : "") +
            input.prompt,
        },
      ];
      const system = input.system ?? "You are an expert engineer giving an independent, candid second opinion to another AI agent. Be specific and concrete, disagree when warranted, and say what you are unsure about.";

      const one = async (ref: string): Promise<string> => {
        const r = resolveModelRef(deps, ref);
        if ("error" in r) return `### ${ref}\n(error: ${r.error})`;
        const refusal = deps.policy?.(r.model);
        if (refusal) return `### ${ref} → ${r.model}\n(not allowed: ${refusal})`;
        const info = deps.getModel(r.model);
        const needsVision = attachmentBlocks.some((a) => a.kind === "image");
        const needsPdf = attachmentBlocks.some((a) => a.kind === "pdf");
        if (needsVision && info && !info.capabilities.vision) return `### ${ref} → ${r.model}\n(error: ${r.model} cannot read images; pick a vision-capable model — ListModels capability=vision)`;
        if (needsPdf && info && !info.capabilities.pdf) return `### ${ref} → ${r.model}\n(error: ${r.model} cannot read PDFs; pick a pdf-capable model — ListModels capability=pdf)`;
        // Thinking-capable models spend output budget on thinking BEFORE any text: a 64-token cap
        // on claude-opus-5 returned nothing. Floor Anthropic models at 1024 so a short answer
        // still has room after the thinking.
        const floor = r.model.startsWith("claude-") ? Math.max(maxTokens, 1024) : maxTokens;
        const outCap = info?.maxOutputTokens ? Math.min(floor, info.maxOutputTokens) : floor;
        try {
          const gen = deps.model_client.stream({
            model: r.model,
            system,
            messages: [{ role: "user", content: userBlocks }],
            maxTokens: outCap,
            ...(input.effort && r.model.startsWith("claude-") ? { effort: input.effort } : {}),
            signal: ctx.signal,
          });
          let step = await gen.next();
          while (!step.done) step = await gen.next();
          const result = step.value;
          deps.onUsage?.(result.model || r.model, { input_tokens: result.usage.input_tokens ?? 0, output_tokens: result.usage.output_tokens ?? 0 });
          const label = ref === (result.model || r.model) ? ref : `${ref} → ${result.model || r.model}`;
          const cu = result.computeUnits != null ? `, ${result.computeUnits} CU` : "";
          const cached = result.usage.cache_read_input_tokens ? ` (+${result.usage.cache_read_input_tokens} cached)` : "";
          const text = textOf(result.message);
          const empty = !text
            ? result.stopReason === "max_tokens"
              ? "(no text: the model used its whole maxTokens budget before writing an answer — raise maxTokens)"
              : "(no text in the reply)"
            : text;
          return `### ${label} (in ${result.usage.input_tokens ?? 0}${cached}, out ${result.usage.output_tokens ?? 0} tokens${cu}${result.stopReason === "max_tokens" ? ", truncated at maxTokens" : ""})\n${empty}`;
        } catch (e) {
          return `### ${ref} → ${r.model}\n(error: ${String((e as Error)?.message ?? e)})`;
        }
      };

      const answers = await Promise.all(refs.map(one));
      const anyOk = answers.some((a) => !/^### [^\n]*\n\((error|not allowed):/.test(a));
      return { content: answers.join("\n\n"), isError: !anyOk };
    },
  });
}
