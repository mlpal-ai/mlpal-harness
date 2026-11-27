import { DISPLAY_LIMITS } from "./catalog.js";
import { displayPath } from "./errors.js";

/**
 * The one cost walker for a `chart` (UI reviews R2 and N2): what drawing a chart that passed validateBlock would cost a
 * renderer, and whether it fits. The engine's validator calls it, and a client calls the same function before it
 * compiles, so no cost rule lives anywhere else.
 *
 * Calibrated with the Vega 6.4.0 and Vega-Lite 6.5.0 the web UI ships, in Bun, warm (milliseconds; 5,000 rows unless
 * said; the report has the table): a chart's compile and parse about 50; incremental window ops (sum, mean, count,
 * rank...) about 0.0025 per row per op (20 sum windows over +-2,500: 264); median, quartiles and distinct over the
 * whole partition about 0.003 per row (4 medians: 67; 4 distinct: 96), ci0/ci1 about 0.015 (4: 311); min and max
 * rescan their frame when a value leaves it, about 0.00015 per row x span (+-100: 188; +-2,500: 918), and are
 * incremental when the frame's start is open; drawing about 0.025 per point-like mark (5,000 points: 163; 80,000 in
 * 16 views with tooltips: 1,747), 0.07 per bar (5,000 on a band scale: 227-356), 0.01 per line or area vertex (80,000: 790), 0.002 per
 * row an errorband, errorbar or boxplot aggregates (59). Rows are counted after every fold above them and never
 * reduced for an aggregate, so an estimate errs high.
 *
 * Rules, in the order a fault is reported:
 * 1. median, q1, q3, ci0, ci1 and distinct run over the whole partition only: frame [null, null];
 * 2. a frame whose start is bounded: rows x span (an open end counts to the partition's edge) <= chartWindowRowsTimesSpan;
 * 3. every window of the chart, every view counted: rows x ops <= chartWindowOpRows;
 * 4. point-like marks drawn (rows x views that draw them) <= chartMarks;
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
  bootstrapWhole: 0.015,
  rescan: 0.00015,
  pointMark: 0.025,
  bar: 0.07,
  vertex: 0.01,
  aggregatedRow: 0.002,
} as const;

const WHOLE_FRAME_OPS: ReadonlySet<string> = new Set(DISPLAY_LIMITS.chartWholeFrameOps);
const BOOTSTRAP_OPS: ReadonlySet<string> = new Set(["ci0", "ci1"]);
const RESCAN_OPS: ReadonlySet<string> = new Set(["min", "max"]);
const POINT_LIKE: ReadonlySet<string> = new Set(["point", "tick", "rule", "text", "rect", "circle", "square"]);
const PATHS: ReadonlySet<string> = new Set(["line", "area"]);
const AGGREGATED: ReadonlySet<string> = new Set(["errorband", "errorbar", "boxplot"]);

class TooCostly extends Error {
  constructor(
    readonly path: Seg[],
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

interface Acc {
  ms: number;
  windowOpRows: number;
  marks: number;
}

function windowCost(t: Obj, at: Seg[], rows: number, acc: Acc): void {
  const ops = Array.isArray(t.window) ? (t.window as unknown[]).map((x) => (isObj(x) ? String(x.op) : "")) : [];
  const frame = (Array.isArray(t.frame) ? t.frame : [null, 0]) as Array<number | null>;
  const [a, b] = [typeof frame[0] === "number" ? frame[0] : null, typeof frame[1] === "number" ? frame[1] : null];
  const whole = a === null && b === null;
  const w = ops.findIndex((op) => WHOLE_FRAME_OPS.has(op));
  if (w >= 0 && !whole) {
    throw new TooCostly(has(t, "frame") ? [...at, "frame"] : [...at, "window", w, "op"], `${ops[w]} over a sliding or cumulative frame recomputes for every row`, "use frame [null, null] (the whole partition), or aggregate first");
  }
  // A frame whose start is open only grows; one whose start is bounded drops rows as it slides.
  const span = a === null ? 0 : Math.min(rows, Math.abs((b === null ? rows : b) - a) + 1);
  if (span && rows * span > DISPLAY_LIMITS.chartWindowRowsTimesSpan) {
    throw new TooCostly([...at, "frame"], `${rows} rows x a frame of ${span}; at most ${DISPLAY_LIMITS.chartWindowRowsTimesSpan}`, "narrow the frame, or aggregate the rows first");
  }
  acc.windowOpRows += rows * ops.length;
  if (acc.windowOpRows > DISPLAY_LIMITS.chartWindowOpRows) {
    throw new TooCostly(at, `window ops x rows reach ${acc.windowOpRows}; a chart runs at most ${DISPLAY_LIMITS.chartWindowOpRows}`, "use fewer window ops, or aggregate the rows first");
  }
  for (const op of ops) {
    if (BOOTSTRAP_OPS.has(op)) acc.ms += rows * MS.bootstrapWhole;
    else if (WHOLE_FRAME_OPS.has(op)) acc.ms += rows * MS.sortWhole;
    else if (RESCAN_OPS.has(op) && span) acc.ms += rows * span * MS.rescan;
    else acc.ms += rows * MS.incremental;
  }
}

/** Rows a view's transforms hand on: every fold multiplies; nothing else is counted down. */
function transforms(ts: unknown, at: Seg[], rows: number, acc: Acc): number {
  if (!Array.isArray(ts)) return rows;
  ts.forEach((t, i) => {
    if (!isObj(t)) return;
    if (Array.isArray(t.fold)) rows *= Math.max(1, t.fold.length);
    else if (has(t, "window")) windowCost(t, [...at, i], rows, acc);
  });
  return rows;
}

function markCost(mark: unknown, at: Seg[], rows: number, acc: Acc): void {
  const type = String(isObj(mark) ? mark.type : mark);
  if (POINT_LIKE.has(type) || type === "bar") {
    acc.marks += rows;
    if (acc.marks > DISPLAY_LIMITS.chartMarks) {
      throw new TooCostly(at, `${acc.marks} marks drawn (rows x views); a chart draws at most ${DISPLAY_LIMITS.chartMarks}`, "aggregate or sample the rows, or draw them in fewer layers");
    }
    acc.ms += rows * (type === "bar" ? MS.bar : MS.pointMark);
  } else if (PATHS.has(type)) acc.ms += rows * MS.vertex;
  else if (AGGREGATED.has(type)) acc.ms += rows * MS.aggregatedRow;
  else acc.ms += rows * MS.pointMark;
}

function view(v: unknown, at: Seg[], inherited: number, acc: Acc): void {
  if (!isObj(v)) return;
  const values = isObj(v.data) && Array.isArray(v.data.values) ? v.data.values.length : inherited;
  const rows = transforms(v.transform, [...at, "transform"], values, acc);
  if (has(v, "mark")) return markCost(v.mark, [...at, "mark"], rows, acc);
  for (const key of ["layer", "vconcat"] as const) {
    const children = v[key];
    if (Array.isArray(children)) children.forEach((c, i) => view(c, [...at, key, i], rows, acc));
  }
}

/** The cost of drawing `spec` (a chart spec validateBlock accepted, `{vl, series_order?}`). A fault's path starts at
 *  `spec`, as validateBlock's do. Never throws. */
export function chartCost(spec: unknown): ChartCostCheck {
  const acc: Acc = { ms: MS.chart, windowOpRows: 0, marks: 0 };
  try {
    view(isObj(spec) ? spec.vl : undefined, ["vl"], 0, acc);
  } catch (e) {
    if (e instanceof TooCostly) return { ok: false, code: "TOO_COSTLY", path: displayPath(["spec", ...e.path]), message: e.message, hint: e.hint };
    return { ok: false, code: "TOO_COSTLY", path: "spec.vl", message: "the cost of this chart could not be estimated" };
  }
  const estimateMs = Math.round(acc.ms);
  if (estimateMs > DISPLAY_LIMITS.chartCostBudgetMs) {
    return { ok: false, code: "TOO_COSTLY", path: "spec.vl", message: `an estimated ${estimateMs} ms to draw; a chart is held to ${DISPLAY_LIMITS.chartCostBudgetMs}`, hint: "aggregate the rows, draw fewer layers, or use fewer window ops" };
  }
  return { ok: true, estimateMs };
}
