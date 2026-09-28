import { z } from "zod";
import type { DeferredTools } from "../deferred";
import type { ToolRegistry } from "../registry";
import { zodToJsonSchema } from "zod-to-json-schema";
import { sanitizeJsonSchema, type Tool } from "../types";

/**
 * ToolSearch: the model's way to load deferred tools. `query` is a keyword search over
 * deferred tool names and descriptions, or `select:name1,name2` for exact names. Matches
 * are loaded (their schemas appear on the next model call) and returned inline so the
 * model can call them right away. The description is rebuilt on every read from the live
 * deferral state, so the model always knows which servers hold deferred tools.
 */

const MAX_RESULTS = 5;

export interface ToolSearchInput {
  query: string;
  max_results?: number;
}

const schema = z.object({
  query: z.string().min(1).describe('keywords to match against deferred tool names and descriptions, or "select:name1,name2" for exact names'),
  max_results: z.number().int().min(1).max(20).optional().describe(`how many matches to load (default ${MAX_RESULTS})`),
});

function describe(deferred: DeferredTools): string {
  const pending = deferred.pending();
  const head =
    "Load deferred tools before calling them. Some MCP servers' tools are not in your tool list until you load them here: " +
    'search by keyword ("gmail send", "jira issue") or by exact name ("select:mcp__gmail__send_email,mcp__gmail__search"). ' +
    "Matched tools are loaded for the rest of this session and their schemas are returned so you can call them immediately.";
  if (pending.length === 0) return `${head} No deferred tools remain unloaded right now.`;
  const lines = pending.map((p) => `- ${p.server}: ${p.names.length} tools (${p.names.slice(0, 6).map((n) => n.replace(/^mcp__[^_]+(?:_[^_]+)*__/, "")).join(", ")}${p.names.length > 6 ? ", …" : ""})`);
  return `${head}\nDeferred right now:\n${lines.join("\n")}`;
}

/** Ranking. A query word that names a deferred server ("gmail") restricts the search to that
 *  server and is not scored further; the remaining words score 3 on the tool's own name, 1 on
 *  its description. Results are cut at half the best score, so "gmail search" loads gmail's
 *  search tool and not every gmail tool that merely mentions the word. */
function serverOf(t: Tool<unknown>): string {
  return (t.name.match(/^mcp__(.+?)__/)?.[1] ?? "").toLowerCase();
}

function localName(t: Tool<unknown>): string {
  return (t.name.match(/^mcp__.+?__(.+)$/)?.[1] ?? t.name).toLowerCase();
}

function rank(query: string, candidates: Tool<unknown>[]): Tool<unknown>[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) return [];
  const servers = new Set(candidates.map(serverOf));
  const named = words.filter((w) => servers.has(w));
  const pool = named.length ? candidates.filter((t) => named.includes(serverOf(t))) : candidates;
  const terms = words.filter((w) => !named.includes(w));
  if (terms.length === 0) return pool; // "gmail" alone: every tool of that server
  const scored = pool
    .map((t) => {
      const local = localName(t);
      const desc = t.description.toLowerCase();
      let s = 0;
      for (const w of terms) {
        if (local.includes(w)) s += 3;
        else if (desc.includes(w)) s += 1;
      }
      return { t, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const best = scored[0]?.s ?? 0;
  return scored.filter((x) => x.s >= best / 2).map((x) => x.t);
}

/** The registry must be the one whose tools the model calls (deferred tools are registered there). */
export function createToolSearchTool(deferred: DeferredTools, registry: ToolRegistry): Tool<ToolSearchInput> {
  const jsonSchema = zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
  sanitizeJsonSchema(jsonSchema);
  return {
    name: "ToolSearch",
    get description() {
      return describe(deferred);
    },
    readOnly: true,
    schema,
    jsonSchema,
    async call(input) {
      const candidates = registry.list().filter((t) => deferred.isDeferred(t.name));
      const limit = input.max_results ?? MAX_RESULTS;
      let matches: Tool<unknown>[];
      if (input.query.startsWith("select:")) {
        const wanted = input.query.slice("select:".length).split(",").map((s) => s.trim()).filter(Boolean);
        matches = wanted.map((n) => candidates.find((t) => t.name === n)).filter((t): t is Tool<unknown> => Boolean(t));
        const missing = wanted.filter((n) => !matches.some((t) => t.name === n));
        if (missing.length && matches.length === 0) {
          return { content: `No deferred tool named ${missing.join(", ")}. Deferred servers: ${deferred.pending().map((p) => `${p.server} (${p.names.join(", ")})`).join("; ") || "none"}`, isError: true };
        }
      } else {
        matches = rank(input.query, candidates).slice(0, limit);
      }
      if (matches.length === 0) {
        return { content: `No deferred tool matches "${input.query}". Deferred servers: ${deferred.pending().map((p) => `${p.server} (${p.names.join(", ")})`).join("; ") || "none"}`, isError: true };
      }
      deferred.load(matches.map((t) => t.name));
      const rendered = matches.map((t) => JSON.stringify({ name: t.name, description: t.description, input_schema: t.jsonSchema })).join("\n");
      return { content: `Loaded ${matches.length} tool${matches.length === 1 ? "" : "s"}; call them directly from now on:\n${rendered}` };
    },
  };
}
