import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { ConversationEntry, DisplayCaps } from "@mlpal/harness-protocol";
import { createShowTool, foldDisplayHistory, resolveDisplay } from "../src/display";
import { silentLogger } from "../src/obs/logger";
import { MemoryMetrics } from "../src/obs/metrics";

/**
 * The first real-model run (reports/harness-ui-next/v1: engine 7471c4f, Haiku 5.5 and Sonnet 5.5, web UI): 34 Show
 * calls, 20 refused at the time. Each input is replayed as a first attempt against its session as it stood, through
 * the engine's Show, and must come out as recorded below. When a change makes more of them pass, update EXPECTED.
 */
type Payload = { type: string; uuid?: string; ts?: string; message?: { content?: unknown }; toolUseId?: string; toolName?: string; isError?: boolean };
const fixture = JSON.parse(readFileSync(new URL("./fixtures/display/workbox-v1-shows.json", import.meta.url), "utf8")) as { sessions: Array<{ where: string; events: Payload[] }> };
const WEB: DisplayCaps = { v: 1, client: "web", levels: ["text", "block"], catalogs: ["harness.v1/1"], viewport: "desktop", theme: "dark", locale: "en-US", timeZone: "UTC" };

/** Outcome per Show call, keyed by "<where> <last 8 of the tool_use id>": "ok", or the faults listed in order. */
const EXPECTED: Record<string, string> = {
  "fab-watch/g1-01-shift 7i4mevmc": "ok",
  "fab-watch/g1-01-shift cPuujyW8": "ok",
  "fab-watch/g1-03-pareto Pi1kvbVn": "VALIDATION_FAILED fallback.table.columns[2]",
  "fab-watch/g1-03-pareto wJ6BYeZV": "ok",
  "fab-watch/g1-04-colour BDQYFqqf": "VALIDATION_FAILED fallback.table.columns[3]",
  "fab-watch/g1-04-colour D8fQUXz5": "ok",
  "finance-desk/g1-01-book j9e2ffGJ": "ok",
  "finance-desk/g1-02-kstl sCobK7s8": "VALIDATION_FAILED spec",
  "finance-desk/g1-02-kstl 3SJDPq4X": "VALIDATION_FAILED spec",
  "finance-desk/g1-06-pie MY6uJhVV": "ok",
  "finance-desk/g1-06-pie De1cgEyP": "ok",
  "mlpal/m1-csv-chart QYdccSP7": "ok",
  "sonnet/fab-watch/g1-01-shift YerSftJC": "ok",
  "sonnet/fab-watch/g1-01-shift J2BZzZxG": "ok",
  "sonnet/fab-watch/g1-02-lots bv51Lz8a": "VALIDATION_FAILED fallback.table; VALIDATION_FAILED spec.row_id",
  "sonnet/fab-watch/g1-02-lots aYj2Gmoh": "ok",
  "sonnet/finance-desk/g1-02-kstl gQAvQjfx": "ok",
  "sonnet/finance-desk/g1-02-kstl vq7K15WD": "ok",
  "sonnet/finance-desk/g1-04-october TRAyEm4p": "ok",
  "sonnet/finance-desk/g1-04-october 8aGw1cDx": "ok",
  "sonnet/finance-desk/g1-05-bankrec EJgWuciw": "ok",
  "sonnet/finance-desk/g1-05-bankrec Qgbgf24U": "ok",
  "sonnet/supply-planner/g1-01-columbus aSTqPaqp": "ok",
  "sonnet/supply-planner/g1-01-columbus EMETVjCP": "ok",
  "sonnet/supply-planner/g1-01-columbus p6VWYii7": "ok",
  "sonnet/supply-planner/g1-01-columbus C3sHhnNS": "ok",
  "supply-planner/g1-01-columbus JqyDEM5o": "ok",
  "supply-planner/g1-02-projection 6whb6bwE": "ok",
  "supply-planner/g1-02-projection uUnvYLTo": "ok",
  "supply-planner/g1-02-projection hWeaB8jv": "ok",
  "supply-planner/g1-03-waterfall 8VmXZ2J8": "VALIDATION_FAILED spec.vl.layer[0].mark.width",
  "supply-planner/g1-03-waterfall vq98fxUk": "ok",
  "supply-planner/g1-05-inbound ertBirkT": "VALIDATION_FAILED fallback.table.columns[1]; VALIDATION_FAILED fallback.table.columns[2]; VALIDATION_FAILED fallback.table.columns[3]",
  "supply-planner/g1-05-inbound rRHVgwoS": "ok",
};

interface Call {
  key: string;
  input: unknown;
  id: string;
  before: ConversationEntry[];
}

function calls(): Call[] {
  const out: Call[] = [];
  for (const { where, events } of fixture.sessions) {
    const entries = events.map((e, i) => ({ uuid: e.uuid ?? `e${i}`, parentUuid: null, payload: e, ts: e.ts ?? "t" }) as unknown as ConversationEntry);
    events.forEach((e, i) => {
      if (e.type !== "assistant" || !Array.isArray(e.message?.content)) return;
      for (const b of e.message.content as Array<{ type: string; id: string; name: string; input: unknown }>) {
        if (b.type === "tool_use" && b.name === "Show") out.push({ key: `${where} ${b.id.slice(-8)}`, input: b.input, id: b.id, before: entries.slice(0, i + 1) });
      }
    });
  }
  return out;
}

async function replay(c: Call): Promise<string> {
  const show = createShowTool({ policy: resolveDisplay(WEB)!, history: async (id) => foldDisplayHistory(c.before, id), logger: silentLogger, metrics: new MemoryMetrics() });
  const r = await show.call(c.input, { cwd: "/w", runId: "replay", toolUseId: c.id });
  if (!r.isError) return "ok";
  const text = typeof r.content === "string" ? r.content : r.content.map((x) => (x.type === "text" ? x.text : "")).join("");
  const body = JSON.parse(text.split("\n")[0]!) as { error: string; path?: string; faults?: Array<{ code: string; path?: string }> };
  return (body.faults ?? [{ code: body.error, path: body.path }]).map((f) => `${f.code}${f.path ? ` ${f.path}` : ""}`).join("; ");
}

describe("the first real-model run, replayed (34 Show calls; 20 refused on 7471c4f)", () => {
  const all = calls();

  test("every Show call of the run is in the expectations", () => {
    expect(all.map((c) => c.key).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const c of all) test(c.key, async () => expect(await replay(c)).toBe(EXPECTED[c.key]!));

  test("the share that passes first time", async () => {
    const results = await Promise.all(all.map(replay));
    const ok = results.filter((r) => r === "ok").length;
    expect(ok).toBe(Object.values(EXPECTED).filter((v) => v === "ok").length);
  });
});
