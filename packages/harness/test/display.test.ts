import { readdirSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConversationEntry, DisplayCaps, DisplayEnvelope, EngineEvent, ToolResultEvent } from "@mlpal/harness-protocol";
import { DISPLAY_LIMITS } from "@mlpal/harness-protocol";
import { createShowTool, displayInstructions, foldDisplayHistory, resolveDisplay, type DisplayHistory } from "../src/display";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import { AgentSession, type AgentConfig } from "../src/loop/agent";
import { JsonLogger } from "../src/obs/logger";
import { MemoryMetrics } from "../src/obs/metrics";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { defaultRegistry, type ToolResult } from "../src/tools";

const WEB: DisplayCaps = { v: 1, client: "web", levels: ["text", "block", "app", "page", "file"], catalogs: ["harness.v1/1"], viewport: "desktop", theme: "light", locale: "en-US", timeZone: "UTC" };
const CLI: DisplayCaps = { v: 1, client: "cli", levels: ["text", "file"], catalogs: [], viewport: "desktop", theme: "dark", locale: "en-US", timeZone: "UTC" };
const FALLBACK = "Ridgeline 2P at Columbus runs out on 17 Dec, four days before PO 4471 lands.";
const rows = [{ week: "2026-11-30", onhand: 2140 }, { week: "2026-12-07", onhand: 1340 }];
const chart = (over: Record<string, unknown> = {}) => ({
  block_id: "fig-1",
  kind: "chart",
  spec: { vl: { data: { values: rows }, mark: "line", encoding: { x: { field: "week", type: "temporal" }, y: { field: "onhand", type: "quantitative" } } } },
  fallback: { text: FALLBACK },
  ...over,
});
const badChart = (over: Record<string, unknown> = {}) => chart({ spec: { vl: { data: { values: rows }, mark: "image" } }, ...over });

// ─── the tool on its own ───

const history = (h: Partial<DisplayHistory> = {}): DisplayHistory => ({ revisions: new Map(), toolUseIds: new Set(), ...h });

function tool(caps: DisplayCaps = WEB, h: DisplayHistory = history()) {
  const metrics = new MemoryMetrics();
  const lines: string[] = [];
  const logger = new JsonLogger({ level: "debug", sink: (l) => lines.push(l) });
  const show = createShowTool({ policy: resolveDisplay(caps)!, history: async () => h, logger, metrics });
  const call = (input: unknown, runId = "run-1") => show.call(input, { cwd: "/w", runId });
  return { show, call, metrics, lines };
}

const modelText = (r: ToolResult) => (typeof r.content === "string" ? r.content : r.content.map((b) => (b.type === "text" ? b.text : "")).join(""));
const errorOf = (r: ToolResult) => JSON.parse(modelText(r).split("\n")[0]!) as { error: string; path?: string; attempt?: number; cause?: { code: string } };

describe("Show: a client that draws blocks", () => {
  test("a valid block: one envelope, revision 1; the model reads one line, the step shows the line and the fallback", async () => {
    const { call, metrics } = tool();
    const r = await call(chart({ placement: { surface: "canvas" } }));
    expect(r.isError).toBeUndefined();
    expect(modelText(r)).toBe("Shown fig-1 r1 (chart) on the canvas.");
    expect(r.meta?.displayText).toBe(`[shown fig-1 r1 · chart]\n${FALLBACK}`);
    expect(r.meta?.display).toEqual([
      { v: 1, block_id: "fig-1", revision: 1, op: "snapshot", level: "block", kind: "chart", catalog: "harness.v1/1", spec: chart().spec, fallback: { text: FALLBACK }, source: { by: "model" }, placement: { surface: "canvas" }, status: "ok" },
    ]);
    expect(metrics.counters.get("display.emitted{kind=chart,level=block,source=model}")).toBe(1);
  });

  test("showing a block again replaces it: the revision continues from the session's record", async () => {
    const { call } = tool(WEB, history({ revisions: new Map([["fig-1", 4]]) }));
    expect((await call(chart())).meta?.display?.[0]?.revision).toBe(5);
    expect((await call(chart())).meta?.display?.[0]?.revision).toBe(6);
  });

  test("two Shows of one block in one message (run concurrently) get distinct revisions", async () => {
    const { call } = tool();
    const [a, b] = await Promise.all([call(chart()), call(chart())]);
    expect([a.meta?.display?.[0]?.revision, b.meta?.display?.[0]?.revision].sort()).toEqual([1, 2]);
  });

  test("a stringified spec, notes or placement is parsed (models stringify nested objects); a string fallback is text", async () => {
    const { call } = tool();
    const r = await call({ ...chart(), spec: JSON.stringify(chart().spec), placement: '{"surface": "canvas"}', fallback: FALLBACK });
    expect(r.meta?.display?.[0]).toMatchObject({ level: "block", placement: { surface: "canvas" }, fallback: { text: FALLBACK } });
  });

  test("a source that is a tool call of this session is verified; a note citing one is verified", async () => {
    const h = history({ toolUseIds: new Set(["toolu_03"]), revisions: new Map([["fig-0", 1]]) });
    const { call } = tool(WEB, h);
    const ok = await call(chart({ sources: ["toolu_03"], as_of: "2026-11-27T06:00:00Z", notes: [
      { id: "erp", kind: "source", text: "ERP snapshot", ref: { tool_use_id: "toolu_03" } },
      { id: "prev", kind: "caveat", text: "Replaces the earlier view", ref: { block_id: "fig-0" } },
      { id: "gone", kind: "caveat", text: "Compare the old figure", ref: { block_id: "fig-9" } },
      { id: "file", kind: "assumption", text: "Forecast v14 holds", ref: { path: "forecast.csv" } },
    ] }));
    const d = ok.meta?.display?.[0];
    expect(d?.source).toEqual({ by: "model", tool_use_ids: ["toolu_03"], as_of: "2026-11-27T06:00:00Z" });
    expect(d?.notes?.map((n) => n.verified)).toEqual([true, true, false, undefined]);
  });
});

describe("Show: provenance is verified when it can be, never a gate (real-model run, Haiku 5.5)", () => {
  test("a source named in words (not a tool call id) shows the block, unverified, with a one-line notice", async () => {
    const { call, metrics } = tool();
    const r = await call(chart({ sources: ["yodex hop run, the command line"], as_of: "2026-11-27T06:00:00Z" }));
    expect(r.isError).toBeUndefined();
    const d = r.meta?.display?.[0];
    expect(d).toMatchObject({ level: "block", revision: 1, status: "ok", source: { by: "model", as_of: "2026-11-27T06:00:00Z" } });
    expect(d?.source).not.toHaveProperty("tool_use_ids");
    expect(d?.notes).toEqual([{ id: "source-1", kind: "source", text: "yodex hop run, the command line", verified: false }]);
    expect(modelText(r)).toBe("Shown fig-1 r1 (chart) in the thread.\nSOURCE_UNKNOWN (a notice, not an error): 1 source is not a tool call of this session, so it is shown as unverified.");
    expect(metrics.counters.get("display.notices{code=SOURCE_UNKNOWN}")).toBe(1);
    expect(metrics.counters.get("display.sources{state=unverified}")).toBe(1);
    expect(metrics.counters.get("display.repair{outcome=attempted}")).toBeUndefined();
  });

  test("mixed: known ids stay verified, unknown ones become unverified labels; a note's unknown ref loses its id", async () => {
    const h = history({ toolUseIds: new Set(["toolu_03"]) });
    const { call, metrics } = tool(WEB, h);
    const r = await call(chart({
      sources: ["toolu_03", "toolu_99", "ERP export, 27 Nov"],
      notes: [
        { id: "a", kind: "source", text: "ERP snapshot", ref: { tool_use_id: "toolu_03" } },
        { id: "b", kind: "source", text: "Forecast sheet", ref: { tool_use_id: "toolu_42" } },
        { id: "c", kind: "source", text: "Planner note", ref: { tool_use_id: "toolu_43", path: "notes.md" } },
      ],
    }));
    const d = r.meta?.display?.[0];
    expect(d?.source.tool_use_ids).toEqual(["toolu_03"]);
    expect(d?.notes).toEqual([
      { id: "a", kind: "source", text: "ERP snapshot", ref: { tool_use_id: "toolu_03" }, verified: true },
      { id: "b", kind: "source", text: "Forecast sheet", verified: false },
      { id: "c", kind: "source", text: "Planner note", ref: { path: "notes.md" }, verified: false },
      { id: "source-1", kind: "source", text: "toolu_99", verified: false },
      { id: "source-2", kind: "source", text: "ERP export, 27 Nov", verified: false },
    ]);
    expect(modelText(r)).toContain("4 sources are not tool calls of this session");
    expect([metrics.counters.get("display.sources{state=verified}"), metrics.counters.get("display.sources{state=unverified}")]).toEqual([2, 4]);
  });

  test("a source naming a tool called exactly once since the person's last message is mapped to that call, verified", async () => {
    const h = history({ toolUseIds: new Set(["toolu_05", "toolu_06", "toolu_07"]), recentCalls: [{ id: "toolu_05", name: "erp_query" }, { id: "toolu_06", name: "forecast" }, { id: "toolu_07", name: "forecast" }] });
    const { call, metrics } = tool(WEB, h);
    const r = await call(chart({ sources: ["erp_query", "forecast"], notes: [{ id: "n", kind: "source", text: "ERP", ref: { tool_use_id: "erp_query" } }] }));
    const d = r.meta?.display?.[0];
    expect(d?.source.tool_use_ids).toEqual(["toolu_05"]);
    expect(d?.notes).toEqual([
      { id: "n", kind: "source", text: "ERP", ref: { tool_use_id: "toolu_05" }, verified: true },
      { id: "source-1", kind: "source", text: "forecast", verified: false },
    ]);
    expect(metrics.counters.get("display.sources{state=mapped}")).toBe(2);
  });

  test("a hostile id (control characters, 10 KB) is dropped, counted and never echoed", async () => {
    const hostile = `\u001b[2J${"x".repeat(10_240)}`;
    const { call, metrics, lines } = tool();
    const r = await call(chart({ sources: [hostile, "ERP export"], notes: [{ id: "n", kind: "source", text: "ERP", ref: { tool_use_id: hostile } }] }));
    expect(r.isError).toBeUndefined();
    const everything = JSON.stringify(r) + lines.join("\n");
    expect(everything).not.toContain("x".repeat(40));
    expect(everything).not.toContain("\u001b");
    expect(r.meta?.display?.[0]?.notes).toEqual([{ id: "n", kind: "source", text: "ERP", verified: false }, { id: "source-1", kind: "source", text: "ERP export", verified: false }]);
    expect(metrics.counters.get("display.sources{state=dropped}")).toBe(2);
  });

  test("counters stay bounded: only fixed states and the code label", async () => {
    const { call, metrics } = tool();
    await call(chart({ sources: Array.from({ length: 20 }, (_, i) => `source number ${i} of a long list`) }));
    const keys = [...metrics.counters.keys()].filter((k) => k.startsWith("display.sources") || k.startsWith("display.notices"));
    for (const k of keys) expect(k).toMatch(/^display\.(sources\{state=(verified|mapped|unverified|dropped)\}|notices\{code=SOURCE_UNKNOWN\})$/);
  });

  test("unverified labels never take the block past 20 notes", async () => {
    const notes = Array.from({ length: 19 }, (_, i) => ({ id: `n${i}`, kind: "caveat", text: `caveat ${i}` }));
    const r = await tool().call(chart({ notes, sources: ["first label", "second label", "third label"] }));
    expect(r.meta?.display?.[0]?.notes).toHaveLength(DISPLAY_LIMITS.notes);
  });
});

describe("Show: refusal and the one repair", () => {
  test("a refused block: a typed error for the model; the person sees the fallback meanwhile", async () => {
    const { call, metrics } = tool();
    const r = await call(badChart());
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({ error: "VALIDATION_FAILED", block_id: "fig-1", path: "spec.vl.mark", attempt: 1 });
    expect(modelText(r)).toContain('call Show again with block_id "fig-1"');
    expect(r.meta?.display).toEqual([{ v: 1, block_id: "fig-1", revision: 1, op: "snapshot", level: "text", fallback: { text: FALLBACK }, source: { by: "model" }, status: "repairing" }]);
    expect(r.meta?.displayText).toBe(`[display fig-1 r1 · repairing]\n${FALLBACK}`);
    expect(metrics.counters.get("display.validation_errors{code=VALIDATION_FAILED,kind=chart}")).toBe(1);
    expect(metrics.counters.get("display.repair{outcome=attempted}")).toBe(1);
    expect(metrics.counters.get("display.fallback_shown{reason=validation}")).toBe(1);
  });

  test("the repair lands as the next revision and is counted as repaired", async () => {
    const { call, metrics } = tool();
    await call(badChart());
    const r = await call(chart());
    expect(r.meta?.display?.[0]).toMatchObject({ level: "block", revision: 2, status: "ok" });
    expect(metrics.counters.get("display.repair{outcome=repaired}")).toBe(1);
  });

  test("a second failure is RETRY_EXHAUSTED and the fallback stays; a third call is refused unseen, even a valid one", async () => {
    const { call, metrics } = tool();
    await call(badChart());
    const second = await call(badChart({ spec: { vl: { data: { url: "https://x/y.csv" }, mark: "line" } } }));
    expect(errorOf(second)).toMatchObject({ error: "RETRY_EXHAUSTED", attempt: 2, cause: { code: "URL_NOT_ALLOWED" } });
    expect(modelText(second)).toContain("Do not call Show for fig-1 again this turn");
    expect(second.meta?.display?.[0]).toMatchObject({ level: "text", revision: 2, status: "fallback_only" });
    const third = await call(chart());
    expect([third.isError, errorOf(third).error, third.meta]).toEqual([true, "RETRY_EXHAUSTED", undefined]);
    expect(metrics.counters.get("display.repair{outcome=exhausted}")).toBe(1);
    expect(metrics.counters.get("display.validation_errors{code=RETRY_EXHAUSTED,kind=chart}")).toBe(1);
  });

  test("a block never stays repairing: a failed repair whose own fallback is invalid ends on the last valid fallback", async () => {
    const { call, metrics } = tool();
    const first = await call(badChart());
    expect(first.meta?.display?.[0]).toMatchObject({ revision: 1, level: "text", status: "repairing", fallback: { text: FALLBACK } });
    const second = await call(badChart({ fallback: { text: "See the chart." } }));
    expect([second.isError, errorOf(second).error, errorOf(second).cause?.code]).toEqual([true, "RETRY_EXHAUSTED", "FALLBACK_UNINFORMATIVE"]);
    expect(second.meta?.display).toEqual([{ v: 1, block_id: "fig-1", revision: 2, op: "snapshot", level: "text", fallback: { text: FALLBACK }, source: { by: "model" }, status: "fallback_only" }]);
    expect(second.meta?.displayText).toBe(`[display fig-1 r2 · fallback only]\n${FALLBACK}`);
    expect(modelText(second)).toContain("the person sees your last valid fallback");
    expect(modelText(second)).toContain("Do not call Show for fig-1 again this turn");
    expect(metrics.counters.get("display.fallback_shown{reason=validation}")).toBe(2);
    expect(metrics.counters.get("display.emitted{kind=none,level=text,source=model}")).toBe(2);
    const third = await call(chart());
    expect([errorOf(third).error, third.meta]).toEqual(["RETRY_EXHAUSTED", undefined]);
  });

  test("with no valid fallback at all, the final envelope says plainly that the block could not be shown", async () => {
    const { call } = tool();
    const first = await call(badChart({ fallback: { text: "See the chart." } }));
    expect(first.meta).toBeUndefined();
    const second = await call(badChart({ fallback: undefined }));
    const d = second.meta?.display?.[0];
    expect(d).toMatchObject({ revision: 1, level: "text", status: "fallback_only" });
    expect(d?.fallback.text).toBe("This block could not be shown; the answer is in the conversation.");
    expect(modelText(second)).toContain("the person sees a note that fig-1 could not be shown");
  });

  test("attempts are counted per turn: the next run starts afresh", async () => {
    const { call } = tool();
    await call(badChart(), "run-1");
    await call(badChart(), "run-1");
    expect((await call(chart(), "run-2")).meta?.display?.[0]).toMatchObject({ level: "block", revision: 3 });
  });

  test("attempts are counted per block: another block's failures do not count", async () => {
    const { call } = tool();
    await call(badChart({ block_id: "fig-1" }));
    expect(errorOf(await call(badChart({ block_id: "fig-2" }))).attempt).toBe(1);
  });

  test("an invalid fallback shows nothing: no envelope, the error is the step's content", async () => {
    const { call, metrics } = tool();
    const r = await call(chart({ fallback: { text: "See the chart." } }));
    expect([r.isError, typeof r.content, r.meta]).toEqual([true, "string", undefined]);
    expect(errorOf(r).error).toBe("FALLBACK_UNINFORMATIVE");
    expect(modelText(r)).toContain("Nothing was shown.");
    expect(metrics.counters.get("display.fallback_shown{reason=validation}")).toBeUndefined();
  });

  test("an invalid block_id shows nothing and counts no attempt", async () => {
    const { call, metrics } = tool();
    const r = await call(chart({ block_id: "Figure 1" }));
    expect([errorOf(r).error, errorOf(r).path, r.meta]).toEqual(["VALIDATION_FAILED", "block_id", undefined]);
    expect(metrics.counters.get("display.repair{outcome=attempted}")).toBeUndefined();
  });

  const big = { vl: { data: { values: [{ week: "w", onhand: 1, pad: "x".repeat(300 * 1024) }] }, mark: "line" } };
  const many = { vl: { data: { values: Array.from({ length: 5_001 }, (_, i) => ({ week: `w${i}`, onhand: i })) }, mark: "line" } };
  const cases: Array<[string, Record<string, unknown>]> = [
    ["FALLBACK_MISSING", chart({ fallback: undefined })],
    ["FALLBACK_TOO_LONG", chart({ fallback: { text: "1".repeat(8_001) } })],
    ["FALLBACK_UNINFORMATIVE", chart({ fallback: { text: "Stock runs out." } })],
    ["KIND_UNKNOWN", chart({ kind: "sankey" })],
    ["HOST_OWNED_KIND", chart({ kind: "approval" })],
    ["VALIDATION_FAILED", badChart()],
    ["URL_NOT_ALLOWED", chart({ spec: { vl: { data: { url: "https://x/y.csv" }, mark: "line" } } })],
    ["EXPRESSION_NOT_ALLOWED", chart({ spec: { vl: { ...chart().spec.vl, transform: [{ calculate: "1", as: "k" }] } } })],
    ["SPEC_TOO_LARGE", chart({ spec: big })],
    ["ROWS_OVER_LIMIT", chart({ spec: many })],
  ];
  for (const [code, input] of cases) {
    test(`the protocol's ${code} reaches the model as a tool error with its path`, async () => {
      const r = await tool().call(input);
      expect([r.isError, errorOf(r).error]).toEqual([true, code]);
    });
  }

  test("a 12,000-deep spec, given as an object or as a string, is a typed refusal with the fallback shown and the attempt counted", async () => {
    let deep: unknown[] = [];
    for (let i = 0; i < 12_000; i++) deep = [deep];
    const spec = { vl: { ...chart().spec.vl, encoding: { x: { field: "week", type: "temporal", axis: { values: deep } } } } };
    const text = "[".repeat(12_000) + "]".repeat(12_000);
    for (const input of [chart({ spec }), chart({ spec: `{"vl": {"data": {"values": ${text}}}}` })]) {
      const { call, metrics } = tool();
      const r = await call(input);
      expect([r.isError, errorOf(r).error, errorOf(r).attempt]).toEqual([true, "SPEC_TOO_LARGE", 1]);
      expect(r.meta?.display?.[0]).toMatchObject({ level: "text", status: "repairing", fallback: { text: FALLBACK } });
      expect(metrics.counters.get("display.repair{outcome=attempted}")).toBe(1);
    }
  });

  test("a JSON-parsed __proto__ after a repairing block is a typed second failure, never 'Show threw' (review 2)", async () => {
    const { call, metrics } = tool();
    await call(badChart());
    const spec = JSON.parse('{"vl":{"data":{"values":[{"week":"2026-11-30","onhand":1}]},"mark":{"type":"line","__proto__":{"polluted":1}}}}');
    const r = await call(chart({ spec }));
    expect([r.isError, errorOf(r).error, errorOf(r).cause?.code]).toEqual([true, "RETRY_EXHAUSTED", "VALIDATION_FAILED"]);
    expect(r.meta?.display?.[0]).toMatchObject({ revision: 2, level: "text", status: "fallback_only" });
    expect(metrics.counters.get("display.repair{outcome=exhausted}")).toBe(1);
  });

  test("a store that fails during the call is VALIDATION_INTERNAL: the fallback is shown and the attempt counted", async () => {
    const metrics = new MemoryMetrics();
    const lines: string[] = [];
    const show = createShowTool({
      policy: resolveDisplay(WEB)!,
      history: async () => {
        throw new Error("session s1 was deleted: secret detail");
      },
      logger: new JsonLogger({ level: "debug", sink: (l) => lines.push(l) }),
      metrics,
    });
    const r = await show.call(chart(), { cwd: "/w", runId: "run-1" });
    expect([r.isError, errorOf(r).error, errorOf(r).attempt]).toEqual([true, "VALIDATION_INTERNAL", 1]);
    expect(r.meta?.display?.[0]).toMatchObject({ revision: 1, level: "text", status: "repairing", fallback: { text: FALLBACK } });
    expect(metrics.counters.get("display.validation_errors{code=VALIDATION_INTERNAL,kind=chart}")).toBe(1);
    expect(lines.some((l) => l.includes("display check failed unexpectedly"))).toBe(true);
    for (const l of lines) expect(l).not.toContain("secret detail");
  });

  test("every fault is listed to the model, so one repair fixes them all", async () => {
    const { call, metrics } = tool();
    const spec = { vl: { ...chart().spec.vl, mark: { type: "line", evil: 1 }, transform: [{ calculate: "1", as: "k" }], encoding: { x: { field: "week", type: "temporal", axis: { tickCount: 1e9 } }, y: { field: "onhand", type: "quantitative" } } } };
    const r = await call(chart({ spec }));
    const body = errorOf(r) as unknown as { error: string; faults: Array<{ code: string; path: string }> };
    expect([body.error, body.faults.map((f) => f.path)]).toEqual(["EXPRESSION_NOT_ALLOWED", ["spec.vl.transform[0].calculate", "spec.vl.encoding.x.axis.tickCount", "spec.vl.mark.evil"]]);
    expect(modelText(r)).toContain("3 faults; fix all of them in this one repair:");
    expect(modelText(r)).toContain("- VALIDATION_FAILED at spec.vl.mark.evil:");
    expect(metrics.counters.get("display.validation_errors{code=EXPRESSION_NOT_ALLOWED,kind=chart}")).toBe(1);
    const fixed = await call(chart());
    expect(fixed.meta?.display?.[0]).toMatchObject({ level: "block", revision: 2, status: "ok" });
  });

  test("KIND_NOT_ALLOWED: a kind the client left out of its kinds", async () => {
    const r = await tool({ ...WEB, kinds: ["grid"] }).call(chart());
    expect([errorOf(r).error, errorOf(r).path]).toEqual(["KIND_NOT_ALLOWED", "kind"]);
  });

  test("TOO_MANY_BLOCKS: a 13th block in one turn; a block at 200 revisions", async () => {
    const { call } = tool();
    for (let i = 0; i < 12; i++) expect((await call(chart({ block_id: `b-${i}` }))).isError).toBeUndefined();
    const r = await call(chart({ block_id: "b-12" }));
    expect([errorOf(r).error, r.meta]).toEqual(["TOO_MANY_BLOCKS", undefined]);
    expect((await call(chart({ block_id: "b-3" }))).isError).toBeUndefined();
    const old = await tool(WEB, history({ revisions: new Map([["fig-1", 200]]) })).call(chart());
    expect(errorOf(old).error).toBe("TOO_MANY_BLOCKS");
  });

  test("logs and metric labels carry no content the model wrote", async () => {
    const { call, lines, metrics } = tool();
    const secret = "Columbus-Reno-secret-plan";
    await call(chart({ fallback: { text: `${FALLBACK} ${secret}` }, title: secret }));
    await call(badChart({ block_id: "fig-2", fallback: { text: `${FALLBACK} ${secret}` } }));
    await call(chart({ block_id: "fig-3", kind: "my-own-kind" }));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toContain(secret);
    expect([...metrics.counters.keys()].some((k) => k.includes("my-own-kind"))).toBe(false);
    expect(metrics.counters.get("display.validation_errors{code=KIND_UNKNOWN,kind=other}")).toBe(1);
  });
});

describe("which clients get a display policy", () => {
  test("only one that declares the block level and catalog harness.v1/1 and draws one of its kinds", () => {
    expect(resolveDisplay(CLI)).toBeNull();
    expect(resolveDisplay({ ...WEB, levels: ["text"] })).toBeNull();
    expect(resolveDisplay({ ...WEB, catalogs: [] })).toBeNull();
    expect(resolveDisplay({ ...WEB, kinds: ["sankey"] })).toBeNull();
    expect([...resolveDisplay({ ...WEB, kinds: ["grid", "kpis"] })!.kinds]).toEqual(["kpis", "grid"]);
  });
});

describe("the display section of the system prompt", () => {
  test("names only the kinds the client draws", () => {
    const all = displayInstructions(resolveDisplay(WEB)!);
    expect(all).toContain("# Showing results");
    for (const k of ["- chart:", "- kpis:", "- grid:"]) expect(all).toContain(k);
    const grid = displayInstructions(resolveDisplay({ ...WEB, kinds: ["grid"] })!);
    expect([grid.includes("- grid:"), grid.includes("- chart:"), grid.includes("- kpis:")]).toEqual([true, false, false]);
    expect(all).not.toContain("on a phone");
    expect(displayInstructions(resolveDisplay({ ...WEB, viewport: "phone" })!)).toContain("on a phone");
  });

  test("the same declaration always gives the same section (the prompt cache holds)", () => {
    expect(displayInstructions(resolveDisplay(WEB)!)).toBe(displayInstructions(resolveDisplay(structuredClone(WEB))!));
  });
});

describe("the display history", () => {
  const entry = (uuid: string, payload: unknown): ConversationEntry => ({ uuid, parentUuid: null, payload, ts: "t" }) as unknown as ConversationEntry;
  const envelope = (block_id: string, revision: number): DisplayEnvelope => ({ v: 1, block_id, revision, op: "snapshot", level: "text", fallback: { text: FALLBACK }, source: { by: "model" }, status: "repairing" });

  test("folds each block's last revision and every tool call, from string or block content", () => {
    const h = foldDisplayHistory([
      entry("a", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] } }),
      entry("b", { type: "assistant", message: { role: "assistant", content: "plain" } }),
      entry("c", { type: "tool_result", toolUseId: "toolu_1", toolName: "Show", content: "", display: [envelope("fig-1", 3), envelope("fig-2", 1)], isError: false, ts: "t" }),
      entry("d", { type: "tool_result", toolUseId: "toolu_2", toolName: "Show", content: "", display: [envelope("fig-1", 2)], isError: false, ts: "t" }),
    ]);
    expect([...h.revisions]).toEqual([["fig-1", 3], ["fig-2", 1]]);
    expect([...h.toolUseIds]).toEqual(["toolu_1"]);
    expect(h.recentCalls).toEqual([{ id: "toolu_1", name: "Read" }]);
  });

  test("recent calls are those since the last user message, Show's own excluded", () => {
    const h = foldDisplayHistory([
      entry("a", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "erp_query", input: {} }] } }),
      entry("b", { type: "user", message: { role: "user", content: "and now?" } }),
      entry("c", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "forecast", input: {} }, { type: "tool_use", id: "t3", name: "Show", input: {} }] } }),
    ]);
    expect(h.recentCalls).toEqual([{ id: "t2", name: "forecast" }]);
    expect([...h.toolUseIds]).toEqual(["t1", "t2", "t3"]);
  });
});

// ─── the engine: gating, contract, persistence ───

class Scripted implements ModelClient {
  private i = 0;
  readonly seen: ModelRequest[] = [];
  constructor(private readonly scripts: ModelResult[]) {}
  async *stream(req: ModelRequest): AsyncGenerator<never, ModelResult, void> {
    this.seen.push(structuredClone({ ...req, signal: undefined }));
    const r = this.scripts[this.i++];
    if (!r) throw new GatewayError("script exhausted", 500);
    return r;
  }
}
const use = (id: string, name: string, input: unknown): ModelResult => ({
  model: "test",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: input as Record<string, unknown> }] },
  usage: { input_tokens: 10, output_tokens: 5 },
  stopReason: "tool_use",
});
const done = (text: string): ModelResult => ({ model: "test", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input_tokens: 8, output_tokens: 4 }, stopReason: "end_turn" });

let root: string;
beforeEach(async () => {
  root = join(tmpdir(), `yodex-display-${crypto.randomUUID()}`);
  await mkdir(join(root, "work"), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function session(model: ModelClient, extra: Partial<AgentConfig> = {}): AgentSession {
  return new AgentSession({
    agentId: "ag1",
    sessionId: "s1",
    workspace: "w",
    cwd: join(root, "work"),
    model: "test",
    systemPrompt: "You are a test.",
    tools: defaultRegistry(),
    store: new LocalStore(root),
    model_client: model,
    canUseTool: createPolicy({ mode: "manual" }),
    ...extra,
  });
}

async function run(s: AgentSession, text = "show me"): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of s.run({ text })) out.push(e);
  return out;
}
const toolResults = (events: EngineEvent[]) => events.filter((e): e is ToolResultEvent => e.type === "tool_result");
const toolNames = (req: ModelRequest) => (req.tools ?? []).map((t) => t.name);

describe("capability gating in the engine", () => {
  test("no display declared: no Show, the host's prompt, and a Show call is an unknown tool", async () => {
    const model = new Scripted([use("toolu_1", "Show", chart()), done("ok")]);
    // autopilot, so the call reaches the registry (under manual an unknown, so not read-only, tool is asked first)
    const events = await run(session(model, { canUseTool: createPolicy({ mode: "autopilot" }) }));
    expect(toolNames(model.seen[0]!)).not.toContain("Show");
    expect(model.seen[0]!.system).toBe("You are a test.");
    const [r] = toolResults(events);
    expect([r!.isError, r!.content, "display" in r!]).toEqual([true, "Unknown tool: Show", false]);
  });

  test("a text client: no Show, the host's prompt, and a Show call is an unknown tool (the ruling of review 1)", async () => {
    const model = new Scripted([use("toolu_1", "Show", chart()), done("ok")]);
    const events = await run(session(model, { display: CLI, canUseTool: createPolicy({ mode: "autopilot" }) }));
    const silent = new Scripted([done("ok")]);
    await run(session(silent, { sessionId: "s2" }));
    expect(model.seen[0]!.tools).toEqual(silent.seen[0]!.tools);
    expect(model.seen[0]!.system).toBe("You are a test.");
    const [r] = toolResults(events);
    expect([r!.isError, r!.content, "display" in r!]).toEqual([true, "Unknown tool: Show", false]);
  });

  test("a client that draws blocks: Show and the catalog; the result carries the envelope; the model reads one line", async () => {
    const model = new Scripted([use("toolu_1", "Show", chart()), done("ok")]);
    const events = await run(session(model, { display: WEB }));
    expect(toolNames(model.seen[0]!)).toContain("Show");
    expect(model.seen[0]!.system?.startsWith("You are a test.\n\n# Showing results\n")).toBe(true);
    const [r] = toolResults(events);
    expect(r!.content).toBe(`[shown fig-1 r1 · chart]\n${FALLBACK}`);
    expect(r!.display?.[0]).toMatchObject({ block_id: "fig-1", revision: 1, level: "block", kind: "chart" });
    const sent = model.seen[1]!.messages.at(-1)!.content as Array<{ type: string; content: unknown }>;
    expect(sent[0]).toMatchObject({ type: "tool_result", content: [{ type: "text", text: "Shown fig-1 r1 (chart) in the thread." }] });
  });

  test("Show's schema tells the model what is required, and is the same for every client that draws blocks", async () => {
    const schema = (caps: DisplayCaps) => {
      const m = new Scripted([done("ok")]);
      return run(session(m, { display: caps })).then(() => m.seen[0]!.tools!.find((t) => t.name === "Show")!);
    };
    const web = await schema(WEB);
    expect(await schema({ ...WEB, client: "mobile", viewport: "phone", kinds: ["grid"] })).toEqual(web);
    expect((web.input_schema as { required: string[] }).required.sort()).toEqual(["block_id", "fallback", "kind", "spec"]);
  });

  test("the host's registry is not changed by a session that adds Show", async () => {
    const tools = defaultRegistry();
    await run(session(new Scripted([done("ok")]), { display: WEB, tools }));
    expect(tools.get("Show")).toBeUndefined();
  });
});

describe("persistence and replay", () => {
  test("the display is stored with the tool result, replayed as stored, and never reaches the model", async () => {
    const model = new Scripted([use("toolu_1", "Show", chart()), done("ok")]);
    const events = await run(session(model, { display: WEB }));
    const streamed = toolResults(events)[0]!;
    const stored = (await new LocalStore(root).conversation.read("s1")).find((e) => e.payload.type === "tool_result")!.payload as ToolResultEvent;
    expect({ ...stored, uuid: streamed.uuid } as ToolResultEvent).toEqual(streamed);

    // a new engine on the same session: the model's replay has the line, not the spec or the fallback, and the next
    // Show of the block continues its revisions from the store
    const next = new Scripted([use("toolu_2", "Show", chart()), done("ok")]);
    const later = await run(session(next, { display: WEB }), "again");
    const replayed = JSON.stringify(next.seen[0]!.messages);
    expect(replayed).toContain("Shown fig-1 r1 (chart) in the thread.");
    expect(replayed.match(new RegExp(FALLBACK.slice(0, 30), "g"))?.length).toBe(1); // only in the model's own tool_use input
    expect(toolResults(later)[0]!.display?.[0]?.revision).toBe(2);
  });

  test("a rewind before a block forgets its revisions", async () => {
    const first = new Scripted([use("toolu_1", "Show", chart()), done("ok")]);
    await run(session(first, { display: WEB }));
    const store = new LocalStore(root);
    const entries = await store.conversation.read("s1");
    const user = entries.find((e) => e.payload.type === "user")!;
    const head = entries.at(-1)!.uuid;
    await store.conversation.append("s1", { type: "rewind", toUuid: entries[entries.indexOf(user) - 1]!.uuid, turn: 1, ts: "t" }, head);
    const again = new Scripted([use("toolu_2", "Show", chart()), done("ok")]);
    expect(toolResults(await run(session(again, { display: WEB })))[0]!.display?.[0]?.revision).toBe(1);
  });
});

// ─── the goldens, through the engine ───

const goldenDir = new URL("../../protocol/test/fixtures/display/golden/", import.meta.url);
describe("goldens through Show", () => {
  for (const name of readdirSync(goldenDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""))) {
    test(`${name}: the envelope the engine emits is the golden's`, async () => {
      const golden = JSON.parse(readFileSync(new URL(`${name}.json`, goldenDir), "utf8"));
      const r = await tool(WEB, history({ toolUseIds: new Set(["toolu_03"]) })).call(golden.show);
      expect(r.meta?.display).toEqual([golden.envelope]);
    });
  }
});
