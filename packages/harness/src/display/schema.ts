import { gridColumnSchema, kpiTileSchema, showInputSchema } from "@mlpal/harness-protocol";
import { zodToJsonSchema } from "zod-to-json-schema";
import { sanitizeJsonSchema } from "../tools/types";

/**
 * The JSON schema the model is given for Show. The validator (checkShowInput) is the authority; this only guides.
 *
 * `spec` is described as an object with each kind's members named, two levels deep, because a schema that says
 * nothing about it (z.unknown()) left Haiku writing it as a JSON string, malformed every time (run 2: 7 of 34 calls).
 * It is one object with per-kind optional members, not a union per kind: Google's function declarations take no
 * oneOf, and a discriminated union is not portable across the providers the gateway serves. The whole schema keeps to
 * their common subset: no $ref, oneOf, allOf, const or additionalProperties, `type` always one name, and every
 * `object` with named properties (Gemini refuses an empty one); a free-form value is left untyped, described only.
 */

type Js = Record<string, unknown>;

const CHANNEL_TYPES = ["quantitative", "temporal", "ordinal", "nominal"];

const str = (description?: string): Js => ({ type: "string", ...(description ? { description } : {}) });
const arr = (items: Js, description?: string): Js => ({ type: "array", items, ...(description ? { description } : {}) });
const obj = (properties: Record<string, Js>, description?: string, required?: string[]): Js => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
  ...(description ? { description } : {}),
});
const any = (description: string): Js => ({ description });

// sized to guide, not to restate the grammar (the system section has it): each copy of a channel costs the schema
const channel = obj({ field: str(), type: { type: "string", enum: CHANNEL_TYPES }, aggregate: str("sum, mean, count...") });
const mark = any('"line", "bar", "point", "area", "rule", "rect", "text", "tick", "errorband", "errorbar", "boxplot", or {type, ...}');
const encoding = obj({ x: channel, y: channel }, "channels x, y, x2, y2, color, opacity, size, shape, strokeDash, text, tooltip, detail, order");
const transform = arr(any("filter, aggregate, bin, timeUnit, window, fold or stack"));
const view = obj({ mark, encoding }, "a view; it may add its own data and transform");

const vl = obj(
  {
    data: obj({ values: arr(any("one row, an object of field: value"), "the rows, inline") }),
    mark,
    encoding,
    layer: arr(view, "views drawn over each other"),
    vconcat: arr(any("a view or {layer}"), "top level only"),
    transform,
    title: any("text or {text, subtitle}"),
    width: any('pixels or "container"'),
    height: any("pixels"),
    params: arr(any('{name, select: "point"}')),
    resolve: any("{scale, axis, legend}"),
  },
  "chart: the Vega-Lite spec. Vega-Lite's own keys (data, mark, encoding, layer, transform) go here, inside vl",
);

const tile = kpiTileSchema.shape;
const tileProperties: Record<keyof typeof tile, Js> = {
  id: str(),
  label: str(),
  value: any("a number; text only with format text"),
  format: { type: "string", enum: [...tile.format.options] },
  unit: str(),
  sub: str(),
  delta: obj({ value: { type: "number" }, label: str(), good: { type: "string", enum: ["up", "down"] } }),
  spark: arr({ type: "number" }),
  status: { type: "string", enum: [...tile.status.unwrap().options] },
};
const column = gridColumnSchema.shape;
const columnProperties: Record<keyof typeof column, Js> = {
  key: str(),
  label: str(),
  type: { type: "string", enum: [...column.type.options] },
};

const SPEC: Js = obj(
  {
    vl,
    series_order: arr(str(), "chart: series names, in the order their colours follow"),
    tiles: arr(obj(tileProperties, undefined, ["id", "label", "value", "format"]), "kpis: the tiles"),
    columns: arr(obj(columnProperties, undefined, ["key", "label", "type"]), "grid: the columns"),
    rows: arr(any("one row: an object of column key: cell"), "grid: the rows"),
    row_key: str("grid: the column whose values are unique"),
  },
  "An object, never a JSON string. Give your kind's members only: chart {vl, series_order?}; kpis {tiles}; grid {columns, rows, row_key}",
);

/** zod's literal becomes `const`, which Google's schema does not know: a one-value enum says the same everywhere. */
function constToEnum(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(constToEnum);
  if (!node || typeof node !== "object") return;
  const o = node as Js;
  if ("const" in o) {
    o.enum = [o.const];
    delete o.const;
  }
  Object.values(o).forEach(constToEnum);
}

export const SHOW_JSON_SCHEMA: Js = (() => {
  const js = zodToJsonSchema(showInputSchema, { $refStrategy: "none" }) as Js & { required?: string[]; properties: Js };
  sanitizeJsonSchema(js);
  constToEnum(js);
  js.properties.spec = SPEC;
  js.required = [...new Set([...(js.required ?? []), "spec"])];
  return js;
})();
