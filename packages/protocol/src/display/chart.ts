import { DISPLAY_LIMITS } from "./catalog.js";
import { fail } from "./errors.js";
import type { ChartSpec } from "./blocks.js";

/**
 * 0.27.0 display protocol: the Vega-Lite subset a `chart` block may use (DISPLAY-PROTOCOL-v0 §5.2). An allowlist, so
 * anything not named here is refused with its path: inline data only, no URL anywhere, no expression anywhere, layer
 * and vconcat only. The refusals close Vega's known holes (network through data and image URLs, the expression
 * interpreter). Engine and client run this same check; the renderer then sees only what passed it.
 *
 * The row limit counts inline rows times every `fold` above them, which is what the transforms can multiply; it does
 * not run the transforms. Fields an encoding names must exist in the data or be made by a transform's `as`.
 */

type Path = ReadonlyArray<string | number>;
type Obj = Record<string, unknown>;

const MARKS = new Set(["line", "area", "bar", "point", "rule", "rect", "text", "tick", "errorband", "errorbar", "boxplot"]);
const CHANNELS = new Set(["x", "y", "x2", "y2", "color", "opacity", "size", "shape", "strokeDash", "text", "tooltip", "detail", "order"]);
const SERIES_CHANNELS = ["color", "strokeDash", "shape", "detail"] as const;
const TRANSFORMS = new Set(["filter", "aggregate", "bin", "timeUnit", "window", "fold", "stack"]);
const VIEW_KEYS = new Set(["data", "mark", "encoding", "layer", "vconcat", "transform", "params", "title", "description", "width", "height", "name", "resolve"]);
/** Dropped from the top level before anything else: the renderer applies our tokens, and `$schema` is a URL. */
const STRIPPED = ["$schema", "config", "usermeta"] as const;
const COMPOSE_REFUSED = new Set(["facet", "repeat", "hconcat", "concat", "spec"]);
const FIELD_PREDICATES = new Set(["equal", "lt", "lte", "gt", "gte", "range", "oneOf", "valid"]);
const URL_LIKE = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:data|javascript|vbscript|blob|file|mailto):)/i;

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (xs: Iterable<string>) => [...xs].join(", ");

interface Walk {
  /** Every field the data or a transform makes: an encoding may name only these. */
  fields: Set<string>;
  /** Encoding fields to check once every view has been walked (a layer may use a field its sibling's data has). */
  uses: Array<{ field: string; path: Path }>;
  totalRows: number;
  cells: number;
}

/** No URL in any string, data included; no `expr` or `signal` key outside the data. */
function scan(x: unknown, path: Path, inData: boolean): void {
  if (typeof x === "string") {
    if (URL_LIKE.test(x)) fail("URL_NOT_ALLOWED", path, "a chart carries no URL; it draws inline data only", "put the values in data.values; drop links and image marks");
    return;
  }
  if (Array.isArray(x)) {
    x.forEach((v, i) => scan(v, [...path, i], inData));
    return;
  }
  if (!isObj(x)) return;
  for (const [k, v] of Object.entries(x)) {
    if (!inData && (k === "expr" || k === "signal")) fail("EXPRESSION_NOT_ALLOWED", [...path, k], `"${k}" is an expression; charts take none`, "precompute the value into the data");
    scan(v, [...path, k], inData || (k === "values" && path[path.length - 1] === "data"));
  }
}

function checkData(data: unknown, path: Path, w: Walk): unknown[] {
  if (!isObj(data)) fail("VALIDATION_FAILED", path, "data is an object with inline values");
  if ("url" in data) fail("URL_NOT_ALLOWED", [...path, "url"], "data.url is not allowed; only inline data is drawn", "put the rows in data.values");
  for (const g of ["sequence", "sphere", "graticule"]) if (g in data) fail("VALIDATION_FAILED", [...path, g], `data generators (${g}) are not allowed`, "put the rows in data.values");
  for (const k of Object.keys(data)) if (k !== "values" && k !== "name") fail("VALIDATION_FAILED", [...path, k], `unknown data field "${k}"`, "data takes values (and an optional name)");
  const values = data.values;
  if (!Array.isArray(values)) fail("VALIDATION_FAILED", [...path, "values"], "named data needs its rows inline in values", "data: { values: [ {...}, ... ] }");
  values.forEach((row, i) => {
    if (!isObj(row)) fail("VALIDATION_FAILED", [...path, "values", i], "a row is an object of field values");
    for (const [k, v] of Object.entries(row)) {
      if (!(v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) {
        fail("VALIDATION_FAILED", [...path, "values", i, k], "a value is a string, a finite number, a boolean or null", "flatten nested values into their own fields");
      }
      w.fields.add(k);
    }
    w.cells += Object.keys(row).length;
  });
  w.totalRows += values.length;
  return values;
}

function checkMark(mark: unknown, path: Path): void {
  const type = isObj(mark) ? mark.type : mark;
  if (typeof type !== "string") fail("VALIDATION_FAILED", isObj(mark) ? [...path, "type"] : path, "mark is a mark name or { type, ... }");
  if (!MARKS.has(type)) fail("VALIDATION_FAILED", isObj(mark) ? [...path, "type"] : path, `mark "${type}" is not allowed`, `marks: ${list(MARKS)}`);
  if (isObj(mark)) for (const k of ["href", "url"]) if (k in mark) fail("URL_NOT_ALLOWED", [...path, k], `mark.${k} is not allowed`);
}

function checkPredicate(p: unknown, path: Path): void {
  if (typeof p === "string") fail("EXPRESSION_NOT_ALLOWED", path, "an expression predicate is not allowed", 'use a field predicate: { "field": "x", "gte": 10 }');
  if (!isObj(p)) fail("VALIDATION_FAILED", path, "a predicate is an object");
  if ("and" in p || "or" in p) {
    const op = "and" in p ? "and" : "or";
    const parts = p[op];
    if (!Array.isArray(parts)) fail("VALIDATION_FAILED", [...path, op], `${op} takes a list of predicates`);
    parts.forEach((q, i) => checkPredicate(q, [...path, op, i]));
    return;
  }
  if ("not" in p) return checkPredicate(p.not, [...path, "not"]);
  if ("param" in p) return;
  if (typeof p.field !== "string" || !Object.keys(p).some((k) => FIELD_PREDICATES.has(k))) {
    fail("VALIDATION_FAILED", path, "a predicate names a field and a test", `tests: ${list(FIELD_PREDICATES)}; or { "param": "<selection>" }`);
  }
}

function checkChannelDef(def: unknown, path: Path, w: Walk): void {
  if (def === null || typeof def === "boolean") return;
  if (Array.isArray(def)) {
    def.forEach((d, i) => checkChannelDef(d, [...path, i], w));
    return;
  }
  if (!isObj(def)) fail("VALIDATION_FAILED", path, "a channel is an object such as { field, type }");
  if (typeof def.field === "string") w.uses.push({ field: def.field, path: [...path, "field"] });
  if ("condition" in def) {
    const conds = Array.isArray(def.condition) ? def.condition : [def.condition];
    conds.forEach((c, i) => {
      const at = Array.isArray(def.condition) ? [...path, "condition", i] : [...path, "condition"];
      if (!isObj(c)) fail("VALIDATION_FAILED", at, "a condition is an object");
      if (typeof c.test === "string") fail("EXPRESSION_NOT_ALLOWED", [...at, "test"], "a test string is an expression", 'use a predicate: { "test": { "field": "x", "gt": 0 }, "value": "..." } or { "param": "<selection>" }');
      if ("test" in c) checkPredicate(c.test, [...at, "test"]);
      if (typeof c.field === "string") w.uses.push({ field: c.field, path: [...at, "field"] });
    });
  }
}

function checkEncoding(enc: unknown, path: Path, w: Walk): Obj {
  if (!isObj(enc)) fail("VALIDATION_FAILED", path, "encoding is an object of channels");
  for (const [ch, def] of Object.entries(enc)) {
    if (ch === "href" || ch === "url") fail("URL_NOT_ALLOWED", [...path, ch], `the ${ch} channel is not allowed`);
    if (!CHANNELS.has(ch)) fail("VALIDATION_FAILED", [...path, ch], `channel "${ch}" is not allowed`, `channels: ${list(CHANNELS)}`);
    checkChannelDef(def, [...path, ch], w);
  }
  return enc;
}

function asNames(as: unknown): string[] {
  if (typeof as === "string") return [as];
  return Array.isArray(as) ? as.filter((x): x is string => typeof x === "string") : [];
}

/** Returns the factor the transforms multiply rows by (every fold). */
function checkTransforms(ts: unknown, path: Path, w: Walk): number {
  if (!Array.isArray(ts)) fail("VALIDATION_FAILED", path, "transform is a list");
  let factor = 1;
  ts.forEach((t, i) => {
    const at = [...path, i];
    if (!isObj(t)) fail("VALIDATION_FAILED", at, "a transform is an object");
    if ("calculate" in t) fail("EXPRESSION_NOT_ALLOWED", [...at, "calculate"], "calculate is an expression", "precompute the field into the data");
    const op = Object.keys(t).find((k) => TRANSFORMS.has(k));
    if (!op) fail("VALIDATION_FAILED", at, `transform ${list(Object.keys(t)) || "{}"} is not allowed`, `transforms: ${list(TRANSFORMS)}`);
    if (op === "filter") return checkPredicate(t.filter, [...at, "filter"]);
    if (op === "fold") {
      if (!Array.isArray(t.fold) || !t.fold.every((f) => typeof f === "string")) fail("VALIDATION_FAILED", [...at, "fold"], "fold takes a list of field names");
      factor *= Math.max(1, t.fold.length);
      const names = asNames(t.as);
      w.fields.add(names[0] ?? "key");
      w.fields.add(names[1] ?? "value");
      return;
    }
    if (op === "aggregate" || op === "window") {
      if (!Array.isArray(t[op])) fail("VALIDATION_FAILED", [...at, op], `${op} takes a list of { op, field, as }`);
      for (const a of t[op] as unknown[]) if (isObj(a)) asNames(a.as).forEach((n) => w.fields.add(n));
      return;
    }
    if (op === "bin") {
      const names = asNames(t.as);
      names.forEach((n) => w.fields.add(n));
      if (names.length === 1) w.fields.add(`${names[0]}_end`);
      return;
    }
    asNames(t.as).forEach((n) => w.fields.add(n));
  });
  return factor;
}

function checkParams(params: unknown, path: Path, w: Walk): void {
  if (!Array.isArray(params)) fail("VALIDATION_FAILED", path, "params is a list");
  params.forEach((p, i) => {
    const at = [...path, i];
    if (!isObj(p) || typeof p.name !== "string") fail("VALIDATION_FAILED", at, "a param is { name, select }");
    if ("bind" in p) fail("VALIDATION_FAILED", [...at, "bind"], "bound params (inputs) are not allowed", "a selection without bind becomes the person's selection context");
    const type = isObj(p.select) ? p.select.type : p.select;
    if (type !== "point" && type !== "interval") fail("VALIDATION_FAILED", [...at, "select"], "only point and interval selections are allowed", '"select": "point" or "interval"');
  });
}

function checkView(view: unknown, path: Path, w: Walk, o: { depth: number; values: unknown[]; factor: number }): void {
  if (!isObj(view)) fail("VALIDATION_FAILED", path, "a view is an object");
  for (const k of Object.keys(view)) {
    if (COMPOSE_REFUSED.has(k)) fail("VALIDATION_FAILED", [...path, k], `${k} is not allowed`, `compose with layer (at most ${DISPLAY_LIMITS.chartLayers}) or a top-level vconcat (at most ${DISPLAY_LIMITS.chartVconcat})`);
    if (!VIEW_KEYS.has(k)) fail("VALIDATION_FAILED", [...path, k], `unknown field "${k}"`, `a view takes: ${list(VIEW_KEYS)}`);
  }
  const shapes = (["mark", "layer", "vconcat"] as const).filter((k) => k in view);
  if (shapes.length !== 1) fail("VALIDATION_FAILED", path, "a view has exactly one of mark, layer or vconcat");
  const values = "data" in view ? checkData(view.data, [...path, "data"], w) : o.values;
  const rows = values.length;
  const factor = o.factor * ("transform" in view ? checkTransforms(view.transform, [...path, "transform"], w) : 1);
  if ("params" in view) checkParams(view.params, [...path, "params"], w);
  if (rows * factor > DISPLAY_LIMITS.chartRows) fail("ROWS_OVER_LIMIT", path, `${rows * factor} rows after fold; a chart draws at most ${DISPLAY_LIMITS.chartRows}`, "aggregate before showing, or show fewer series");
  const shape = shapes[0]!;
  if (shape === "mark") {
    checkMark(view.mark, [...path, "mark"]);
    if ("encoding" in view) checkSeries(checkEncoding(view.encoding, [...path, "encoding"], w), values, [...path, "encoding"]);
    return;
  }
  if (shape === "vconcat" && o.depth > 0) fail("VALIDATION_FAILED", [...path, "vconcat"], "vconcat is allowed at the top level only");
  const children = view[shape];
  const max = shape === "layer" ? DISPLAY_LIMITS.chartLayers : DISPLAY_LIMITS.chartVconcat;
  if (!Array.isArray(children) || children.length === 0 || children.length > max) fail("VALIDATION_FAILED", [...path, shape], `${shape} takes 1 to ${max} views`);
  if ("encoding" in view) checkEncoding(view.encoding, [...path, "encoding"], w);
  if (o.depth >= 3) fail("VALIDATION_FAILED", [...path, shape], "views nest at most three deep");
  children.forEach((c, i) => checkView(c, [...path, shape, i], w, { depth: o.depth + 1, values, factor }));
}

/** At most 12 series: the distinct values of a series channel's field in the data the view draws (a field a fold
 *  makes is not counted here: the fold's own list bounds it). */
function checkSeries(enc: Obj, values: unknown[], path: Path): void {
  for (const ch of SERIES_CHANNELS) {
    const def = enc[ch];
    if (!isObj(def) || typeof def.field !== "string") continue;
    const field = def.field;
    const distinct = new Set(values.map((r) => (isObj(r) ? JSON.stringify(r[field] ?? null) : "null")));
    if (distinct.size > DISPLAY_LIMITS.chartSeries) {
      fail("VALIDATION_FAILED", [...path, ch, "field"], `${distinct.size} series; a chart draws at most ${DISPLAY_LIMITS.chartSeries}`, 'keep the largest and group the rest as "Other"');
    }
  }
}

/** Throwing form for `checkBlockSpec`. Returns the spec as drawn: the top-level `$schema`, `config` and `usermeta`
 *  removed. */
export function checkChartSpec(spec: unknown, path: Path): ChartSpec {
  if (!isObj(spec)) fail("VALIDATION_FAILED", path, "a chart spec is { vl, series_order? }");
  for (const k of Object.keys(spec)) if (k !== "vl" && k !== "series_order") fail("VALIDATION_FAILED", [...path, k], `unknown field "${k}"`, "a chart spec is { vl, series_order? }");
  if (!isObj(spec.vl)) fail("VALIDATION_FAILED", [...path, "vl"], "vl is a Vega-Lite spec object");
  const vl: Obj = { ...spec.vl };
  for (const k of STRIPPED) delete vl[k];
  const at = [...path, "vl"];
  scan(vl, at, false);
  const w: Walk = { fields: new Set(), uses: [], totalRows: 0, cells: 0 };
  checkView(vl, at, w, { depth: 0, values: [], factor: 1 });
  if (w.totalRows === 0) fail("VALIDATION_FAILED", at, "a chart needs inline data", "data: { values: [ {...}, ... ] } at the top level or on a layer");
  if (w.totalRows > DISPLAY_LIMITS.chartRows) fail("ROWS_OVER_LIMIT", at, `${w.totalRows} inline rows; a chart draws at most ${DISPLAY_LIMITS.chartRows}`, "aggregate before showing");
  if (w.cells > DISPLAY_LIMITS.chartCells) fail("ROWS_OVER_LIMIT", at, `${w.cells} cells; a chart draws at most ${DISPLAY_LIMITS.chartCells}`, "drop fields the chart does not encode");
  for (const u of w.uses) {
    if (!w.fields.has(u.field)) fail("VALIDATION_FAILED", u.path, `field "${u.field}" is not in the data`, `fields: ${list(w.fields)}`);
  }
  const order = spec.series_order;
  if (order !== undefined) {
    if (!Array.isArray(order) || !order.every((s) => typeof s === "string" && s.length > 0 && s.length <= 60)) fail("VALIDATION_FAILED", [...path, "series_order"], "series_order is a list of series names");
    if (order.length > DISPLAY_LIMITS.chartSeries) fail("VALIDATION_FAILED", [...path, "series_order"], `at most ${DISPLAY_LIMITS.chartSeries} series`);
    if (new Set(order).size !== order.length) fail("VALIDATION_FAILED", [...path, "series_order"], "a series is named twice");
  }
  return { vl, ...(order !== undefined ? { series_order: order as string[] } : {}) };
}
