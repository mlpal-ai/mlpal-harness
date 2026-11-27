import { z } from "zod";
import { DISPLAY_LIMITS, type BlockKind } from "./catalog.js";
import { checkBounds, isReservedName } from "./bounds.js";
import { checkChartSpec } from "./chart.js";
import { checked, fail, type DisplayCheck } from "./errors.js";
import { CONTROL, plainText } from "./fields.js";

/**
 * 0.27.0 display protocol: the first-wave block specs of `harness.v1/1` (DISPLAY-PROTOCOL-v0 §5.1). zod states each
 * shape; `validateBlock` adds what a shape cannot (unique keys, types per column, the chart allowlist) and is the one
 * check both the engine and a client run.
 */

const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const TILE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CURRENCY = /^[A-Z]{3}$/;

/** `chart`: a Vega-Lite 6 spec on the §5.2 subset, plus the series order colours follow wherever it is drawn. */
export const chartSpecSchema = z
  .object({
    vl: z.record(z.unknown()),
    series_order: z.array(plainText(60)).max(DISPLAY_LIMITS.chartSeries).optional(),
  })
  .strict();
export type ChartSpec = z.infer<typeof chartSpecSchema>;

/** `kpis`: summary tiles. `value` is a number except for `format: "text"`; a `percent` is the percentage (94.2 = 94.2 %);
 *  `currency` names its ISO 4217 code in `unit`. `delta.good` says which direction is good, for its colour. */
export const kpiTileSchema = z
  .object({
    id: z.string().regex(TILE_ID),
    label: plainText(40),
    value: z.union([z.number().finite(), plainText(24)]),
    format: z.enum(["number", "integer", "percent", "currency", "text"]),
    unit: plainText(12).optional(),
    sub: plainText(80).optional(),
    delta: z
      .object({ value: z.number().finite(), label: plainText(24).optional(), good: z.enum(["up", "down"]).optional() })
      .strict()
      .optional(),
    spark: z.array(z.number().finite()).min(2).max(60).optional(),
    status: z.enum(["ok", "warn", "bad", "neutral"]).optional(),
  })
  .strict();
export type KpiTile = z.infer<typeof kpiTileSchema>;
export const kpisSpecSchema = z.object({ tiles: z.array(kpiTileSchema).min(1).max(DISPLAY_LIMITS.kpiTiles) }).strict();
export type KpisSpec = z.infer<typeof kpisSpecSchema>;

/** `grid`: a data grid with inline rows. `num` and `bar` cells are numbers, `state` cells a status word; `row_key`
 *  names the column whose values identify rows (unique, never null). Rows from a file arrive with the file route. */
export const gridColumnSchema = z
  .object({ key: z.string().regex(FIELD_KEY), label: plainText(60), type: z.enum(["text", "code", "num", "bar", "state"]) })
  .strict();
export type GridColumn = z.infer<typeof gridColumnSchema>;
export const gridCellSchema = z.union([z.string().max(1_000), z.number().finite(), z.boolean(), z.null()]);
export type GridCell = z.infer<typeof gridCellSchema>;
export const gridSpecSchema = z
  .object({
    columns: z.array(gridColumnSchema).min(1).max(DISPLAY_LIMITS.gridColumns),
    rows: z.array(z.record(gridCellSchema)).max(DISPLAY_LIMITS.gridRows),
    row_key: z.string(),
  })
  .strict();
export type GridSpec = z.infer<typeof gridSpecSchema>;

export type BlockSpec = ChartSpec | KpisSpec | GridSpec;

type Path = ReadonlyArray<string | number>;

/** Parse with zod; its first issue becomes VALIDATION_FAILED at that path. */
export function parseShape<S extends z.ZodTypeAny>(schema: S, value: unknown, path: Path, hint?: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0]!;
  const where = [...path, ...issue.path];
  const message = issue.code === "unrecognized_keys" ? `unknown field${issue.keys.length > 1 ? "s" : ""}: ${issue.keys.join(", ")}` : issue.message;
  return fail("VALIDATION_FAILED", where, message, hint);
}

function checkKpis(spec: unknown, path: Path): KpisSpec {
  const kpis = parseShape(kpisSpecSchema, spec, path);
  const ids = new Set<string>();
  kpis.tiles.forEach((t, i) => {
    const at = [...path, "tiles", i];
    if (ids.has(t.id)) fail("VALIDATION_FAILED", [...at, "id"], `tile id "${t.id}" is used twice`);
    ids.add(t.id);
    if (t.format === "text" ? typeof t.value !== "string" : typeof t.value !== "number") {
      fail("VALIDATION_FAILED", [...at, "value"], t.format === "text" ? "a text tile's value is a string" : `a ${t.format} tile's value is a number`, "use format \"text\" for a word, a number for every other format");
    }
    if (t.format === "integer" && !Number.isInteger(t.value)) fail("VALIDATION_FAILED", [...at, "value"], "an integer tile's value is a whole number");
    if (t.format === "currency" && !(t.unit && CURRENCY.test(t.unit))) {
      fail("VALIDATION_FAILED", [...at, "unit"], "a currency tile names its ISO 4217 code in unit", 'for example "unit": "USD"');
    }
  });
  return kpis;
}

const CELL_TYPE: Record<GridColumn["type"], (v: GridCell) => boolean> = {
  text: () => true,
  code: (v) => typeof v === "string" || typeof v === "number" || v === null,
  num: (v) => typeof v === "number" || v === null,
  bar: (v) => typeof v === "number" || v === null,
  state: (v) => typeof v === "string" || v === null,
};

function checkGrid(spec: unknown, path: Path): GridSpec {
  const rows = (spec as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows) && rows.length > DISPLAY_LIMITS.gridRows) {
    fail("ROWS_OVER_LIMIT", [...path, "rows"], `${rows.length} rows; a grid carries at most ${DISPLAY_LIMITS.gridRows} inline`, "show the rows that matter (top N, exceptions) and say how many there are in the fallback");
  }
  const grid = parseShape(gridSpecSchema, spec, path);
  const columns = new Map<string, GridColumn>();
  grid.columns.forEach((c, i) => {
    if (isReservedName(c.key)) fail("VALIDATION_FAILED", [...path, "columns", i, "key"], `"${c.key}" is a name every object has, never a column key`, "rename the column");
    if (columns.has(c.key)) fail("VALIDATION_FAILED", [...path, "columns", i, "key"], `column key "${c.key}" is used twice`);
    columns.set(c.key, c);
  });
  if (!columns.has(grid.row_key)) fail("VALIDATION_FAILED", [...path, "row_key"], `row_key "${grid.row_key}" is not a column key`, `column keys: ${[...columns.keys()].join(", ")}`);
  const seen = new Set<string>();
  grid.rows.forEach((row, i) => {
    for (const [k, v] of Object.entries(row)) {
      const col = columns.get(k);
      if (!col) fail("VALIDATION_FAILED", [...path, "rows", i, k], `"${k}" is not a column key`, `column keys: ${[...columns.keys()].join(", ")}`);
      if (typeof v === "string" && CONTROL.test(v)) fail("VALIDATION_FAILED", [...path, "rows", i, k], "a cell has a control character (a terminal escape)");
      if (!CELL_TYPE[col.type](v)) fail("VALIDATION_FAILED", [...path, "rows", i, k], `a ${col.type} cell is ${col.type === "state" ? "a string" : col.type === "code" ? "a string or a number" : "a number"} or null`);
    }
    const key = Object.hasOwn(row, grid.row_key) ? row[grid.row_key] : undefined;
    if (key === undefined || key === null) fail("VALIDATION_FAILED", [...path, "rows", i, grid.row_key], "every row has a row_key value");
    const id = JSON.stringify(key);
    if (seen.has(id)) fail("VALIDATION_FAILED", [...path, "rows", i, grid.row_key], `row_key value ${id} is used twice`);
    seen.add(id);
  });
  return grid;
}

/** Throwing form, for a caller already inside `checked`; `path` prefixes every error's path. */
export function checkBlockSpec(kind: BlockKind, spec: unknown, path: Path): BlockSpec {
  switch (kind) {
    case "chart":
      return checkChartSpec(spec, path);
    case "kpis":
      return checkKpis(spec, path);
    case "grid":
      return checkGrid(spec, path);
  }
}

/** A block's spec against its kind: the spec as it is drawn (a chart's `$schema`, `config` and `usermeta` removed), or
 *  the first fault. Errors' paths start at `spec`. */
export function validateBlock(kind: BlockKind, spec: unknown): DisplayCheck<BlockSpec> {
  return checked(() => {
    checkBounds(spec, ["spec"]);
    return checkBlockSpec(kind, spec, ["spec"]);
  });
}

/** The rows a fallback table is made from: a grid's rows, a chart's first inline data (top level, else the first
 *  view that has some); none for kpis. Call on a validated spec. */
export function blockRows(kind: BlockKind, spec: BlockSpec): Array<Record<string, unknown>> | null {
  if (kind === "grid") return (spec as GridSpec).rows;
  if (kind === "chart") return firstInlineRows((spec as ChartSpec).vl);
  return null;
}

function firstInlineRows(view: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const values = (view.data as { values?: unknown } | undefined)?.values;
  if (Array.isArray(values)) return values as Array<Record<string, unknown>>;
  for (const key of ["layer", "vconcat"] as const) {
    const children = view[key];
    if (!Array.isArray(children)) continue;
    for (const c of children) {
      const rows = firstInlineRows(c as Record<string, unknown>);
      if (rows) return rows;
    }
  }
  return null;
}
