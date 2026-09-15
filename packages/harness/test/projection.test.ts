import { describe, expect, test } from "bun:test";
import { fetchMemoryProjection, projectionSection, projectionUrl } from "../src/memory/projection";

const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;

describe("memory projection (memory v6 E2)", () => {
  test("url: workspace/hop/budget always, inject only when non-empty, budget clamped to the service's 200..50000", () => {
    const u = new URL(projectionUrl({ endpoint: "http://localhost:8000/", workspace: "infra", hop: "infra", inject: ["infra/state/watch", "infra/state/cost"], tokenBudget: 1500 }));
    expect(u.pathname).toBe("/api/v1/memory/projection");
    expect(u.searchParams.get("workspace")).toBe("infra");
    expect(u.searchParams.get("hop")).toBe("infra");
    expect(u.searchParams.get("inject")).toBe("infra/state/watch,infra/state/cost");
    expect(u.searchParams.get("token_budget")).toBe("1500");
    const none = new URL(projectionUrl({ endpoint: "http://m", workspace: "w", hop: "h", inject: [], tokenBudget: 10 }));
    expect(none.searchParams.has("inject")).toBe(false);
    expect(none.searchParams.get("token_budget")).toBe("200"); // the service 422s below 200
    expect(new URL(projectionUrl({ endpoint: "http://m", workspace: "w", hop: "h", inject: [], tokenBudget: 1e9 })).searchParams.get("token_budget")).toBe("50000");
  });

  test("a 200 with the documented shape is a projection; the headers ride along", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const f = (async (_u: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({ markdown: "# Memory\n\n## State (current)\n- a:b = c", estimated_tokens: 22, fact_count: 1, truncated: false }) };
    }) as unknown as typeof fetch;
    const out = await fetchMemoryProjection({ endpoint: "http://m", workspace: "w", hop: "h", inject: [], tokenBudget: 1500, headers: { Authorization: "Bearer k", "X-Test-Org-Id": "t" }, fetchImpl: f });
    expect(out).toEqual({ ok: true, projection: { markdown: "# Memory\n\n## State (current)\n- a:b = c", estimatedTokens: 22, factCount: 1, truncated: false } });
    expect(seenHeaders).toEqual({ Authorization: "Bearer k", "X-Test-Org-Id": "t" });
  });

  test("non-2xx, a wrong shape and a thrown fetch are failures with a reason — never a throw, never an empty projection", async () => {
    const base = { endpoint: "http://m", workspace: "w", hop: "h", inject: [], tokenBudget: 1500, headers: {} };
    expect(await fetchMemoryProjection({ ...base, fetchImpl: fakeFetch(503, {}) })).toEqual({ ok: false, error: "HTTP 503" });
    expect(await fetchMemoryProjection({ ...base, fetchImpl: fakeFetch(200, { notes: [] }) })).toMatchObject({ ok: false });
    const dead = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    expect(await fetchMemoryProjection({ ...base, fetchImpl: dead })).toEqual({ ok: false, error: "ECONNREFUSED" });
  });

  test("section: drops the service's top heading, frames it like the local injection, empty when no facts, notes truncation", () => {
    const s = projectionSection({ markdown: "# Memory\n\n## State (current)\n- x = 1", estimatedTokens: 9, factCount: 1, truncated: true });
    expect(s.startsWith("\n\n# Derived memories\n")).toBe(true);
    expect(s).toContain("## State (current)\n- x = 1");
    expect(s).not.toContain("# Memory\n");
    expect(s).toContain("omitted to fit the memory budget");
    expect(projectionSection({ markdown: "# Memory\n", estimatedTokens: 2, factCount: 0, truncated: false })).toBe("");
  });
});
