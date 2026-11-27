import { gridSpecSchema, kpisSpecSchema, type BlockSpec, type ChartSpec, type GridCell, type GridColumn, type GridSpec, type KpisSpec } from "./block-schemas.js";
import { DISPLAY_LIMITS, type BlockKind } from "./catalog.js";
import { checkBounds, isReservedName } from "./bounds.js";
import { checkChartSpec } from "./chart.js";
import { checked, fail, notice, report, type DisplayCheck } from "./errors.js";
import { CONTROL } from "./fields.js";
import { parseShape } from "./shape.js";

/**
 * 0.26.8 display protocol: the first-wave block specs of `harness.v1/1` (DISPLAY-PROTOCOL-v0 §5.1). zod states each
 * shape; `validateBlock` adds what a shape cannot (unique keys, types per column, the chart allowlist) and is the one
 * check both the engine and a client run.
 */

const CURRENCY = /^[A-Z]{3}$/;


type Path = ReadonlyArray<string | number>;

/** Parse with zod; its first issue becomes VALIDATION_FAILED at that path. */

function checkKpis(spec: unknown, path: Path): KpisSpec {
  const kpis = parseShape(kpisSpecSchema, spec, path);
  const ids = new Set<string>();
  kpis.tiles.forEach((t, i) => {
    const at = [...path, "tiles", i];
    if (ids.has(t.id)) report("VALIDATION_FAILED", [...at, "id"], `tile id "${t.id}" is used twice`);
    ids.add(t.id);
    if (t.format === "text" ? typeof t.value !== "string" : typeof t.value !== "number") {
      report("VALIDATION_FAILED", [...at, "value"], t.format === "text" ? "a text tile's value is a string" : `a ${t.format} tile's value is a number`, "use format \"text\" for a word, a number for every other format");
    } else if (t.format === "integer" && !Number.isInteger(t.value)) report("VALIDATION_FAILED", [...at, "value"], "an integer tile's value is a whole number");
    if (t.format === "currency" && !(t.unit && CURRENCY.test(t.unit))) {
      report("VALIDATION_FAILED", [...at, "unit"], "a currency tile names its ISO 4217 code in unit", 'for example "unit": "USD"');
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

/** `row_id` is taken as `row_key` (models write both); a missing row_key is the first column whose values are all
 *  present and unique. Each is a notice, not a refusal. */
function normaliseRowKey(spec: unknown, path: Path): unknown {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) return spec;
  const g = { ...(spec as Record<string, unknown>) };
  if (Object.hasOwn(g, "row_id")) {
    if (Object.hasOwn(g, "row_key") && g.row_key !== g.row_id) {
      fail("VALIDATION_FAILED", [...path, "row_id"], `row_id "${String(g.row_id)}" and row_key "${String(g.row_key)}" differ: a grid takes row_key only`, "drop row_id");
    }
    g.row_key = g.row_id;
    delete g.row_id;
    notice("spec.row_id: taken as row_key");
  }
  if (!Object.hasOwn(g, "row_key") && Array.isArray(g.columns) && Array.isArray(g.rows)) {
    const rows = g.rows as unknown[];
    const key = (g.columns as unknown[]).map((c) => (typeof c === "object" && c !== null ? (c as { key?: unknown }).key : undefined)).find((k) => {
      if (typeof k !== "string") return false;
      const seen = new Set<string>();
      for (const r of rows) {
        const v = typeof r === "object" && r !== null && Object.hasOwn(r, k) ? (r as Record<string, unknown>)[k] : undefined;
        if (v === undefined || v === null || seen.has(JSON.stringify(v))) return false;
        seen.add(JSON.stringify(v));
      }
      return true;
    });
    if (key !== undefined) {
      g.row_key = key;
      notice(`spec.row_key: none given; "${key}" is the first column whose values are unique`);
    }
  }
  return g;
}

function checkGrid(spec: unknown, path: Path): GridSpec {
  const rows = (spec as { rows?: unknown } | null)?.rows;
  if (Array.isArray(rows) && rows.length > DISPLAY_LIMITS.gridRows) {
    fail("ROWS_OVER_LIMIT", [...path, "rows"], `${rows.length} rows; a grid carries at most ${DISPLAY_LIMITS.gridRows} inline`, "show the rows that matter (top N, exceptions) and say how many there are in the fallback");
  }
  const grid = parseShape(gridSpecSchema, normaliseRowKey(spec, path), path);
  const columns = new Map<string, GridColumn>();
  grid.columns.forEach((c, i) => {
    if (isReservedName(c.key)) return report("VALIDATION_FAILED", [...path, "columns", i, "key"], `"${c.key}" is a name every object has, never a column key`, "rename the column");
    if (columns.has(c.key)) return report("VALIDATION_FAILED", [...path, "columns", i, "key"], `column key "${c.key}" is used twice`);
    columns.set(c.key, c);
  });
  // without its key column, rows cannot be checked for keys
  if (!columns.has(grid.row_key)) fail("VALIDATION_FAILED", [...path, "row_key"], `row_key "${grid.row_key}" is not a column key`, `column keys: ${[...columns.keys()].join(", ")}`);
  const seen = new Set<string>();
  grid.rows.forEach((row, i) => {
    for (const [k, v] of Object.entries(row)) {
      const col = columns.get(k);
      const at = [...path, "rows", i, k];
      if (!col) report("VALIDATION_FAILED", at, `"${k}" is not a column key`, `column keys: ${[...columns.keys()].join(", ")}`);
      else if (typeof v === "string" && CONTROL.test(v)) report("VALIDATION_FAILED", at, "a cell has a control character (a terminal escape)");
      else if (!CELL_TYPE[col.type](v)) report("VALIDATION_FAILED", at, `a ${col.type} cell is ${col.type === "state" ? "a string" : col.type === "code" ? "a string or a number" : "a number"} or null`);
    }
    const key = Object.hasOwn(row, grid.row_key) ? row[grid.row_key] : undefined;
    if (key === undefined || key === null) return report("VALIDATION_FAILED", [...path, "rows", i, grid.row_key], "every row has a row_key value");
    const id = JSON.stringify(key);
    if (seen.has(id)) report("VALIDATION_FAILED", [...path, "rows", i, grid.row_key], `row_key value ${id} is used twice`);
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
