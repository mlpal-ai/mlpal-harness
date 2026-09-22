import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/store/local";
import { activityStats, cacheDiagnostics, diffStat, sessionUsage, type ModelCall } from "../src/usage/stats";

const u = (input: number, out: number, cr = 0, cw = 0) => ({ input_tokens: input, output_tokens: out, cache_read_input_tokens: cr, cache_creation_input_tokens: cw });
const call = (ts: string, model: string, usage: ReturnType<typeof u>, extra: Partial<ModelCall> = {}): ModelCall => ({ ts, model, usage, ...extra });

describe("diffStat", () => {
  test("counts +/- lines, not headers", () => {
    expect(diffStat("--- a\n+++ b\n@@\n-x\n+y\n+z\n context")).toEqual({ added: 2, removed: 1 });
  });
});

describe("cacheDiagnostics", () => {
  test("hit ratio, and misses with a cause: model switch, TTL idle, or a changed prefix; cold start and tiny prompts are not misses", () => {
    const calls = [
      call("2026-09-22T10:00:00Z", "opus", u(10, 5, 0, 20_000)), // cold start
      call("2026-09-22T10:00:30Z", "opus", u(10, 5, 20_000, 100)), // hit
      call("2026-09-22T10:01:00Z", "sonnet", u(10, 5, 0, 20_100)), // model switch
      call("2026-09-22T10:20:00Z", "sonnet", u(10, 5, 0, 20_200)), // 19 min idle
      call("2026-09-22T10:20:20Z", "sonnet", u(10, 5, 0, 20_300)), // prefix changed
      call("2026-09-22T10:20:30Z", "sonnet", u(500, 5, 0, 0)), // tiny prompt: not counted
      call("2026-09-22T10:20:40Z", "sonnet", u(10, 5, 20_300, 0)), // warm again
    ];
    const d = cacheDiagnostics(calls);
    expect(d.misses.map((m) => [m.index, m.cause, m.recached])).toEqual([[2, "model switch", 20_100], [3, "idle past the cache TTL", 20_200], [4, "prompt prefix changed", 20_300]]);
    expect(d.warm).toBe(true);
    expect(d.reads).toBe(40_300);
    expect(d.hitRatio).toBeCloseTo(40_300 / (40_300 + 80_600 + 560), 3);
  });
});

describe("sessionUsage + activityStats over the store", () => {
  test("aggregates tokens, cost from the gateway's compute units, api vs wall time, code changes, tools; activity across sessions with streaks", async () => {
    const root = mkdtempSync(join(tmpdir(), "usage-"));
    const store = new LocalStore(root);
    try {
      const now = new Date("2026-09-22T12:00:00Z");
      const s1 = "s-1";
      await store.registry.putSession({ sessionId: s1, agentId: "local", cwd: "/w", workspace: "w", status: "idle", head: null, model: "opus", createdAt: "2026-09-22T10:00:00Z", updatedAt: "2026-09-22T10:10:00Z" } as never);
      await store.logs.write(s1, "model", { ts: "2026-09-22T10:00:01Z", model: "opus", stopReason: "tool_use", usage: u(10, 100, 0, 20_000), ms: 1500, computeUnits: 0.05 });
      await store.logs.write(s1, "model", { ts: "2026-09-22T10:00:05Z", model: "opus", stopReason: "end_turn", usage: u(10, 50, 20_000, 30), ms: 800, computeUnits: 0.01 });
      await store.logs.write(s1, "exec", { ts: "2026-09-22T10:00:03Z", tool: "Edit", decision: "allow", isError: false, diff: { added: 3, removed: 1 } });
      await store.logs.write(s1, "exec", { ts: "2026-09-22T10:00:04Z", tool: "Bash", decision: "allow", isError: false });
      const s2 = "s-2";
      await store.registry.putSession({ sessionId: s2, agentId: "local", cwd: "/w", workspace: "w", status: "idle", head: null, model: "sonnet", createdAt: "2026-09-20T09:00:00Z", updatedAt: "2026-09-20T09:30:00Z" } as never);
      await store.logs.write(s2, "model", { ts: "2026-09-20T09:00:01Z", model: "sonnet", stopReason: "end_turn", usage: u(5, 500, 0, 0), ms: 3000 });
      await store.registry.putSession({ sessionId: "empty", agentId: "local", cwd: "/w", workspace: "w", status: "idle", head: null, model: "opus", createdAt: "2026-09-21T09:00:00Z", updatedAt: "2026-09-21T09:00:00Z" } as never);

      const su = await sessionUsage(store, s1);
      expect(su.calls).toBe(2);
      expect(su.usage).toEqual(u(20, 150, 20_000, 20_030));
      expect(su.apiMs).toBe(2300);
      expect(su.wallMs).toBe(600_000);
      expect(su.computeUnits).toBeCloseTo(0.06, 6);
      expect(su.usd).toBeCloseTo(0.6, 6);
      expect(su.code).toEqual({ added: 3, removed: 1, edits: 1 });
      expect(su.tools).toEqual({ Edit: 1, Bash: 1 });
      expect(su.cache.warm).toBe(true);
      expect(su.models.opus!.calls).toBe(2);

      const all = await activityStats(store, { now });
      expect(all.sessions).toBe(2); // the empty session is not activity
      expect(all.activeDays).toBe(2);
      expect(all.days.map((d) => [d.day, d.sessions])).toEqual([["2026-09-20", 1], ["2026-09-22", 1]]);
      expect(all.favoriteModel).toBe("sonnet"); // by output tokens
      expect(all.mostActiveDay!.day).toBe("2026-09-22");
      expect(all.longestSession).toEqual({ sessionId: s2, ms: 1_800_000 });
      expect(all.streak).toEqual({ current: 1, longest: 1 });
      expect(all.computeUnits).toBeCloseTo(0.06, 6); // only calls that carried CU
      const week = await activityStats(store, { now, days: 1 });
      expect(week.sessions).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
