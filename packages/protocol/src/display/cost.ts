import { DISPLAY_LIMITS } from "./catalog.js";
import { displayPath } from "./errors.js";

/**
 * The one cost walker for a `chart` (UI reviews R2 and N2, review 5): what drawing a chart that passed validateBlock
 * would cost a renderer, and whether it fits. The engine's validator calls it, and a client calls the same function
 * before it compiles, so no cost rule lives anywhere else. It fails closed: an op, transform or mark it has no cost for,
 * or a shape it cannot read, is TOO_COSTLY, so a grammar addition is never free by accident.
 *
 * Calibrated with the Vega 6.4.0 and Vega-Lite 6.5.0 the web UI ships, in Bun (milliseconds; 5,000 rows unless said;
 * the report has the tables): a chart's compile and parse about 50; incremental window ops (sum, mean, count, rank...)
 * about 0.0025 per row per op; median, quartiles and distinct windows over the whole partition about 0.003 per row;
 * min and max rescan their frame when a value leaves it, about 0.00015 per row x span, and are incremental when the
 * frame's start is open; an aggregate op (or a sort by a field) about 0.0005 per input row; filter, bin, timeUnit and
 * stack about 0.0005 per row; drawing about 0.025 per point-like mark, 0.07 per bar, 0.01 per line or area vertex;
 * an errorband, errorbar or boxplot reads every row (0.002) and draws its groups (and a boxplot its outliers) as
 * points. A line or area splits into a path per value of a grouping channel (color, opacity, size, strokeDash,
 * detail, and order on an area), about 0.05 per path (2,000 paths: 163); a stacked one (every area, a line with
 * `stack`) imputes every x value for every path (500 paths x 500 x values: 1,178; 2,000 x 2,000: 18,949), so its
 * vertices are its x values x paths. Each path counts as a mark. A nominal or ordinal x or y axis draws a label per
 * value, about 0.012 per label (an ordinal line of 5,000: +50; 7 such axes: about 800), charged in every view that
 * draws one (a layer's shared axis is charged in each of its views, so this errs high).
 *
 * The walker never infers a reduction (review 7 ruling: every hole in reviews 5 to 7 was one). Rows and marks are
 * the input rows times every multiplier (a fold's width, each view), except through this whitelist, each tested:
 *   W1 an aggregate transform: its groups, the product of its groupby fields' distinct values in the inline data
 *      (1 without groupby), when every groupby field is plain: still the inline data's (no transform but a filter
 *      has run) or a fold's key;
 *   W2 a channel aggregate, and the implicit one of an errorband, errorbar or boxplot: its groups, the product of
 *      the other field channels' distinct values (a binned one counts its maxbins + 2), when every one of them is a
 *      plain field ({field, type} with only timeUnit, bin, sort, title, axis, scale, legend, format, formatType or
 *      bandPosition beside) and no channel has a condition;
 *   W3 the paths a line or area splits into, and the x values it imputes: the distinct values of plain grouping and
 *      positional fields, under the same rule;
 *   W4 a fold's key has exactly as many values as the fold has fields.
 * Nothing else reduces anything: not a filter, a sort, a bin, a timeUnit or a condition.
 *
 * Rules, in the order a fault is reported:
 * 1. median, q1, q3 and distinct windows run over the whole partition only: frame [null, null];
 * 2. a frame whose start is bounded: rows x span (an open end counts to the partition's edge) <= chartWindowRowsTimesSpan;
 * 3. every window of the chart, every view counted: rows x ops <= chartWindowOpRows;
 * 4. point-like marks and paths drawn (rows x views that draw them) <= chartMarks;
 * 5. the whole estimate <= chartCostBudgetMs.
 */

export type ChartCostCheck =
  | { ok: true; estimateMs: number }
  | { ok: false; code: "TOO_COSTLY"; path: string; message: string; hint?: string };

type Obj = Record<string, unknown>;
type Seg = string | number;

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const has = (o: object, k: string): boolean => Object.hasOwn(o, k);

const MS = {
  chart: 50,
  incremental: 0.0025,
  sortWhole: 0.003,
  rescan: 0.00015,
  aggregateOp: 0.0005,
  linearTransform: 0.0005,
  pointMark: 0.025,
  bar: 0.07,
  vertex: 0.01,
  path: 0.06,
  axisLabel: 0.015,
  aggregatedRow: 0.002,
} as const;

/** Every window op's cost class (the table test holds this to the grammar's list). */
export const WINDOW_OP_COST: Readonly<Record<string, "incremental" | "sort" | "rescan">> = {
  row_number: "incremental", rank: "incremental", dense_rank: "incremental", percent_rank: "incremental",
  cume_dist: "incremental", ntile: "incremental", lag: "incremental", lead: "incremental", first_value: "incremental",
  last_value: "incremental", nth_value: "incremental", count: "incremental", valid: "incremental",
  missing: "incremental", sum: "incremental", product: "incremental", mean: "incremental", average: "incremental",
  variance: "incremental", variancep: "incremental", stdev: "incremental", stdevp: "incremental", stderr: "incremental",
  median: "sort", q1: "sort", q3: "sort", distinct: "sort", min: "rescan", max: "rescan",
};

/** Every aggregate op's cost class (in an aggregate transform or a channel's aggregate). */
export const AGGREGATE_OP_COST: Readonly<Record<string, "linear">> = {
  count: "linear", valid: "linear", missing: "linear", distinct: "linear", sum: "linear", product: "linear",
  mean: "linear", average: "linear", variance: "linear", variancep: "linear", stdev: "linear", stdevp: "linear",
  stderr: "linear", median: "linear", q1: "linear", q3: "linear", min: "linear", max: "linear",
};

/** Every transform's cost: a window and an aggregate are costed by their ops, a fold multiplies rows. */
export const TRANSFORM_COST: Readonly<Record<string, "window" | "aggregate" | "fold" | "linear">> = {
  filter: "linear", aggregate: "aggregate", bin: "linear", timeUnit: "linear", window: "window", fold: "fold",
  stack: "linear",
};

/** Every mark's cost: point-like marks and bars count against chartMarks; composites read every row once. */
export const MARK_COST: Readonly<Record<string, "point" | "bar" | "path" | "composite">> = {
  point: "point", tick: "point", rule: "point", text: "point", rect: "point", bar: "bar", line: "path", area: "path",
  errorband: "composite", errorbar: "composite", boxplot: "composite",
};

const WHOLE_FRAME_OPS: ReadonlySet<string> = new Set(DISPLAY_LIMITS.chartWholeFrameOps);
const MAX_VIEW_DEPTH = 3;

class TooCostly extends Error {
  constructor(
    readonly path: Seg[],
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

function unknownCost(at: Seg[], what: string): never {
  throw new TooCostly(at, `no cost is known for ${what}`, "draw it another way; the renderer's cost guard refuses what it cannot cost");
}

interface Acc {
  ms: number;
  windowOpRows: number;
  marks: number;
}

/** The rows reaching a point: how many, and the inline data they still are (null once a transform but a filter has
 *  run). `known`: distinct counts known without the data, the one a fold's key field has (its list's length). */
interface Rows {
  n: number;
  data: Obj[] | null;
  known?: ReadonlyMap<string, number>;
}

/** How many groups `fields` make: the product of their distinct values in the data, a row that lacks a field counting
 *  as one more value (Vega groups it under undefined, review 8), at most the rows; the rows when any field is in no
 *  row at all. */
function groups(rows: Rows, fields: string[]): number {
  if (fields.length === 0) return 1;
  if (!rows.data) {
    let product = 1;
    for (const f of fields) product *= rows.known?.get(f) ?? rows.n;
    return Math.max(1, Math.min(product, rows.n));
  }
  let product = 1;
  for (const f of fields) {
    const seen = new Set<string>();
    let missing = false;
    for (const r of rows.data) {
      if (has(r, f)) seen.add(JSON.stringify(r[f]));
      else missing = true;
    }
    if (seen.size === 0) return rows.n;
    product *= seen.size + (missing ? 1 : 0);
    if (product >= rows.n) return rows.n;
  }
  return Math.max(1, Math.min(product, rows.n));
}

function windowCost(t: Obj, at: Seg[], rows: Rows, acc: Acc): void {
  const n = rows.n;
  if (!Array.isArray(t.window)) unknownCost(at, "a window without ops");
  const ops = (t.window as unknown[]).map((x, j) => {
    const op = isObj(x) ? String(x.op) : "";
    if (!has(WINDOW_OP_COST, op)) unknownCost([...at, "window", j, "op"], `the window op "${op}"`);
    return op;
  });
  const frame = (Array.isArray(t.frame) ? t.frame : [null, 0]) as Array<number | null>;
  const [a, b] = [typeof frame[0] === "number" ? frame[0] : null, typeof frame[1] === "number" ? frame[1] : null];
  const whole = a === null && b === null;
  const w = ops.findIndex((op) => WHOLE_FRAME_OPS.has(op));
  if (w >= 0 && !whole) {
    throw new TooCostly(has(t, "frame") ? [...at, "frame"] : [...at, "window", w, "op"], `${ops[w]} over a sliding or cumulative frame recomputes for every row`, "use frame [null, null] (the whole partition), or aggregate first");
  }
  // A frame whose start is open only grows; one whose start is bounded drops rows as it slides.
  const span = a === null ? 0 : Math.min(n, Math.abs((b === null ? n : b) - a) + 1);
  if (span && n * span > DISPLAY_LIMITS.chartWindowRowsTimesSpan) {
    throw new TooCostly([...at, "frame"], `${n} rows x a frame of ${span}; at most ${DISPLAY_LIMITS.chartWindowRowsTimesSpan}`, "narrow the frame, or aggregate the rows first");
  }
  acc.windowOpRows += n * ops.length;
  if (acc.windowOpRows > DISPLAY_LIMITS.chartWindowOpRows) {
    throw new TooCostly(at, `window ops x rows reach ${acc.windowOpRows}; a chart runs at most ${DISPLAY_LIMITS.chartWindowOpRows}`, "use fewer window ops, or aggregate the rows first");
  }
  for (const op of ops) {
    const cls = WINDOW_OP_COST[op];
    if (cls === "sort") acc.ms += n * MS.sortWhole;
    else if (cls === "rescan" && span) acc.ms += n * span * MS.rescan;
    else acc.ms += n * MS.incremental;
  }
}

function checkOp(op: unknown, at: Seg[]): void {
  if (typeof op !== "string" || !has(AGGREGATE_OP_COST, op)) unknownCost(at, `the aggregate op "${String(op)}"`);
}

/** W1: an aggregate transform hands on its groups. */
function aggregateCost(t: Obj, at: Seg[], rows: Rows, acc: Acc): Rows {
  if (!Array.isArray(t.aggregate)) unknownCost(at, "an aggregate without ops");
  (t.aggregate as unknown[]).forEach((x, j) => checkOp(isObj(x) ? x.op : undefined, [...at, "aggregate", j, "op"]));
  const by = Array.isArray(t.groupby) ? (t.groupby as unknown[]).map(String) : [];
  acc.ms += rows.n * (t.aggregate as unknown[]).length * MS.aggregateOp;
  return { n: groups(rows, by), data: null };
}

/** Rows a view's transforms hand on, every transform costed. */
function transforms(ts: unknown, at: Seg[], rows: Rows, acc: Acc): Rows {
  if (ts === undefined) return rows;
  if (!Array.isArray(ts)) return unknownCost(at, "a transform list it cannot read");
  ts.forEach((t, i) => {
    const here = [...at, i];
    if (!isObj(t)) unknownCost(here, "a transform it cannot read");
    const key = Object.keys(t).find((k) => has(TRANSFORM_COST, k));
    if (!key) return unknownCost(here, `the transform ${Object.keys(t).join(", ") || "{}"}`);
    const cls = TRANSFORM_COST[key];
    if (cls === "fold") {
      const width = Math.max(1, Array.isArray(t.fold) ? t.fold.length : 1);
      const keyField = Array.isArray(t.as) && typeof t.as[0] === "string" ? t.as[0] : "key";
      rows = { n: rows.n * width, data: null, known: new Map([[keyField, width]]) };
      return;
    }
    if (cls === "window") windowCost(t, here, rows, acc);
    else if (cls === "aggregate") rows = aggregateCost(t, here, rows, acc);
    else acc.ms += rows.n * MS.linearTransform;
    // Conservative by construction: a transform that writes or renames a field (every one but filter, which only
    // drops rows, so what is known stays an upper bound) makes what the inline data said about fields unknown, so
    // groups count as rows from here on.
    if (key !== "filter") rows = { n: rows.n, data: null };
  });
  return rows;
}

/** Channel defs of an encoding, a list channel flattened. */
function channelDefs(enc: Obj): Array<{ ch: string; def: Obj; at: Seg[] }> {
  const out: Array<{ ch: string; def: Obj; at: Seg[] }> = [];
  for (const [ch, v] of Object.entries(enc)) {
    if (Array.isArray(v)) v.forEach((d, i) => isObj(d) && out.push({ ch, def: d, at: [ch, i] }));
    else if (isObj(v)) out.push({ ch, def: v, at: [ch] });
  }
  return out;
}

/** Properties that leave a field channel a plain grouping dimension (Vega-Lite groups by the field alone; measured
 *  for sort, a tooltip list and a value condition, but a condition blocks W2 by the ruling). */
const PLAIN_KEYS: ReadonlySet<string> = new Set(["field", "type", "timeUnit", "bin", "sort", "title", "axis", "scale", "legend", "format", "formatType", "bandPosition"]);
const isPlain = (def: Obj): boolean => typeof def.field === "string" && Object.keys(def).every((k) => PLAIN_KEYS.has(k));

/** W2 and W3: how many groups `dims` make, provably, or else every row. */
function dimGroups(rows: Rows, dims: Obj[], conditioned: boolean): number {
  if (dims.length === 0) return conditioned ? rows.n : 1;
  if (conditioned || !dims.every(isPlain)) return rows.n;
  const counted = (d: Obj) => d.bin !== undefined && d.bin !== false && d.bin !== "binned" && !(isObj(d.bin) && d.bin.binned === true);
  const bins = dims.filter(counted).reduce((p, d) => p * ((isObj(d.bin) && typeof d.bin.maxbins === "number" ? d.bin.maxbins : 10) + 2), 1);
  const fields = dims.filter((d) => !counted(d)).map((d) => String(d.field));
  return Math.min(rows.n, groups(rows, [...new Set(fields)]) * bins);
}

/** Channels by which Vega-Lite splits a line or area into paths (pathGroupingFields; order too, on an area). */
const PATH_GROUPING: ReadonlySet<string> = new Set(["color", "opacity", "size", "strokeDash", "detail"]);

/** `enc`: the view's encoding over the encoding its layers share, as Vega-Lite merges them. */
function markCost(view: Obj, at: Seg[], rows: Rows, acc: Acc, enc: Obj): void {
  const mark = view.mark;
  const type = String(isObj(mark) ? mark.type : mark);
  if (!has(MARK_COST, type)) unknownCost([...at, "mark"], `the mark "${type}"`);
  const cls = MARK_COST[type]!;
  const defs = channelDefs(enc);
  // what the grammar cut (review 7 ruling) has no cost here either, so the walker alone still fails closed
  if (isObj(mark) && mark.extent === "ci") unknownCost([...at, "mark", "extent"], 'extent "ci"');
  for (const { def, at: a } of defs) {
    if (isObj(def.sort) && has(def.sort, "op")) unknownCost([...at, "encoding", ...a, "sort", "op"], "a sort by an aggregate op");
    const conds = Array.isArray(def.condition) ? def.condition : [def.condition];
    if (conds.some((c) => isObj(c) && has(c, "field"))) unknownCost([...at, "encoding", ...a, "condition"], "a condition with a field");
  }
  const conditioned = defs.some(({ def }) => has(def, "condition"));
  const aggregated = defs.filter(({ def }) => typeof def.aggregate === "string");
  aggregated.forEach(({ def, at: a }) => checkOp(def.aggregate, [...at, "encoding", ...a, "aggregate"]));
  const dims = defs.filter(({ def }) => typeof def.field === "string" && typeof def.aggregate !== "string");
  // a sort by a field aggregates it once more for the domain; it reduces nothing
  const sorts = defs.filter(({ def }) => isObj(def.sort) && typeof def.sort.field === "string").length;
  acc.ms += rows.n * (aggregated.length + sorts) * MS.aggregateOp;
  let drawn = aggregated.length ? dimGroups(rows, dims.map((d) => d.def), conditioned) : rows.n;
  let counted = 0;
  if (cls === "composite") {
    // a composite aggregates its one quantitative positional channel by the other field channels
    const quant = (["x", "y"] as const).filter((c) => isObj(enc[c]) && (enc[c] as Obj).type === "quantitative");
    const others = quant.length === 1 ? dims.filter(({ def }) => def !== enc[quant[0]!]).map((d) => d.def) : null;
    drawn = others ? dimGroups(rows, others, conditioned) : rows.n;
    const outliers = type === "boxplot" && !(isObj(mark) && mark.extent === "min-max") ? rows.n : 0;
    counted = drawn + outliers;
    acc.ms += rows.n * MS.aggregatedRow + counted * MS.pointMark;
  }
  const withPoints = isObj(mark) && (mark.point === true || isObj(mark.point) || mark.point === "transparent");
  let paths = 0;
  if (cls === "path") {
    const grouping = dims.filter(({ ch }) => PATH_GROUPING.has(ch) || (ch === "order" && type === "area")).map((d) => d.def);
    paths = Math.min(drawn, grouping.length || conditioned ? dimGroups(rows, grouping, conditioned) : 1);
    const stacked = type === "area" || defs.some(({ def }) => def.stack !== undefined && def.stack !== null && def.stack !== false);
    if (stacked && paths > 1) {
      // the impute key is the positional channel that is not the stacked measure; when that is unclear, either one
      const stackedOn = (c: "x" | "y") => isObj(enc[c]) && (((enc[c] as Obj).stack ?? null) !== null && (enc[c] as Obj).stack !== false);
      const quant = (c: "x" | "y") => isObj(enc[c]) && (enc[c] as Obj).type === "quantitative";
      const measure = stackedOn("y") || (quant("y") && !quant("x")) ? "y" : stackedOn("x") || (quant("x") && !quant("y")) ? "x" : null;
      const keys = (["x", "y"] as const).filter((c) => c !== measure);
      const values = keys.map((c) => (isObj(enc[c]) && typeof (enc[c] as Obj).field === "string" ? dimGroups(rows, [enc[c] as Obj], conditioned) : 1));
      drawn = Math.max(drawn, Math.max(...values) * paths);
    }
  }
  counted += (cls === "point" || cls === "bar" ? drawn : 0) + (withPoints ? drawn : 0) + paths;
  if (counted) {
    acc.marks += counted;
    if (acc.marks > DISPLAY_LIMITS.chartMarks) {
      throw new TooCostly([...at, "mark"], `${acc.marks} marks drawn (rows x views); a chart draws at most ${DISPLAY_LIMITS.chartMarks}`, "aggregate or sample the rows, or draw them in fewer layers");
    }
  }
  for (const c of ["x", "y"] as const) {
    const def = enc[c];
    if (isObj(def) && typeof def.field === "string" && (def.type === "nominal" || def.type === "ordinal")) acc.ms += dimGroups(rows, [def], false) * MS.axisLabel;
  }
  if (cls === "point") acc.ms += drawn * MS.pointMark;
  else if (cls === "bar") acc.ms += drawn * MS.bar;
  else if (cls === "path") acc.ms += drawn * MS.vertex + paths * MS.path;
  if (withPoints) acc.ms += drawn * MS.pointMark;
}

function view(v: unknown, at: Seg[], inherited: Rows, acc: Acc, depth: number, shared: Obj): void {
  if (!isObj(v)) unknownCost(at, "a view it cannot read");
  if (depth > MAX_VIEW_DEPTH) unknownCost(at, `views nested deeper than ${MAX_VIEW_DEPTH}`);
  let rows = inherited;
  if (has(v, "data")) {
    if (!isObj(v.data) || !Array.isArray(v.data.values)) unknownCost([...at, "data"], "data it cannot read");
    const values = (v.data as Obj).values as unknown[];
    rows = { n: values.length, data: values.every(isObj) ? (values as Obj[]) : null };
  }
  rows = transforms(v.transform, [...at, "transform"], rows, acc);
  // a layer's encoding is inherited by its views, so a shared channel is costed where it is drawn
  const enc = { ...shared, ...(isObj(v.encoding) ? v.encoding : {}) };
  if (has(v, "mark")) return markCost(v, at, rows, acc, enc);
  const key = (["layer", "vconcat"] as const).find((k) => Array.isArray(v[k]));
  if (!key) unknownCost(at, "a view with no mark, layer or vconcat");
  (v[key!] as unknown[]).forEach((c, i) => view(c, [...at, key!, i], rows, acc, depth + 1, enc));
}

/** The cost of drawing `spec` (a chart spec validateBlock accepted, `{vl, series_order?}`). A fault's path starts at
 *  `spec`, as validateBlock's do. Never throws; a shape it cannot read is TOO_COSTLY. */
export function chartCost(spec: unknown): ChartCostCheck {
  const acc: Acc = { ms: MS.chart, windowOpRows: 0, marks: 0 };
  try {
    if (!isObj(spec)) unknownCost([], "a spec it cannot read");
    view(spec.vl, ["vl"], { n: 0, data: [] }, acc, 0, {});
  } catch (e) {
    if (e instanceof TooCostly) return { ok: false, code: "TOO_COSTLY", path: displayPath(["spec", ...e.path]), message: e.message, hint: e.hint };
    return { ok: false, code: "TOO_COSTLY", path: "spec.vl", message: "the cost of this chart could not be estimated" };
  }
  const estimateMs = Math.round(acc.ms);
  if (!(estimateMs <= DISPLAY_LIMITS.chartCostBudgetMs)) {
    return { ok: false, code: "TOO_COSTLY", path: "spec.vl", message: `an estimated ${estimateMs} ms to draw; a chart is held to ${DISPLAY_LIMITS.chartCostBudgetMs}`, hint: "aggregate the rows, draw fewer layers, or use fewer window ops" };
  }
  return { ok: true, estimateMs };
}
