import { z } from "zod";
import { DISPLAY_LIMITS } from "./catalog.js";
import { plainText } from "./fields.js";

/**
 * The first-wave block specs of `harness.v1/1` as zod shapes (DISPLAY-PROTOCOL-v0 §5.1): what the envelope schema
 * needs on the wire. Light by design: nothing here reaches the chart grammar or the cost walker (validate.ts), so a
 * client that only reads envelopes does not bundle them (a test holds the import graph to that).
 */

const FIELD_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const TILE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

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
