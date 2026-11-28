import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { ConversationEntry, DisplayCaps } from "@mlpal/harness-protocol";
import { createShowTool, foldDisplayHistory, resolveDisplay } from "../src/display";
import { silentLogger } from "../src/obs/logger";
import { MemoryMetrics } from "../src/obs/metrics";

/**
 * The real-model runs, Haiku 5.5 and Sonnet 5.5 through the web UI: run 1 (reports/harness-ui-next/v1, engine
 * 7471c4f: 34 Show calls, 20 refused at the time) and run 2 (reports/harness-ui-next/v1-run2, engine 8d0e513: 48
 * calls). Each input is replayed as a first attempt against its session as it stood, through the engine's Show, and
 * must come out as recorded below. When a change makes more of them pass, update EXPECTED. A replay cannot show what
 * a change to the tool's schema does: that changes what the model writes.
 */
type Payload = { type: string; uuid?: string; ts?: string; message?: { content?: unknown }; toolUseId?: string; toolName?: string; isError?: boolean };
type Fixture = { sessions: Array<{ where: string; events: Payload[] }> };
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/display/${name}`, import.meta.url), "utf8")) as Fixture;
const RUNS: Array<{ label: string; fixture: Fixture }> = [
  { label: "", fixture: load("workbox-v1-shows.json") },
  { label: "run2 ", fixture: load("workbox-v1-run2-shows.json") },
];
const WEB: DisplayCaps = { v: 1, client: "web", levels: ["text", "block"], catalogs: ["harness.v1/1"], viewport: "desktop", theme: "dark", locale: "en-US", timeZone: "UTC" };

/** Outcome per Show call, keyed by "[run2 ]<where> <last 8 of the tool_use id>": "ok", or the faults in order. */
const EXPECTED: Record<string, string> = {
  "fab-watch/g1-01-shift 7i4mevmc": "ok",
  "fab-watch/g1-01-shift cPuujyW8": "ok",
  "fab-watch/g1-03-pareto Pi1kvbVn": "ok",
  "fab-watch/g1-03-pareto wJ6BYeZV": "ok",
  "fab-watch/g1-04-colour BDQYFqqf": "ok",
  "fab-watch/g1-04-colour D8fQUXz5": "ok",
  "finance-desk/g1-01-book j9e2ffGJ": "ok",
  "finance-desk/g1-02-kstl sCobK7s8": "VALIDATION_FAILED spec",
  "finance-desk/g1-02-kstl 3SJDPq4X": "VALIDATION_FAILED spec",
  "finance-desk/g1-06-pie MY6uJhVV": "ok",
  "finance-desk/g1-06-pie De1cgEyP": "ok",
  "mlpal/m1-csv-chart QYdccSP7": "ok",
  "sonnet/fab-watch/g1-01-shift YerSftJC": "ok",
  "sonnet/fab-watch/g1-01-shift J2BZzZxG": "ok",
  "sonnet/fab-watch/g1-02-lots bv51Lz8a": "ok",
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
  "supply-planner/g1-05-inbound ertBirkT": "ok",
  "supply-planner/g1-05-inbound rRHVgwoS": "ok",
  // run 2, as engine 8d0e513 answers them
  "run2 fab-watch/g1-01-shift w3gtKLfo": "ok",
  "run2 fab-watch/g1-02-lots qfDigYJB": "ok",
  "run2 fab-watch/g1-03-pareto 1pLUMUqW": "ok",
  "run2 fab-watch/g1-04-colour pRxcGzch": "VALIDATION_FAILED spec",
  "run2 fab-watch/g1-04-colour ovdzqVXC": "VALIDATION_FAILED spec",
  "run2 fab-watch/g1-07-wafer zWnJM1Zn": "VALIDATION_FAILED spec.rows[1].zone; VALIDATION_FAILED spec.rows[2].zone; VALIDATION_FAILED spec.rows[4].zone; VALIDATION_FAILED spec.rows[5].zone; VALIDATION_FAILED spec.rows[7].zone; VALIDATION_FAILED spec.rows[8].zone",
  "run2 fab-watch/g1-07-wafer b7MCj8SZ": "ok",
  "run2 fab-watch/h1-01-morning fig9LXdr": "VALIDATION_FAILED fallback.table",
  "run2 fab-watch/h1-01-morning nXvPqhXA": "VALIDATION_FAILED spec.vl.data.limits",
  "run2 fab-watch/h1-01-morning BP7xuD7u": "ok",
  "run2 fab-watch/h1-01-morning iP43nS94": "ok",
  "run2 fab-watch/h1-02-exposure uoDJ5FFL": "ok",
  "run2 finance-desk/g1-01-book MeQTi2UB": "ok",
  "run2 finance-desk/g1-02-kstl taWjRWK8": "EXPRESSION_NOT_ALLOWED spec.vl.layer[1].transform[0].filter",
  "run2 finance-desk/g1-02-kstl mKbBmQFd": "ok",
  "run2 finance-desk/g1-04-october SCKntQmS": "ok",
  "run2 finance-desk/g1-06-pie dfUYegKV": "VALIDATION_FAILED spec.mark; VALIDATION_FAILED spec.encoding; VALIDATION_FAILED spec.vl",
  "run2 finance-desk/g1-06-pie mDkoZXiy": "ok", // a pie, since arc is allowed
  "run2 finance-desk/h1-01-rec-balances ijMBWrAs": "ok",
  "run2 finance-desk/h1-02-october-headline 2Dq6sGkv": "ok",
  "run2 mlpal/m1-csv-chart yvN7qNJz": "VALIDATION_FAILED sources",
  "run2 mlpal/m1-csv-chart DNiSWMtw": "ok",
  "run2 sonnet/fab-watch/g1-01-shift 1SGTs4N3": "ok",
  "run2 sonnet/fab-watch/g1-02-lots UuqYexTU": "ok",
  "run2 sonnet/fab-watch/h1-01-morning rmDYrKgL": "ok",
  "run2 sonnet/fab-watch/h1-02-exposure DqznzRg6": "ok",
  "run2 sonnet/finance-desk/g1-02-kstl hUqK2cLB": "ok",
  "run2 sonnet/finance-desk/g1-04-october sfDBqLaF": "ok",
  "run2 sonnet/finance-desk/g1-05-bankrec g2RpWPgD": "ok",
  "run2 sonnet/finance-desk/h1-01-rec-balances DqG9fYeZ": "ok",
  "run2 sonnet/finance-desk/h1-01-rec-balances UNbLrwH5": "ok",
  "run2 sonnet/finance-desk/h1-02-october-headline sHA4tgey": "ok",
  "run2 sonnet/supply-planner/g1-01-columbus 2gJaxS3V": "ok",
  "run2 sonnet/supply-planner/g1-01-columbus yBrDdt8E": "ok",
  "run2 sonnet/supply-planner/h1-01-sop c5gvhGDS": "ok",
  "run2 sonnet/supply-planner/h1-02-transfer-1700 3Us9HiK8": "ok",
  "run2 supply-planner/g1-01-columbus 4eM6djhV": "VALIDATION_FAILED spec",
  "run2 supply-planner/g1-01-columbus tT89DcEe": "VALIDATION_FAILED spec",
  "run2 supply-planner/g1-01-columbus gmmZvgMs": "ok",
  "run2 supply-planner/g1-01-columbus sizVesg7": "ok",
  "run2 supply-planner/g1-02-projection HFobHW8X": "VALIDATION_FAILED spec.layer; VALIDATION_FAILED spec.vl",
  "run2 supply-planner/g1-02-projection F8KHJWaD": "VALIDATION_FAILED spec.layer; VALIDATION_FAILED spec.vl",
  "run2 supply-planner/g1-03-waterfall Dx3Z1JPZ": "VALIDATION_FAILED spec.vl.layer[0].mark.width",
  "run2 supply-planner/g1-03-waterfall FxyBJ4BM": "ok",
  "run2 supply-planner/g1-04-network zVb4ffCW": "ok",
  "run2 supply-planner/g1-05-inbound bfZVjpnz": "ok",
  "run2 supply-planner/h1-01-sop 62KmnJaD": "ok",
  "run2 supply-planner/h1-03-options eQkhcJpR": "ok",
};

interface Call {
  key: string;
  input: unknown;
  id: string;
  before: ConversationEntry[];
}

function calls(): Call[] {
  const out: Call[] = [];
  for (const { label, fixture } of RUNS) for (const { where: at, events } of fixture.sessions) {
    const where = `${label}${at}`;
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
  const body = JSON.parse(text.split("\n").find((l) => l.startsWith("{"))!) as { error: string; path?: string; faults?: Array<{ code: string; path?: string }> };
  return (body.faults ?? [{ code: body.error, path: body.path }]).map((f) => `${f.code}${f.path ? ` ${f.path}` : ""}`).join("; ");
}

describe("the real-model runs, replayed (run 1: 34 Show calls, 20 refused on 7471c4f; run 2: 48 calls on 8d0e513)", () => {
  const all = calls();

  test("every Show call of the run is in the expectations", () => {
    expect(all.map((c) => c.key).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const c of all) test(c.key, async () => expect(await replay(c)).toBe(EXPECTED[c.key]!));

  if (process.env.DISPLAY_REPLAY_PRINT) test("print", async () => { for (const c of all) console.log(JSON.stringify(c.key) + ": " + JSON.stringify(await replay(c)) + ","); });

  test("the share that passes first time", async () => {
    const results = await Promise.all(all.map(replay));
    const ok = results.filter((r) => r === "ok").length;
    expect(ok).toBe(Object.values(EXPECTED).filter((v) => v === "ok").length);
  });
});
