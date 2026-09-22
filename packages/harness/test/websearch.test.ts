import { describe, expect, test } from "bun:test";
import { createWebSearchTools, parseSearchResult, RESEARCH_HEAD_CHARS, SEARCH_MAX_SOURCES, type SearchKind } from "../src/tools/builtin/websearch";
import type { ToolContext, ToolResult } from "../src/tools/types";

const ctx = { cwd: "/tmp", sessionId: "s1" } as ToolContext;
const backendJson = (answer: string, n = 3): string =>
  JSON.stringify({ query: "q", answer, model: "sonar", search_results: Array.from({ length: n }, (_, i) => ({ title: `T${i}`, url: `https://x/${i}`, date: "2026-09-22" })) });

function harness(opts: { answer?: string; sources?: number; error?: string; available?: boolean; maxSearches?: number; maxResearch?: number } = {}) {
  const calls: { kind: SearchKind; args: unknown }[] = [];
  const spilled: { name: string; text: string }[] = [];
  const metered: { kind: SearchKind; ok: boolean }[] = [];
  const [webSearch, research] = createWebSearchTools({
    backend: async (kind, args): Promise<ToolResult> => {
      calls.push({ kind, args });
      if (opts.error) return { content: opts.error, isError: true };
      return { content: backendJson(opts.answer ?? "the answer", opts.sources ?? 3) };
    },
    available: () => opts.available ?? true,
    spill: async (_c, name, text) => { spilled.push({ name, text }); return `/art/${name}`; },
    onCall: (kind, _ms, ok) => metered.push({ kind, ok }),
    maxSearches: opts.maxSearches,
    maxResearch: opts.maxResearch,
  });
  return { webSearch: webSearch!, research: research!, calls, spilled, metered };
}

describe("parseSearchResult", () => {
  test("reads the platform shape; non-JSON or answer-less JSON is null (passed through as text)", () => {
    const p = parseSearchResult(backendJson("hi", 2))!;
    expect(p.answer).toBe("hi");
    expect(p.sources).toHaveLength(2);
    expect(parseSearchResult("plain text")).toBeNull();
    expect(parseSearchResult(JSON.stringify({ nope: 1 }))).toBeNull();
  });
});

describe("WebSearch", () => {
  test("calls the quick backend with recency/domains and returns answer + capped numbered sources", async () => {
    const h = harness({ sources: 14 });
    const r = await h.webSearch.call({ query: "bun 1.3 release date", recency: "month", domains: ["bun.sh"] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(h.calls[0]).toEqual({ kind: "web_search", args: { query: "bun 1.3 release date", recency: "month", domains: ["bun.sh"] } });
    const text = r.content as string;
    expect(text.startsWith("the answer")).toBe(true);
    expect(text).toContain(`${SEARCH_MAX_SOURCES}. T${SEARCH_MAX_SOURCES - 1} — https://x/${SEARCH_MAX_SOURCES - 1} (2026-09-22)`);
    expect(text).toContain("(4 more sources omitted)");
    expect(h.metered).toEqual([{ kind: "web_search", ok: true }]);
  });
  test("read-only tool; backend errors pass through as tool errors; unavailable backend explains", async () => {
    expect(harness().webSearch.readOnly).toBe(true);
    const e = await harness({ error: "MCP server \"websearch\" is unreachable" }).webSearch.call({ query: "x" }, ctx);
    expect(e.isError).toBe(true);
    const off = await harness({ available: false }).webSearch.call({ query: "x" }, ctx);
    expect(off.isError).toBe(true);
    expect(off.content).toContain("not available");
  });
  test("session cap stops a runaway loop", async () => {
    const h = harness({ maxSearches: 2 });
    await h.webSearch.call({ query: "a" }, ctx);
    await h.webSearch.call({ query: "b" }, ctx);
    const third = await h.webSearch.call({ query: "c" }, ctx);
    expect(third.isError).toBe(true);
    expect(third.content).toContain("cap reached (2)");
    expect(h.calls).toHaveLength(2);
  });
});

describe("Research", () => {
  test("depth maps to the backend tier; pro/reasoning stay inline", async () => {
    const h = harness();
    await h.research.call({ query: "q", depth: "pro" }, ctx);
    await h.research.call({ query: "q", depth: "reasoning" }, ctx);
    expect(h.calls.map((c) => c.kind)).toEqual(["web_search_pro", "web_search_reasoning"]);
    expect(h.spilled).toHaveLength(0);
  });
  test("deep: the full report is spilled to a session artifact and the context gets the head + path", async () => {
    const long = "L".repeat(RESEARCH_HEAD_CHARS * 3);
    const h = harness({ answer: long, sources: 40 });
    const r = await h.research.call({ query: "market", depth: "deep" }, ctx);
    expect(h.calls[0]!.kind).toBe("web_search_deep");
    expect(h.spilled).toHaveLength(1);
    expect(h.spilled[0]!.name).toBe("research-1.md");
    expect(h.spilled[0]!.text).toContain("# Research: market");
    expect(h.spilled[0]!.text).toContain("40. T39"); // every source in the file
    const text = r.content as string;
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain("saved to /art/research-1.md");
    expect(text).toContain("Read it for the rest");
    expect(text).not.toContain("40. T39"); // context keeps the capped list
  });
  test("research has its own, smaller cap", async () => {
    const h = harness({ maxResearch: 1 });
    await h.research.call({ query: "q" }, ctx);
    const r = await h.research.call({ query: "q" }, ctx);
    expect(r.isError).toBe(true);
    expect(h.calls).toHaveLength(1);
  });
});
