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
 * about 0.0025 per row per op; median, quartiles and distinct windows over the whole partition about 0.003 per row,
 * ci0/ci1 windows about 0.015; min and max rescan their frame when a value leaves it, about 0.00015 per row x span, and
 * are incremental when the frame's start is open; an aggregate op about 0.0005 per input row (20 aggregates x 9 median,
 * q1 and distinct ops: 358); a ci0/ci1 bootstrap outside a window (an aggregate, a channel's aggregate, a sort op, an
 * errorband or errorbar with extent "ci") about 0.12 per group per field (one field over 5,000 groups: 529-589; twenty
 * chained aggregates of three: 24,800); filter, bin, timeUnit and stack about 0.0005 per row; drawing about 0.025 per
 * point-like mark, 0.07 per bar, 0.01 per line or area vertex, 0.002 per row an errorband, errorbar or boxplot reads.
 * A line or area splits into a path per value of a grouping channel (color, opacity, size, strokeDash, detail, and
 * order on an area), about 0.05 per path (2,000 paths: 163); a stacked one (every area, a line with `stack`) imputes
 * every x value for every path, about 0.005 per imputed row (500 paths x 500 x values: 1,178; 2,000 x 2,000:
 * 18,949), so an area's vertices are its x values x paths. Each path counts as a mark.
 * Rows are counted after every fold; an aggregate reduces them to its groups (1 without groupby, else the product of
 * its groupby fields' distinct values in the inline data, when every field is there; otherwise not reduced), and a
 * channel aggregate reduces the marks drawn the same way. Conservative by construction (review 6): once any
 * transform but a filter has run, nothing the inline data said about fields is used again (a window, bin, timeUnit or
 * stack may write over a field), so groups count as rows; rows never shrink unless an aggregate provably groups them.
 *
 * Rules, in the order a fault is reported:
 * 1. median, q1, q3, ci0, ci1 and distinct windows run over the whole partition only: frame [null, null];
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
  bootstrapWindow: 0.015,
  rescan: 0.00015,
  aggregateOp: 0.0005,
  bootstrapGroupField: 0.12,
  linearTransform: 0.0005,
  pointMark: 0.025,
  bar: 0.07,
  vertex: 0.01,
  path: 0.06,
  aggregatedRow: 0.002,
} as const;

/** Every window op's cost class (the table test holds this to the grammar's list). */
export const WINDOW_OP_COST: Readonly<Record<string, "incremental" | "sort" | "bootstrap" | "rescan">> = {
  row_number: "incremental", rank: "incremental", dense_rank: "incremental", percent_rank: "incremental",
  cume_dist: "incremental", ntile: "incremental", lag: "incremental", lead: "incremental", first_value: "incremental",
  last_value: "incremental", nth_value: "incremental", count: "incremental", valid: "incremental",
  missing: "incremental", sum: "incremental", product: "incremental", mean: "incremental", average: "incremental",
  variance: "incremental", variancep: "incremental", stdev: "incremental", stdevp: "incremental", stderr: "incremental",
  median: "sort", q1: "sort", q3: "sort", distinct: "sort", ci0: "bootstrap", ci1: "bootstrap", min: "rescan",
  max: "rescan",
};

/** Every aggregate op's cost class (in an aggregate transform, a channel's aggregate or a sort op). */
export const AGGREGATE_OP_COST: Readonly<Record<string, "linear" | "bootstrap">> = {
  count: "linear", valid: "linear", missing: "linear", distinct: "linear", sum: "linear", product: "linear",
  mean: "linear", average: "linear", variance: "linear", variancep: "linear", stdev: "linear", stdevp: "linear",
  stderr: "linear", median: "linear", q1: "linear", q3: "linear", ci0: "bootstrap", ci1: "bootstrap", min: "linear",
  max: "linear",
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

/** How many groups `fields` make: the product of their distinct values in the data, at most the rows; the rows when
 *  any field is not in the data. */
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
    let present = false;
    for (const r of rows.data) {
      if (!has(r, f)) continue;
      present = true;
      seen.add(JSON.stringify(r[f]));
    }
    if (!present) return rows.n;
    product *= seen.size;
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
    if (cls === "bootstrap") acc.ms += n * MS.bootstrapWindow;
    else if (cls === "sort") acc.ms += n * MS.sortWhole;
    else if (cls === "rescan" && span) acc.ms += n * span * MS.rescan;
    else acc.ms += n * MS.incremental;
  }
}

/** The fields an aggregate-op list bootstraps (ci0 and ci1 of one field share one bootstrap). */
function bootstrapFields(ops: Array<{ op: string; field: unknown; at: Seg[] }>): Set<string> {
  const fields = new Set<string>();
  for (const { op, field, at } of ops) {
    if (!has(AGGREGATE_OP_COST, op)) unknownCost(at, `the aggregate op "${op}"`);
    if (AGGREGATE_OP_COST[op] === "bootstrap") fields.add(String(field));
  }
  return fields;
}

function aggregateCost(t: Obj, at: Seg[], rows: Rows, acc: Acc): Rows {
  if (!Array.isArray(t.aggregate)) unknownCost(at, "an aggregate without ops");
  const ops = (t.aggregate as unknown[]).map((x, j) => ({ op: isObj(x) ? String(x.op) : "", field: isObj(x) ? x.field : undefined, at: [...at, "aggregate", j, "op"] }));
  const by = Array.isArray(t.groupby) ? (t.groupby as unknown[]).map(String) : [];
  const g = groups(rows, by);
  acc.ms += rows.n * ops.length * MS.aggregateOp + g * bootstrapFields(ops).size * MS.bootstrapGroupField;
  return { n: g, data: null };
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

/** Channels by which Vega-Lite splits a line or area into paths (pathGroupingFields; order too, on an area). */
const PATH_GROUPING: ReadonlySet<string> = new Set(["color", "opacity", "size", "strokeDash", "detail"]);

/** `enc`: the view's encoding over the encoding its layers share, as Vega-Lite merges them. */
function markCost(view: Obj, at: Seg[], rows: Rows, acc: Acc, enc: Obj): void {
  const mark = view.mark;
  const type = String(isObj(mark) ? mark.type : mark);
  if (!has(MARK_COST, type)) unknownCost([...at, "mark"], `the mark "${type}"`);
  const cls = MARK_COST[type]!;
  const defs = channelDefs(enc);
  // channel aggregates and sort ops: their bootstraps, and the groups that remain
  const aggOps = defs.flatMap(({ def, at: a }) => [
    ...(typeof def.aggregate === "string" ? [{ op: def.aggregate, field: def.field, at: [...at, "encoding", ...a, "aggregate"] }] : []),
    ...(isObj(def.sort) && typeof def.sort.op === "string" ? [{ op: def.sort.op, field: def.sort.field, at: [...at, "encoding", ...a, "sort", "op"] }] : []),
  ]);
  const ciFields = bootstrapFields(aggOps);
  // a binned channel groups into at most its maxbins (10 by default); the other plain fields group by their values
  // `bin: "binned"` means the data is already binned: it groups by its values, so it stays a plain field
  const binned = defs.filter(({ def }) => typeof def.field === "string" && def.bin !== undefined && def.bin !== false && def.bin !== "binned");
  const bins = binned.reduce((p, { def }) => p * (isObj(def.bin) && typeof def.bin.maxbins === "number" ? def.bin.maxbins : 10), 1);
  const plain = defs.filter(({ def }) => typeof def.field === "string" && typeof def.aggregate !== "string" && !binned.some((b) => b.def === def)).map(({ def }) => String(def.field));
  let drawn = aggOps.length ? Math.min(rows.n, groups(rows, [...new Set(plain)]) * bins) : rows.n;
  if (cls === "composite") {
    // a composite mark aggregates its continuous channel by the other positional one
    const x = isObj(enc.x) ? enc.x : null;
    const y = isObj(enc.y) ? enc.y : null;
    const field = (d: Obj | null) => (d && typeof d.field === "string" ? [d.field] : []);
    const qx = x?.type === "quantitative";
    const qy = y?.type === "quantitative";
    drawn = qy && !qx ? groups(rows, field(x)) : qx && !qy ? groups(rows, field(y)) : Math.max(groups(rows, field(x)), groups(rows, field(y)));
    if (isObj(mark) && mark.extent === "ci") for (const f of [...field(qy ? y : x)]) ciFields.add(f);
    acc.ms += rows.n * MS.aggregatedRow;
  }
  acc.ms += drawn * ciFields.size * MS.bootstrapGroupField + (aggOps.length ? rows.n * aggOps.length * MS.aggregateOp : 0);
  const withPoints = isObj(mark) && (mark.point === true || isObj(mark.point) || mark.point === "transparent");
  let paths = 0;
  if (cls === "path") {
    const grouping = defs.filter(({ ch, def }) => PATH_GROUPING.has(ch) || (ch === "order" && type === "area")).filter(({ def }) => typeof def.field === "string" && typeof def.aggregate !== "string").map(({ def }) => String(def.field));
    paths = grouping.length ? Math.min(drawn, groups(rows, [...new Set(grouping)])) : 1;
    const stacked = type === "area" || defs.some(({ def }) => def.stack !== undefined && def.stack !== null && def.stack !== false);
    if (stacked && paths > 1) {
      const positional = (["x", "y"] as const).map((c) => (isObj(enc[c]) && typeof (enc[c] as Obj).field === "string" ? groups(rows, [String((enc[c] as Obj).field)]) : 1));
      drawn = Math.max(drawn, Math.max(...positional) * paths);
    }
  }
  const counted = (cls === "point" || cls === "bar" ? drawn : 0) + (withPoints ? drawn : 0) + paths;
  if (counted) {
    acc.marks += counted;
    if (acc.marks > DISPLAY_LIMITS.chartMarks) {
      throw new TooCostly([...at, "mark"], `${acc.marks} marks drawn (rows x views); a chart draws at most ${DISPLAY_LIMITS.chartMarks}`, "aggregate or sample the rows, or draw them in fewer layers");
    }
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
