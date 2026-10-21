import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ClientMessage, HARNESS_PROTOCOL_VERSION, type ServerCapability, type ServerMessage, type WorkspaceStats } from "../src/index";

const zero = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

describe("protocol 0.20", () => {
  test("HARNESS_PROTOCOL_VERSION is the package's version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
    expect(HARNESS_PROTOCOL_VERSION).toBe(pkg.version);
  });

  test("workspace_stats round-trips as a request and a reply; the additions are typed", () => {
    const cap: ServerCapability = "workspace_stats";
    const req: ClientMessage = { type: "workspace_stats", requestId: "r1", range: "7d", tz: "America/Los_Angeles", hop: "coding", sessions: { offset: 20, limit: 20 } };
    const stats: WorkspaceStats = {
      generatedAt: "2026-10-20T12:00:00.000Z",
      range: "7d",
      tz: "America/Los_Angeles",
      window: { since: "2026-10-14T07:00:00.000Z", until: "2026-10-20T12:00:00.000Z" },
      scope: { hop: "coding" },
      coverage: { sessions: 3, counted: 2, unstamped: 1, partial: 0 },
      totals: { usage: zero, computeUnits: 0, usd: 0, sessions: 2, subagents: 0, runs: 2, calls: 3, toolRuns: 1, toolErrors: 0, denied: 0, compactions: 0, checkpoints: 0, parked: 0, cacheHitRatio: 0, code: { added: 0, removed: 0 } },
      days: [{ day: "2026-10-20", usage: zero, computeUnits: 0, sessions: 2, subagents: 0, runs: 2, calls: 3, byModel: { m: { tokens: 0, cu: 0 } } }],
      history: [{ day: "2026-10-20", usage: zero, computeUnits: 0 }],
      perModel: { m: { calls: 3, usage: zero, computeUnits: 0, ms: 10, avgCallMs: 10 / 3, share: 1 }, n: { calls: 1, usage: zero, computeUnits: 0, ms: 0, share: 0 } },
      modelSlots: ["m"],
      perHop: { "coding@1.0.0": { sessions: 2, runs: 2, computeUnits: 0, lastAt: null } },
      perProject: { work: { sessions: 2, runs: 2, computeUnits: 0, lastAt: null } },
      perTool: { Bash: { runs: 1, errors: 0, denied: 0, ms: 5 } },
      outcomes: { success: 2, error: 0, max_turns: 0, cancelled: 0, needs_approval: 0 },
      streak: { current: 1, longest: 1 },
      topSessions: [{ sessionId: "s", title: "t", model: "m", status: "idle", computeUnits: 0, tokens: 0, runs: 2, updatedAt: "2026-10-20T11:00:00.000Z" }],
      sessionsTotal: 1,
    };
    const reply: ServerMessage = { type: "workspace_stats", requestId: "r1", ...stats };
    const ready: ServerMessage = { type: "ready", protocol: "yodex/2", capabilities: [cap], engine: { name: "yodex", version: "0.8.0", sha: "abc", harnessProtocol: HARNESS_PROTOCOL_VERSION } };
    const page: ClientMessage = { type: "list_sessions", includeChildren: true, before: "s", limit: 50 };
    const seek: ClientMessage = { type: "list_sessions", before: { updatedAt: "2026-10-20T00:00:00.000Z", sessionId: "s" }, limit: 50 };
    const sessions: ServerMessage = { type: "sessions", sessions: [{ sessionId: "s", agentId: "a", status: "idle", model: "m", updatedAt: "x", title: "t", createdAt: "w" }], hasMore: false };
    const usage: ServerMessage = { type: "session_usage", sessionId: "s", calls: 1, usage: zero, models: { m: { calls: 1, usage: zero, ms: 4, computeUnits: 0.1 } }, apiMs: 4, wallMs: 9, tools: { Bash: 1 }, code: { added: 1, removed: 0, edits: 1 }, cache: { hitRatio: 0.5 } };
    for (const m of [req, reply, ready, page, seek, sessions, usage]) expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });
});
