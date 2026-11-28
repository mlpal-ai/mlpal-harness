import { gridColumnSchema, kpiTileSchema, MEDIA_KINDS, showInputSchema } from "@mlpal/harness-protocol";
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

/** The schema for a client that draws media kinds: the same, with the media kinds named, their spec members, and
 *  `fallback` optional (the engine writes a media block's lines). A client without media keeps SHOW_JSON_SCHEMA. */
export const SHOW_MEDIA_JSON_SCHEMA: Js = (() => {
  const js = structuredClone(SHOW_JSON_SCHEMA) as Js & { required: string[]; properties: Record<string, Js & { enum?: string[]; properties?: Record<string, Js>; description?: string }> };
  const kind = js.properties.kind!;
  kind.enum = [...(kind.enum ?? []), ...MEDIA_KINDS];
  kind.description = `${kind.description ?? ""}; image: a picture in the workspace; image_set: 2 to 8 pictures to compare; audio, video: to play; file: a download card for anything else`;
  const spec = js.properties.spec!;
  const image = obj({ path: str("a workspace path (media/… for what you make, uploads/… for what the person attached); never a URL"), alt: str("what the image shows, for a person who cannot see it") }, undefined, ["path", "alt"]);
  spec.properties = {
    ...spec.properties,
    path: str("image: the workspace path of a PNG, JPEG, GIF or WebP; never a URL"),
    alt: str("image: what it shows, for a person who cannot see it"),
    images: arr(image, "image_set: 2 to 8 images"),
    chosen: { type: "integer", description: "image_set: the index of the one chosen" },
    transcript: str("audio: what is said"),
    duration_s: { type: "number", description: "audio, video: seconds, only if you know it" },
    poster: str("video: the workspace path of a still image to show before it plays"),
    name: str("file: the name the person sees (default: the file's name)"),
  };
  spec.description = `${spec.description}; image {path, alt}; image_set {images, chosen?}; audio {path, transcript?, duration_s?}; video {path, alt, poster?, duration_s?}; file {path, name?}`;
  js.required = js.required.filter((k) => k !== "fallback");
  js.properties.fallback!.description = `${js.properties.fallback!.description ?? ""}. Optional for the media kinds: the engine writes a line per file`;
  return js;
})();
