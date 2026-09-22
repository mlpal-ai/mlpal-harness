import { z } from "zod";
import { defineTool, err, ok, type Tool, type ToolContext, type ToolResult } from "../types";

/**
 * WebSearch + Research: live web access as first-class tools. Backend-agnostic — the host wires
 * `backend` to the platform web-search service (Perplexity Sonar behind the MLPal key, billed in
 * CU per call) or to a pack-provided server; the model sees two stable tools either way.
 *
 * What stays in context is deliberate: a search returns the synthesized answer plus a short
 * source list, capped, because that is what the model reasons over; a deep research report is
 * long and slow (minutes), so its full text is spilled to a session artifact and the context gets
 * the head of it plus the path. Both are read-only: nothing on the estate changes, the cost is a
 * consult, shown by the host beside AskModel consults. Session caps stop a runaway search loop.
 */
export type SearchKind = "web_search" | "web_search_pro" | "web_search_reasoning" | "web_search_deep";
export type Recency = "hour" | "day" | "week" | "month" | "year";

export interface WebSearchDeps {
  /** Run one backend call. Returns the tool result as the backend produced it (JSON text). */
  backend: (kind: SearchKind, args: { query: string; recency?: Recency; domains?: string[] }, ctx: ToolContext) => Promise<ToolResult>;
  /** Is the backend reachable now? Off => the tools explain instead of failing opaquely. */
  available: () => boolean;
  /** Persist a long report; returns the path the model can Read. */
  spill: (ctx: ToolContext, name: string, text: string) => Promise<string>;
  /** Metering hook for the host's /cost line. */
  onCall?: (kind: SearchKind, ms: number, ok: boolean) => void;
  /** Per-session caps (defaults: 200 searches, 20 research calls). */
  maxSearches?: number;
  maxResearch?: number;
}

export interface SearchAnswer {
  query: string;
  answer: string;
  model?: string;
  sources: { title?: string; url?: string; date?: string }[];
}

export const SEARCH_MAX_SOURCES = 10;
export const SEARCH_MAX_CHARS = 6000;
export const RESEARCH_HEAD_CHARS = 2500;

/** The backend's JSON `{query, answer, model, search_results}`; anything else is passed through as
 *  plain text so a differently shaped backend still works, just without the source list. */
export function parseSearchResult(content: string): SearchAnswer | null {
  try {
    const j = JSON.parse(content) as { query?: string; answer?: string; model?: string; search_results?: SearchAnswer["sources"] };
    if (typeof j.answer !== "string") return null;
    return { query: j.query ?? "", answer: j.answer, model: j.model, sources: Array.isArray(j.search_results) ? j.search_results : [] };
  } catch {
    return null;
  }
}

function renderSources(sources: SearchAnswer["sources"], max = SEARCH_MAX_SOURCES): string {
  const shown = sources.slice(0, max);
  if (!shown.length) return "";
  const lines = shown.map((s, i) => `${i + 1}. ${s.title ?? s.url ?? "source"}${s.url ? ` — ${s.url}` : ""}${s.date ? ` (${s.date})` : ""}`);
  const more = sources.length > max ? `\n(${sources.length - max} more sources omitted)` : "";
  return `\n\nSources:\n${lines.join("\n")}${more}`;
}

/** A backend result as text (block results are joined; only text blocks carry an answer). */
function textOf(r: ToolResult): string {
  return typeof r.content === "string" ? r.content : r.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

function clip(text: string, max: number): { text: string; clipped: boolean } {
  return text.length <= max ? { text, clipped: false } : { text: `${text.slice(0, max)}…`, clipped: true };
}

const recencySchema = z.enum(["hour", "day", "week", "month", "year"]).optional().describe("only results from the last hour/day/week/month/year");
const domainsSchema = z.array(z.string()).max(20).optional().describe("limit to these domains, e.g. [\"docs.python.org\", \"github.com\"]");

export function createWebSearchTools(deps: WebSearchDeps): Tool<unknown>[] {
  const counts = { searches: 0, research: 0 };
  const maxSearches = deps.maxSearches ?? 200;
  const maxResearch = deps.maxResearch ?? 20;

  const run = async (kind: SearchKind, args: { query: string; recency?: Recency; domains?: string[] }, ctx: ToolContext): Promise<{ raw: ToolResult; parsed: SearchAnswer | null; ms: number }> => {
    const t0 = Date.now();
    const raw = await deps.backend(kind, args, ctx);
    const ms = Date.now() - t0;
    deps.onCall?.(kind, ms, !raw.isError);
    return { raw, parsed: raw.isError ? null : parseSearchResult(textOf(raw)), ms };
  };

  const webSearch = defineTool({
    name: "WebSearch",
    description:
      "Search the live web and get a synthesized answer with cited sources. Use it for anything current or beyond your training data — versions, prices, docs, news, APIs, errors — instead of disclaiming that you lack current information; never guess at current facts. Results are compact (answer + up to 10 sources); use WebFetch to read a specific source in full. For hard multi-part questions or a full report, use Research.",
    readOnly: true,
    schema: z.object({
      query: z.string().min(1).max(2000).describe("a natural-language question or search phrase"),
      recency: recencySchema,
      domains: domainsSchema,
    }),
    async call(input, ctx) {
      if (!deps.available()) return err("web search is not available in this session (the search service is not configured or not connected)");
      if (counts.searches >= maxSearches) return err(`session search cap reached (${maxSearches}); stop searching and work with what you have`);
      counts.searches += 1;
      const { raw, parsed } = await run("web_search", input, ctx);
      if (raw.isError) return raw;
      if (!parsed) return ok(clip(textOf(raw), SEARCH_MAX_CHARS).text);
      const body = clip(parsed.answer, SEARCH_MAX_CHARS);
      return ok(`${body.text}${renderSources(parsed.sources)}`);
    },
  });

  const research = defineTool({
    name: "Research",
    description:
      "Deeper web research than WebSearch, at a higher cost. depth=\"pro\": nuanced or multi-part comparisons (seconds). depth=\"reasoning\": step-by-step analysis across sources (seconds). depth=\"deep\": an exhaustive report over dozens of sources, taking minutes — the full report is saved to a file whose path is returned with the report's head; Read the file for the rest. Each call is billed; use it when a quick WebSearch is not enough, not by default.",
    readOnly: true,
    schema: z.object({
      query: z.string().min(1).max(4000).describe("the question or research topic"),
      depth: z.enum(["pro", "reasoning", "deep"]).default("pro"),
      recency: recencySchema,
      domains: domainsSchema,
    }),
    async call(input, ctx) {
      if (!deps.available()) return err("research is not available in this session (the search service is not configured or not connected)");
      if (counts.research >= maxResearch) return err(`session research cap reached (${maxResearch})`);
      counts.research += 1;
      const kind: SearchKind = input.depth === "deep" ? "web_search_deep" : input.depth === "reasoning" ? "web_search_reasoning" : "web_search_pro";
      // The backend's tools take exactly their own arguments (a strict schema): `depth` is ours,
      // and deep research takes only the query — a stray key is a validation error, not ignored.
      const args = kind === "web_search_deep" ? { query: input.query } : { query: input.query, recency: input.recency, domains: input.domains };
      const { raw, parsed } = await run(kind, args, ctx);
      if (raw.isError) return raw;
      const answer = parsed?.answer ?? textOf(raw);
      const sources = parsed?.sources ?? [];
      if (input.depth !== "deep") return ok(`${clip(answer, SEARCH_MAX_CHARS).text}${renderSources(sources)}`);
      const full = `# Research: ${input.query}\n\n${answer}${renderSources(sources, 100)}\n`;
      const path = await deps.spill(ctx, `research-${counts.research}.md`, full);
      const head = clip(answer, RESEARCH_HEAD_CHARS);
      return ok(`${head.text}${head.clipped ? `\n\n(report continues — full text with ${sources.length} sources saved to ${path}; Read it for the rest)` : `\n\n(full report saved to ${path})`}${renderSources(sources)}`);
    },
  });

  return [webSearch as Tool<unknown>, research as Tool<unknown>];
}
