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
import type { Effort, ModelClient } from "../../gateway/client";
import { EFFORT_LADDER } from "../../gateway/client";
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
  /** The key's model policy as the gateway reports it (models hidden from this listing). */
  policyView?: () => { deniedByPolicy: number; policy: { allow?: string[]; deny?: string[] } | null } | undefined;
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
      lines.push("", `Served chat models (${rows.length}${input.provider || input.capability ? ", filtered" : ""}): tag · provider · ctx/out · caps · cost CU per 1M in/out · effort rungs (ladder ${EFFORT_LADDER.join("<")})`);
      const cm = cat?.models ?? {};
      for (const m of rows.slice(0, 80)) {
        const caps = [m.capabilities.tools && "tools", m.capabilities.vision && "vision", m.capabilities.pdf && "pdf", m.capabilities.audio && "audio"].filter(Boolean).join(",");
        const cost = cm[m.tag]?.cost ? `${cm[m.tag]!.cost.input_cu_per_1m}/${cm[m.tag]!.cost.output_cu_per_1m}` : "?";
        const lv = m.effortLevels.length ? ` · effort ${m.effortLevels[0]}…${m.effortLevels[m.effortLevels.length - 1]}${m.defaultEffort ? ` (default ${m.defaultEffort})` : ""}` : "";
        lines.push(`- ${m.tag} · ${m.provider} · ${fmtK(m.contextLength)}/${fmtK(m.maxOutputTokens)} · ${caps || "-"} · ${cost}${lv}`);
      }
      if (rows.length > 80) lines.push(`… ${rows.length - 80} more (filter by provider or capability)`);
      const pv = deps.policyView?.();
      if (pv && pv.deniedByPolicy > 0) {
        const globs = pv.policy ? ` (allow: ${(pv.policy.allow ?? []).join(", ") || "*"}; deny: ${(pv.policy.deny ?? []).join(", ") || "-"})` : "";
        lines.push("", `Your API key's model policy hides ${pv.deniedByPolicy} model(s) from this list${globs}; they cannot be used from this key.`);
      }
      lines.push(
        "",
        "You can talk to every model above. AskModel: a question to any of them (one answer, no tools), a named `thread` to keep a conversation going with the same model, `models` for a panel of up to four in parallel, `context: recent` to hand it this conversation, `attachments` for images/PDFs. Agent(model=…): a sub-agent on any of them with your tools and the repo. Tier aliases are shorthand for the right model at a cost point; meta-models let the router pick.",
      );
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
  effort?: Effort;
  thread?: string;
  reset?: boolean;
}

/** Bounds for consult threads: they live in the running process, per calling session, and must
 *  never grow silently. A capped thread refuses with its counts so the caller can start a new
 *  one (with a summary) rather than have history truncated behind the consulted model's back. */
export const THREAD_LIMITS = {
  /** user+assistant messages per thread (12 exchanges). */
  maxMessages: 24,
  /** characters of history (text + base64 attachment payloads) per thread, ~100k tokens. */
  maxChars: 400_000,
  /** threads per calling session. */
  maxThreads: 32,
} as const;

const THREAD_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface ConsultThread {
  model: string;
  system: string;
  messages: Message[];
  chars: number;
  createdAt: string;
}

/** In-process store of consult threads keyed by calling session + name. A resumed session in a
 *  new process has none (said explicitly in the tool result), which beats pretending. */
export class ThreadStore {
  private readonly threads = new Map<string, ConsultThread>();
  private key(sessionId: string, name: string): string {
    return `${sessionId}\u0000${name}`;
  }
  get(sessionId: string, name: string): ConsultThread | undefined {
    return this.threads.get(this.key(sessionId, name));
  }
  count(sessionId: string): number {
    let n = 0;
    for (const k of this.threads.keys()) if (k.startsWith(`${sessionId}\u0000`)) n += 1;
    return n;
  }
  set(sessionId: string, name: string, t: ConsultThread): void {
    this.threads.set(this.key(sessionId, name), t);
  }
  delete(sessionId: string, name: string): boolean {
    return this.threads.delete(this.key(sessionId, name));
  }
  list(sessionId: string): { name: string; model: string; turns: number }[] {
    const out: { name: string; model: string; turns: number }[] = [];
    for (const [k, t] of this.threads) {
      if (k.startsWith(`${sessionId}\u0000`)) out.push({ name: k.split("\u0000")[1]!, model: t.model, turns: t.messages.length / 2 });
    }
    return out;
  }
}

function blocksChars(blocks: ContentBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === "text") n += b.text.length;
    else if ((b.type === "image" || b.type === "document") && "source" in b) n += (b.source as { data?: string }).data?.length ?? 0;
    else n += JSON.stringify(b).length;
  }
  return n;
}

const DEFAULT_SYSTEM =
  "You are an expert engineer giving an independent, candid second opinion to another AI agent. Be specific and concrete, disagree when warranted, and say what you are unsure about.";

export function createAskModelTool(deps: GatewayToolDeps, threads: ThreadStore = new ThreadStore()): Tool<AskModelInput> {
  const cap = deps.maxTokensCap ?? 16384;
  return defineTool({
    name: "AskModel",
    description:
      "Ask another model a question and get its answer — one completion, no tools, in parallel across up to four models when you pass `models`. This is the way to get a second opinion, a specialist's take (a stronger reasoner, a longer-context reader, a different provider), a vision/PDF read, or a quick draft from a cheaper tier. The model sees ONLY what you send: `prompt` (+ `system`), optional `attachments` (image/PDF paths, capability-gated), and, with context=\"recent\", the recent turns of this conversation rendered as text. `model` is a tier alias (cheap|mid|frontier|max), a meta-model (mlpal|mlpal-flash|mlpal-lite), or any served id (see ListModels). To CONTINUE a conversation with the same model (follow-up questions, refining its draft, a multi-round review), pass `thread` — a name you choose; the first call pins the model, later calls with that name carry the whole history so the model remembers its own earlier answers; `reset: true` starts it over. Threads are single-model, capped, and live only in this running process. It costs tokens on that model; keep maxTokens tight. For work that needs repo access or tools, use Agent(model=…) instead. Never hand-roll HTTP calls to the gateway.",
    readOnly: true,
    schema: z.object({
      model: z.string().optional().describe("tier alias, meta-model, or served model id"),
      models: z.array(z.string()).min(1).max(4).optional().describe("a panel: ask each in parallel and get every answer, labeled (not combinable with thread)"),
      prompt: z.string().min(1),
      system: z.string().optional().describe("a system prompt for the consulted model (default: a neutral expert-reviewer framing; fixed for the life of a thread)"),
      context: z.enum(["none", "recent"]).optional().describe("recent = include the recent turns of this conversation (default none; in a thread, use it on the first turn)"),
      contextChars: z.number().int().min(500).max(60000).optional().describe("cap for the recent-context excerpt (default 12000)"),
      attachments: z.array(z.string()).max(8).optional().describe("image or PDF paths in the workspace to show the model"),
      maxTokens: z.number().int().min(16).optional().describe(`answer cap (default 4096, max ${cap}; Anthropic models are floored at 1024 because they think before they write)`),
      effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional().describe("reasoning effort on the gateway's universal ladder; a rung the model lacks is clamped and reported (ListModels shows each model's rungs and default)"),
      thread: z.string().optional().describe("name of a consult thread (kebab-case) to start or continue; the same model answers with the full history"),
      reset: z.boolean().optional().describe("with thread: discard that thread's history and start over on this call"),
    }),
    async call(input, ctx) {
      const maxTokens = Math.min(input.maxTokens ?? 4096, cap);
      const sessionId = ctx.sessionId ?? "no-session";

      // ── Thread bookkeeping (validated before any model call) ─────────────────────────────
      let thread: ConsultThread | undefined;
      let threadName: string | undefined;
      if (input.thread !== undefined) {
        threadName = input.thread.trim().toLowerCase();
        if (!THREAD_NAME_RE.test(threadName)) return { content: `thread name "${input.thread}" must be kebab-case (a-z, 0-9, -), up to 64 characters`, isError: true };
        if (input.models?.length) return { content: "a thread is single-model: pass `model` (or omit it to continue), not `models`", isError: true };
        if (input.reset) threads.delete(sessionId, threadName);
        thread = threads.get(sessionId, threadName);
        if (!thread && !input.model) {
          const known = threads.list(sessionId);
          return {
            content:
              `no thread "${threadName}" in this session${known.length ? ` (open threads: ${known.map((t) => `${t.name} on ${t.model}, ${t.turns} turn(s)`).join("; ")})` : ""}. ` +
              "Threads live only in the running process: pass `model` to start it" + (input.reset ? "" : " (a resumed session starts fresh)"),
            isError: true,
          };
        }
        if (!thread && threads.count(sessionId) >= THREAD_LIMITS.maxThreads) {
          return { content: `this session already has ${THREAD_LIMITS.maxThreads} consult threads; reset or reuse one`, isError: true };
        }
        if (thread && input.system !== undefined && input.system !== thread.system) {
          return { content: `thread "${threadName}" has its system prompt fixed since its first turn; omit \`system\` to continue, or reset the thread`, isError: true };
        }
        if (thread && thread.messages.length >= THREAD_LIMITS.maxMessages) {
          return {
            content: `thread "${threadName}" is at its cap (${thread.messages.length / 2} exchanges on ${thread.model}). Start a new thread with a summary of what matters, or reset this one.`,
            isError: true,
          };
        }
      }

      const refs = input.models?.length ? input.models : [input.model ?? thread?.model ?? ""];
      if (refs.length === 1 && !refs[0]) return { content: "give `model` (tier alias, meta-model, or id), `models` (a panel), or `thread` to continue", isError: true };

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
      const system = thread?.system ?? input.system ?? DEFAULT_SYSTEM;
      if (thread && thread.chars + blocksChars(userBlocks) > THREAD_LIMITS.maxChars) {
        return {
          content: `thread "${threadName}" would exceed its history cap (${THREAD_LIMITS.maxChars} characters incl. attachments). Start a new thread with a summary, or reset this one.`,
          isError: true,
        };
      }

      const one = async (ref: string): Promise<{ text: string; ok: boolean; model?: string; reply?: Message }> => {
        const r = resolveModelRef(deps, ref);
        if ("error" in r) return { text: `### ${ref}\n(error: ${r.error})`, ok: false };
        if (thread && r.model !== thread.model) {
          return { text: `### ${ref} → ${r.model}\n(error: thread "${threadName}" is pinned to ${thread.model}; omit \`model\` to continue it, or use a new thread name for ${r.model})`, ok: false };
        }
        const refusal = deps.policy?.(r.model);
        if (refusal) return { text: `### ${ref} → ${r.model}\n(not allowed: ${refusal})`, ok: false };
        const info = deps.getModel(r.model);
        const needsVision = attachmentBlocks.some((a) => a.kind === "image");
        const needsPdf = attachmentBlocks.some((a) => a.kind === "pdf");
        if (needsVision && info && !info.capabilities.vision) return { text: `### ${ref} → ${r.model}\n(error: ${r.model} cannot read images; pick a vision-capable model — ListModels capability=vision)`, ok: false };
        if (needsPdf && info && !info.capabilities.pdf) return { text: `### ${ref} → ${r.model}\n(error: ${r.model} cannot read PDFs; pick a pdf-capable model — ListModels capability=pdf)`, ok: false };
        // Thinking-capable models spend output budget on thinking BEFORE any text: a 64-token cap
        // on claude-opus-5 returned nothing. Floor Anthropic models at 1024 so a short answer
        // still has room after the thinking.
        const floor = r.model.startsWith("claude-") ? Math.max(maxTokens, 1024) : maxTokens;
        const outCap = info?.maxOutputTokens ? Math.min(floor, info.maxOutputTokens) : floor;
        const history: Message[] = thread ? thread.messages : [];
        try {
          const gen = deps.model_client.stream({
            model: r.model,
            system,
            messages: [...history, { role: "user", content: userBlocks }],
            maxTokens: outCap,
            ...(input.effort ? { effort: input.effort } : {}),
            signal: ctx.signal,
          });
          let step = await gen.next();
          while (!step.done) step = await gen.next();
          const result = step.value;
          deps.onUsage?.(result.model || r.model, { input_tokens: result.usage.input_tokens ?? 0, output_tokens: result.usage.output_tokens ?? 0 });
          const label = ref === (result.model || r.model) ? ref : `${ref} → ${result.model || r.model}`;
          const cu = result.computeUnits != null ? `, ${result.computeUnits} CU` : "";
          // Both cache legs are shown: a turn that wrote the cache reads "in 2, wrote 3895 to cache"
          // instead of a misleading "in 2", and the next turn's "+3895 cached" then makes sense.
          const cached =
            result.usage.cache_read_input_tokens || result.usage.cache_creation_input_tokens
              ? ` (${[result.usage.cache_read_input_tokens ? `+${result.usage.cache_read_input_tokens} cached` : "", result.usage.cache_creation_input_tokens ? `wrote ${result.usage.cache_creation_input_tokens} to cache` : ""].filter(Boolean).join(", ")})`
              : "";
          const eff = result.effort
            ? result.effort.applied === "unsupported"
              ? `, effort ${result.effort.requested}→unsupported (this model has no effort lever)`
              : result.effort.requested === result.effort.applied
                ? `, effort ${result.effort.applied}`
                : `, effort ${result.effort.requested}→${result.effort.applied} (clamped)`
            : "";
          const text = textOf(result.message);
          const empty = !text
            ? result.stopReason === "max_tokens"
              ? "(no text: the model used its whole maxTokens budget before writing an answer — raise maxTokens)"
              : "(no text in the reply)"
            : text;
          const turnNote = threadName ? `, thread ${threadName} turn ${history.length / 2 + 1}/${THREAD_LIMITS.maxMessages / 2}` : "";
          return {
            text: `### ${label} (in ${result.usage.input_tokens ?? 0}${cached}, out ${result.usage.output_tokens ?? 0} tokens${cu}${eff}${turnNote}${result.stopReason === "max_tokens" ? ", truncated at maxTokens" : ""})\n${empty}`,
            ok: true,
            model: r.model,
            reply: result.message,
          };
        } catch (e) {
          return { text: `### ${ref} → ${r.model}\n(error: ${String((e as Error)?.message ?? e)})`, ok: false };
        }
      };

      const answers = await Promise.all(refs.map(one));
      // A thread grows only on a successful exchange: a failed or cancelled call leaves the
      // history exactly as the consulted model last saw it.
      const first = answers[0]!;
      if (threadName && first.ok && first.model && first.reply) {
        const replyBlocks: ContentBlock[] = typeof first.reply.content === "string" ? [{ type: "text", text: first.reply.content }] : first.reply.content.filter((b) => b.type === "text");
        const assistantMsg: Message = { role: "assistant", content: replyBlocks.length ? replyBlocks : [{ type: "text", text: "(no text)" }] };
        const next: ConsultThread = thread ?? { model: first.model, system, messages: [], chars: 0, createdAt: new Date().toISOString() };
        next.messages = [...next.messages, { role: "user", content: userBlocks }, assistantMsg];
        next.chars += blocksChars(userBlocks) + blocksChars(assistantMsg.content as ContentBlock[]);
        threads.set(sessionId, threadName, next);
      }
      const anyOk = answers.some((a) => a.ok);
      return { content: answers.map((a) => a.text).join("\n\n"), isError: !anyOk };
    },
  });
}
