import { DISPLAY_LIMITS } from "./catalog.js";
import { fail } from "./errors.js";
import type { ChartSpec } from "./blocks.js";

/**
 * 0.27.0 display protocol: the Vega-Lite subset a `chart` block may use (DISPLAY-PROTOCOL-v0 §5.2), as a strict
 * allowlist at every depth. Every object is checked against the keys its position allows, every value against its
 * type and bounds; nothing reaches the renderer unread. On top of that, anywhere outside the data rows, a key that
 * names an expression (`expr`, `signal`, `*Expr`, a selection's `on`, `clear`, `toggle`, `translate`, `zoom`, a
 * custom `formatType`) is EXPRESSION_NOT_ALLOWED and one that can load (`url`, `href`, `from`, `lookup`) is
 * URL_NOT_ALLOWED; a URL-looking string anywhere, the data included, is URL_NOT_ALLOWED. Engine and client run this
 * same check, after checkBounds has bounded depth and size, so the recursion here is bounded too.
 *
 * The row limit counts inline rows times every `fold` above them, which is all the allowed transforms can multiply;
 * it does not run the transforms. Fields an encoding, a predicate, a sort or a transform names must exist in some data
 * of the spec or be made by a transform's `as`.
 */

type Path = ReadonlyArray<string | number>;
type Obj = Record<string, unknown>;

interface Walk {
  /** Every field the data or a transform makes. */
  fields: Set<string>;
  /** Fields named anywhere, checked once every view has been walked (a layer may use a sibling's data). */
  uses: Array<{ field: string; path: Path }>;
  totalRows: number;
  cells: number;
}

type Rule = (v: unknown, path: Path, w: Walk) => void;

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const list = (xs: Iterable<string>) => [...xs].join(", ");

// ─── keys refused by name, anywhere outside the data rows ───

const EXPRESSION_KEYS = new Set(["expr", "signal", "on", "clear", "toggle", "translate", "zoom"]);
const LOADING_KEYS = new Set(["url", "href", "from", "lookup"]);
const URL_LIKE = /^\s*(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|(?:data|javascript|vbscript|blob|file|mailto):)/i;

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
    if (!inData) {
      if (EXPRESSION_KEYS.has(k) || /Expr$/.test(k)) fail("EXPRESSION_NOT_ALLOWED", [...path, k], `"${k}" is an expression; charts take none`, "precompute the value into the data");
      if (LOADING_KEYS.has(k)) fail("URL_NOT_ALLOWED", [...path, k], `"${k}" can load data; a chart draws inline data only`, "put the rows in data.values");
      if (k === "formatType" && v !== "number" && v !== "time") fail("EXPRESSION_NOT_ALLOWED", [...path, k], "a custom formatType is code", 'formatType is "number" or "time"');
    }
    scan(v, [...path, k], inData || (k === "values" && path[path.length - 1] === "data"));
  }
}

// ─── value rules ───

const str = (max: number): Rule => (v, p) => {
  if (typeof v !== "string" || v.length > max) fail("VALIDATION_FAILED", p, `a string of at most ${max} characters`);
};
const num = (min: number, max: number): Rule => (v, p) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail("VALIDATION_FAILED", p, `a number from ${min} to ${max}`);
};
const int = (min: number, max: number): Rule => (v, p) => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) fail("VALIDATION_FAILED", p, `a whole number from ${min} to ${max}`);
};
const bool: Rule = (v, p) => {
  if (typeof v !== "boolean") fail("VALIDATION_FAILED", p, "true or false");
};
const nul: Rule = (v, p) => {
  if (v !== null) fail("VALIDATION_FAILED", p, "null");
};
const enumOf = (...values: Array<string | number | boolean | null>): Rule => {
  const set = new Set(values);
  return (v, p) => {
    if (!set.has(v as string)) fail("VALIDATION_FAILED", p, `one of ${values.map((x) => JSON.stringify(x)).join(", ")}`);
  };
};
const scalar: Rule = (v, p) => {
  if (!(v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 200))) {
    fail("VALIDATION_FAILED", p, "a string, a finite number, a boolean or null");
  }
};
const arr = (item: Rule, max: number, min = 0): Rule => (v, p, w) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) fail("VALIDATION_FAILED", p, min === max ? `a list of ${max}` : `a list of ${min} to ${max}`);
  v.forEach((x, i) => item(x, [...p, i], w));
};
/** Dispatch on the JSON type of the value, so the error names what that type must be. */
const byType = (rules: { string?: Rule; number?: Rule; boolean?: Rule; null?: Rule; array?: Rule; object?: Rule }): Rule => (v, p, w) => {
  const t = v === null ? "null" : Array.isArray(v) ? "array" : (typeof v as "string" | "number" | "boolean" | "object");
  const rule = rules[t];
  if (!rule) fail("VALIDATION_FAILED", p, `a ${Object.keys(rules).join(" or ")}`);
  rule(v, p, w);
};
/** An object with these keys and no other; `required` keys must be present. */
const obj = (fields: Record<string, Rule>, required: string[] = []): Rule => (v, p, w) => {
  if (!isObj(v)) fail("VALIDATION_FAILED", p, `an object with ${list(Object.keys(fields))}`);
  for (const k of Object.keys(v)) if (!(k in fields)) fail("VALIDATION_FAILED", [...p, k], `unknown field "${k}"`, `allowed here: ${list(Object.keys(fields))}`);
  for (const k of required) if (!(k in v)) fail("VALIDATION_FAILED", [...p, k], `${k} is required here`);
  for (const [k, x] of Object.entries(v)) fields[k]!(x, [...p, k], w);
};
/** A field name an encoding, predicate, sort or transform reads: checked against the data at the end. */
const field: Rule = (v, p, w) => {
  str(128)(v, p, w);
  w.uses.push({ field: v as string, path: p });
};
/** A field name a transform makes. */
const output: Rule = (v, p, w) => {
  str(128)(v, p, w);
  w.fields.add(v as string);
};
const outputs = (max: number): Rule => byType({ string: output, array: arr(output, max, 1) });

// ─── the vocabulary ───

const MARKS = ["line", "area", "bar", "point", "rule", "rect", "text", "tick", "errorband", "errorbar", "boxplot"];
const REFUSED_MARKS = new Set(["image", "geoshape", "arc", "trail"]);
const CHANNELS = ["x", "y", "x2", "y2", "color", "opacity", "size", "shape", "strokeDash", "text", "tooltip", "detail", "order"];
const SERIES_CHANNELS = ["color", "strokeDash", "shape", "detail"] as const;
const TYPES = enumOf("quantitative", "temporal", "ordinal", "nominal");
const AGG_OPS = ["count", "valid", "missing", "distinct", "sum", "product", "mean", "average", "variance", "variancep", "stdev", "stdevp", "stderr", "median", "q1", "q3", "ci0", "ci1", "min", "max"];
const WINDOW_OPS = ["row_number", "rank", "dense_rank", "percent_rank", "cume_dist", "ntile", "lag", "lead", "first_value", "last_value", "nth_value", ...AGG_OPS];
const TIME_UNIT: Rule = (v, p) => {
  if (typeof v !== "string" || v.length > 40 || !/^(utc)?(year|quarter|month|week|day|dayofyear|date|hours|minutes|seconds|milliseconds)+$/.test(v)) {
    fail("VALIDATION_FAILED", p, "a time unit such as year, yearmonth, yearweek, monthdate, hours");
  }
};
const TOKEN: Rule = (v, p) => {
  if (typeof v !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(v)) fail("VALIDATION_FAILED", p, "a name of letters, digits, _ and -");
};
const COLOR = str(40);
const FONT = num(1, 72);
const ORDER = byType({ string: enumOf("ascending", "descending"), null: nul });
const TEXT = byType({ string: str(200), array: arr(str(200), 4, 1) });
const TITLE = byType({ string: str(200), array: arr(str(200), 4, 1), null: nul });
const FORMAT_TYPE = enumOf("number", "time");
const SIZE = byType({ number: int(1, 4_000), string: enumOf("container"), object: obj({ step: num(1, 200) }, ["step"]) });

const BIN_PARAMS = obj({ maxbins: int(2, 200), nice: bool, extent: arr(num(-1e15, 1e15), 2, 2), anchor: num(-1e15, 1e15), binned: bool });
const BIN = byType({ boolean: bool, string: enumOf("binned"), object: BIN_PARAMS });

const AXIS = byType({
  null: nul,
  object: obj({
    title: TITLE,
    format: str(64),
    formatType: FORMAT_TYPE,
    labelAngle: num(-360, 360),
    labelLimit: num(0, 1_000),
    labelOverlap: byType({ boolean: bool, string: enumOf("parity", "greedy") }),
    labelPadding: num(0, 100),
    labels: bool,
    ticks: bool,
    tickCount: int(0, 100),
    grid: bool,
    domain: bool,
    orient: enumOf("top", "bottom", "left", "right"),
    values: arr(scalar, 100),
    labelFontSize: FONT,
    titleFontSize: FONT,
    titlePadding: num(0, 100),
    offset: num(-200, 200),
    zindex: int(0, 10),
  }),
});
const LEGEND = byType({
  null: nul,
  object: obj({
    title: TITLE,
    format: str(64),
    formatType: FORMAT_TYPE,
    orient: enumOf("left", "right", "top", "bottom", "none", "top-left", "top-right", "bottom-left", "bottom-right"),
    direction: enumOf("horizontal", "vertical"),
    values: arr(scalar, 100),
    labelLimit: num(0, 1_000),
    symbolType: enumOf("circle", "square", "cross", "diamond", "triangle", "triangle-up", "triangle-down", "triangle-left", "triangle-right", "stroke", "arrow", "wedge"),
    symbolLimit: int(0, 100),
    columns: int(1, 20),
    labelFontSize: FONT,
    titleFontSize: FONT,
  }),
});
const SCALE = byType({
  null: nul,
  object: obj({
    type: enumOf("linear", "log", "pow", "sqrt", "symlog", "time", "utc", "ordinal", "band", "point", "quantize", "quantile", "threshold"),
    domain: byType({ array: arr(scalar, 100), string: enumOf("unaggregated") }),
    domainMin: num(-1e15, 1e15),
    domainMax: num(-1e15, 1e15),
    domainMid: num(-1e15, 1e15),
    range: arr(scalar, 100),
    scheme: TOKEN,
    zero: bool,
    nice: byType({ boolean: bool, number: int(1, 100) }),
    padding: num(0, 100),
    paddingInner: num(0, 1),
    paddingOuter: num(0, 10),
    reverse: bool,
    clamp: bool,
    exponent: num(0, 10),
  }),
});
const SORT_FIELD = obj({ field, order: ORDER }, ["field"]);
const SORT = byType({
  null: nul,
  string: enumOf("ascending", "descending", ...CHANNELS.flatMap((c) => [c, `-${c}`])),
  array: arr(scalar, 100),
  object: obj({ field, op: enumOf(...AGG_OPS), order: ORDER, encoding: enumOf(...CHANNELS) }),
});

/** A predicate: a field test, a selection, or and/or/not of predicates. */
const PREDICATE: Rule = (v, p, w) => {
  if (typeof v === "string") fail("EXPRESSION_NOT_ALLOWED", p, "an expression predicate is not allowed", 'use a field predicate: { "field": "x", "gte": 10 }');
  if (!isObj(v)) fail("VALIDATION_FAILED", p, "a predicate is an object");
  if ("and" in v || "or" in v) return obj({ and: arr(PREDICATE, 10, 1), or: arr(PREDICATE, 10, 1) })(v, p, w);
  if ("not" in v) return obj({ not: PREDICATE }, ["not"])(v, p, w);
  if ("param" in v) return obj({ param: TOKEN, empty: bool }, ["param"])(v, p, w);
  const tests = ["equal", "lt", "lte", "gt", "gte", "range", "oneOf", "valid"];
  obj({ field, timeUnit: TIME_UNIT, equal: scalar, lt: scalar, lte: scalar, gt: scalar, gte: scalar, range: arr(scalar, 2, 2), oneOf: arr(scalar, 100, 1), valid: bool }, ["field"])(v, p, w);
  if (!tests.some((t) => t in v)) fail("VALIDATION_FAILED", p, "a predicate names a field and a test", `tests: ${tests.join(", ")}; or { "param": "<selection>" }`);
};

const CONDITION: Rule = (v, p, w) => {
  obj({ param: TOKEN, test: PREDICATE, empty: bool, value: byType({ string: str(200), number: num(-1e15, 1e15), boolean: bool, null: nul, array: arr(num(0, 100), 8) }), field, type: TYPES, title: TITLE })(v, p, w);
  if ("param" in (v as Obj) === "test" in (v as Obj)) fail("VALIDATION_FAILED", p, "a condition has exactly one of param or test");
};

const CHANNEL_DEF = obj({
  field,
  type: TYPES,
  aggregate: enumOf(...AGG_OPS),
  bin: BIN,
  timeUnit: TIME_UNIT,
  title: TITLE,
  axis: AXIS,
  legend: LEGEND,
  scale: SCALE,
  sort: SORT,
  stack: byType({ null: nul, boolean: bool, string: enumOf("zero", "normalize", "center") }),
  format: str(64),
  formatType: FORMAT_TYPE,
  value: byType({ string: str(200), number: num(-1e15, 1e15), boolean: bool, null: nul, array: arr(num(0, 100), 8) }),
  datum: scalar,
  condition: byType({ object: CONDITION, array: arr(CONDITION, 4, 1) }),
  bandPosition: num(0, 1),
});
const CHANNEL_LIST = (max: number) => byType({ object: CHANNEL_DEF, array: arr(CHANNEL_DEF, max, 1) });
const CHANNEL_RULES: Record<string, Rule> = Object.fromEntries(CHANNELS.map((c) => [c, CHANNEL_DEF]));
CHANNEL_RULES.tooltip = byType({ null: nul, boolean: bool, object: CHANNEL_DEF, array: arr(CHANNEL_DEF, 20, 1) });
CHANNEL_RULES.detail = CHANNEL_LIST(DISPLAY_LIMITS.chartSeries);
CHANNEL_RULES.order = CHANNEL_LIST(4);
const ENCODING: Rule = (v, p, w) => {
  if (!isObj(v)) fail("VALIDATION_FAILED", p, "encoding is an object of channels");
  for (const ch of Object.keys(v)) if (!(ch in CHANNEL_RULES)) fail("VALIDATION_FAILED", [...p, ch], `channel "${ch}" is not allowed`, `channels: ${CHANNELS.join(", ")}`);
  obj(CHANNEL_RULES)(v, p, w);
};

const MARK_DEF = obj(
  {
    type: enumOf(...MARKS),
    color: COLOR,
    fill: COLOR,
    stroke: COLOR,
    opacity: num(0, 1),
    fillOpacity: num(0, 1),
    strokeOpacity: num(0, 1),
    strokeWidth: num(0, 20),
    strokeDash: arr(num(0, 100), 8),
    size: num(0, 10_000),
    point: byType({ boolean: bool, string: enumOf("transparent"), object: obj({ filled: bool, size: num(0, 10_000) }) }),
    line: bool,
    interpolate: enumOf("linear", "monotone", "step", "step-before", "step-after", "basis", "cardinal", "natural"),
    tooltip: bool,
    filled: bool,
    orient: enumOf("horizontal", "vertical"),
    align: enumOf("left", "center", "right"),
    baseline: enumOf("top", "middle", "bottom", "alphabetic"),
    dx: num(-1_000, 1_000),
    dy: num(-1_000, 1_000),
    angle: num(-360, 360),
    fontSize: FONT,
    fontWeight: byType({ string: enumOf("normal", "bold"), number: int(100, 900) }),
    text: str(200),
    cornerRadius: num(0, 100),
    thickness: num(0, 100),
    extent: byType({ string: enumOf("ci", "stderr", "stdev", "iqr", "min-max"), number: num(0, 10) }),
    clip: bool,
    binSpacing: num(0, 100),
  },
  ["type"],
);
const MARK: Rule = (v, p, w) => {
  const type = isObj(v) ? v.type : v;
  const at = isObj(v) ? [...p, "type"] : p;
  if (typeof type === "string" && REFUSED_MARKS.has(type)) fail("VALIDATION_FAILED", at, `mark "${type}" is not allowed`, `marks: ${MARKS.join(", ")}`);
  if (typeof v === "string") return enumOf(...MARKS)(v, p, w);
  MARK_DEF(v, p, w);
};

const SELECT = byType({
  string: enumOf("point", "interval"),
  object: obj({ type: enumOf("point", "interval"), fields: arr(field, 8, 1), encodings: arr(enumOf(...CHANNELS), 4, 1), nearest: bool, resolve: enumOf("global", "union", "intersect") }, ["type"]),
});
const PARAM: Rule = (v, p, w) => {
  if (isObj(v) && !("select" in v) && !("bind" in v)) fail("VALIDATION_FAILED", [...p, "select"], "only point and interval selections are allowed", '"select": "point" or "interval"');
  if (isObj(v) && "bind" in v) fail("VALIDATION_FAILED", [...p, "bind"], "bound params (inputs) are not allowed", "a selection without bind becomes the person's selection context");
  obj({ name: TOKEN, select: SELECT }, ["name", "select"])(v, p, w);
};

const SORT_LIST = arr(SORT_FIELD, 5, 1);
const GROUPBY = arr(field, 20, 1);
/** Each transform: its one op key and the keys that op takes. */
const TRANSFORMS: Record<string, Rule> = {
  filter: obj({ filter: PREDICATE }, ["filter"]),
  aggregate: obj({ aggregate: arr(obj({ op: enumOf(...AGG_OPS), field, as: output }, ["op", "as"]), 20, 1), groupby: GROUPBY }, ["aggregate"]),
  bin: obj({ bin: byType({ boolean: enumOf(true), object: BIN_PARAMS }), field, as: outputs(2) }, ["bin", "field", "as"]),
  timeUnit: obj({ timeUnit: TIME_UNIT, field, as: output }, ["timeUnit", "field", "as"]),
  window: obj({ window: arr(obj({ op: enumOf(...WINDOW_OPS), field, param: int(0, 1_000), as: output }, ["op", "as"]), 20, 1), frame: arr(byType({ number: int(-10_000, 10_000), null: nul }), 2, 2), groupby: GROUPBY, sort: SORT_LIST, ignorePeers: bool }, ["window"]),
  fold: obj({ fold: arr(field, 50, 1), as: arr(output, 2, 2) }, ["fold"]),
  stack: obj({ stack: field, groupby: arr(field, 20), as: outputs(2), offset: enumOf("zero", "center", "normalize"), sort: SORT_LIST }, ["stack", "groupby", "as"]),
};

/** Returns the factor the transforms multiply rows by (every fold). */
function checkTransforms(ts: unknown, path: Path, w: Walk): number {
  if (!Array.isArray(ts) || ts.length > 20) fail("VALIDATION_FAILED", path, "transform is a list of at most 20");
  let factor = 1;
  ts.forEach((t, i) => {
    const at = [...path, i];
    if (!isObj(t)) fail("VALIDATION_FAILED", at, "a transform is an object");
    if ("calculate" in t) fail("EXPRESSION_NOT_ALLOWED", [...at, "calculate"], "calculate is an expression", "precompute the field into the data");
    const ops = Object.keys(t).filter((k) => k in TRANSFORMS);
    if (ops.length !== 1) fail("VALIDATION_FAILED", at, ops.length ? `a transform has one op, not ${ops.join(" and ")}` : `transform ${list(Object.keys(t)) || "{}"} is not allowed`, `transforms: ${list(Object.keys(TRANSFORMS))}`);
    const op = ops[0]!;
    TRANSFORMS[op]!(t, at, w);
    if (op === "fold") {
      factor *= (t.fold as unknown[]).length;
      if (!("as" in t)) ["key", "value"].forEach((n) => w.fields.add(n));
    }
    if (op === "bin") {
      const names = typeof t.as === "string" ? [t.as] : (t.as as string[]);
      if (names.length === 1) w.fields.add(`${names[0]}_end`);
    }
  });
  return factor;
}

function checkData(data: unknown, path: Path, w: Walk): unknown[] {
  if (!isObj(data)) fail("VALIDATION_FAILED", path, "data is an object with inline values");
  for (const g of ["sequence", "sphere", "graticule"]) if (g in data) fail("VALIDATION_FAILED", [...path, g], `data generators (${g}) are not allowed`, "put the rows in data.values");
  for (const k of Object.keys(data)) if (k !== "values" && k !== "name") fail("VALIDATION_FAILED", [...path, k], `unknown data field "${k}"`, "data takes values (and an optional name)");
  if ("name" in data) TOKEN(data.name, [...path, "name"], w);
  const values = data.values;
  if (!Array.isArray(values)) fail("VALIDATION_FAILED", [...path, "values"], "named data needs its rows inline in values", "data: { values: [ {...}, ... ] }");
  values.forEach((row, i) => {
    if (!isObj(row)) fail("VALIDATION_FAILED", [...path, "values", i], "a row is an object of field values");
    for (const [k, v] of Object.entries(row)) {
      if (k.length > 128) fail("VALIDATION_FAILED", [...path, "values", i], "a field name is at most 128 characters");
      if (!(v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 1_000))) {
        fail("VALIDATION_FAILED", [...path, "values", i, k], "a value is a string of at most 1,000 characters, a finite number, a boolean or null", "flatten nested values into their own fields");
      }
      w.fields.add(k);
    }
    w.cells += Object.keys(row).length;
  });
  w.totalRows += values.length;
  return values;
}

const RESOLVE_MAP = obj(Object.fromEntries(CHANNELS.map((c) => [c, enumOf("shared", "independent")])));
const VIEW_FIELDS: Record<string, Rule> = {
  title: byType({ string: str(200), array: arr(str(200), 4, 1), object: obj({ text: TEXT, subtitle: TEXT, anchor: enumOf("start", "middle", "end"), fontSize: FONT }, ["text"]) }),
  description: str(500),
  width: SIZE,
  height: SIZE,
  name: TOKEN,
  resolve: obj({ scale: RESOLVE_MAP, axis: RESOLVE_MAP, legend: RESOLVE_MAP }),
};
const VIEW_KEYS = new Set(["data", "mark", "encoding", "layer", "vconcat", "transform", "params", ...Object.keys(VIEW_FIELDS)]);
const COMPOSE_REFUSED = new Set(["facet", "repeat", "hconcat", "concat", "spec"]);

function checkView(view: unknown, path: Path, w: Walk, o: { depth: number; values: unknown[]; factor: number }): void {
  if (!isObj(view)) fail("VALIDATION_FAILED", path, "a view is an object");
  for (const k of Object.keys(view)) {
    if (COMPOSE_REFUSED.has(k)) fail("VALIDATION_FAILED", [...path, k], `${k} is not allowed`, `compose with layer (at most ${DISPLAY_LIMITS.chartLayers}) or a top-level vconcat (at most ${DISPLAY_LIMITS.chartVconcat})`);
    if (!VIEW_KEYS.has(k)) fail("VALIDATION_FAILED", [...path, k], `unknown field "${k}"`, `a view takes: ${list(VIEW_KEYS)}`);
  }
  const shapes = (["mark", "layer", "vconcat"] as const).filter((k) => k in view);
  if (shapes.length !== 1) fail("VALIDATION_FAILED", path, "a view has exactly one of mark, layer or vconcat");
  for (const [k, rule] of Object.entries(VIEW_FIELDS)) if (k in view) rule(view[k], [...path, k], w);
  const values = "data" in view ? checkData(view.data, [...path, "data"], w) : o.values;
  const factor = o.factor * ("transform" in view ? checkTransforms(view.transform, [...path, "transform"], w) : 1);
  if ("params" in view) arr(PARAM, 8)(view.params, [...path, "params"], w);
  if (values.length * factor > DISPLAY_LIMITS.chartRows) fail("ROWS_OVER_LIMIT", path, `${values.length * factor} rows after fold; a chart draws at most ${DISPLAY_LIMITS.chartRows}`, "aggregate before showing, or show fewer series");
  if ("encoding" in view) {
    ENCODING(view.encoding, [...path, "encoding"], w);
    checkSeries(view.encoding as Obj, values, [...path, "encoding"]);
  }
  const shape = shapes[0]!;
  if (shape === "mark") return MARK(view.mark, [...path, "mark"], w);
  if (shape === "vconcat" && o.depth > 0) fail("VALIDATION_FAILED", [...path, "vconcat"], "vconcat is allowed at the top level only");
  const children = view[shape];
  const max = shape === "layer" ? DISPLAY_LIMITS.chartLayers : DISPLAY_LIMITS.chartVconcat;
  if (!Array.isArray(children) || children.length === 0 || children.length > max) fail("VALIDATION_FAILED", [...path, shape], `${shape} takes 1 to ${max} views`);
  if (o.depth >= 3) fail("VALIDATION_FAILED", [...path, shape], "views nest at most three deep");
  children.forEach((c, i) => checkView(c, [...path, shape, i], w, { depth: o.depth + 1, values, factor }));
}

/** At most 12 series: the distinct values of a series channel's field in the data the view draws (a field a fold
 *  makes is not counted here: the fold's own list bounds it). Applies to a layer's or vconcat's shared encoding too. */
function checkSeries(enc: Obj, values: unknown[], path: Path): void {
  for (const ch of SERIES_CHANNELS) {
    const def = enc[ch];
    if (!isObj(def) || typeof def.field !== "string") continue;
    const f = def.field;
    const distinct = new Set(values.map((r) => (isObj(r) ? JSON.stringify(r[f] ?? null) : "null")));
    if (distinct.size > DISPLAY_LIMITS.chartSeries) {
      fail("VALIDATION_FAILED", [...path, ch, "field"], `${distinct.size} series; a chart draws at most ${DISPLAY_LIMITS.chartSeries}`, 'keep the largest and group the rest as "Other"');
    }
  }
}

/** Throwing form for `checkBlockSpec`; the caller has run checkBounds. Returns the spec as drawn: the top-level
 *  `$schema`, `config` and `usermeta` removed. */
export function checkChartSpec(spec: unknown, path: Path): ChartSpec {
  if (!isObj(spec)) fail("VALIDATION_FAILED", path, "a chart spec is { vl, series_order? }");
  for (const k of Object.keys(spec)) if (k !== "vl" && k !== "series_order") fail("VALIDATION_FAILED", [...path, k], `unknown field "${k}"`, "a chart spec is { vl, series_order? }");
  if (!isObj(spec.vl)) fail("VALIDATION_FAILED", [...path, "vl"], "vl is a Vega-Lite spec object");
  const vl: Obj = { ...spec.vl };
  for (const k of ["$schema", "config", "usermeta"]) delete vl[k];
  const at = [...path, "vl"];
  scan(vl, at, false);
  const w: Walk = { fields: new Set(), uses: [], totalRows: 0, cells: 0 };
  checkView(vl, at, w, { depth: 0, values: [], factor: 1 });
  if (w.totalRows === 0) fail("VALIDATION_FAILED", at, "a chart needs inline data", "data: { values: [ {...}, ... ] } at the top level or on a layer");
  if (w.totalRows > DISPLAY_LIMITS.chartRows) fail("ROWS_OVER_LIMIT", at, `${w.totalRows} inline rows; a chart draws at most ${DISPLAY_LIMITS.chartRows}`, "aggregate before showing");
  if (w.cells > DISPLAY_LIMITS.chartCells) fail("ROWS_OVER_LIMIT", at, `${w.cells} cells; a chart draws at most ${DISPLAY_LIMITS.chartCells}`, "drop fields the chart does not encode");
  for (const u of w.uses) if (!w.fields.has(u.field)) fail("VALIDATION_FAILED", u.path, `field "${u.field}" is not in the data`, `fields: ${list(w.fields)}`);
  const order = spec.series_order;
  if (order !== undefined) {
    if (!Array.isArray(order) || !order.every((s) => typeof s === "string" && s.length > 0 && s.length <= 60)) fail("VALIDATION_FAILED", [...path, "series_order"], "series_order is a list of series names");
    if (order.length > DISPLAY_LIMITS.chartSeries) fail("VALIDATION_FAILED", [...path, "series_order"], `at most ${DISPLAY_LIMITS.chartSeries} series`);
    if (new Set(order).size !== order.length) fail("VALIDATION_FAILED", [...path, "series_order"], "a series is named twice");
  }
  return { vl, ...(order !== undefined ? { series_order: order as string[] } : {}) };
}
