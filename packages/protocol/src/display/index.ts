/** 0.27.0 display protocol (DISPLAY-PROTOCOL-v0 §2–5). The throwing helpers stay inside the package. */
export * from "./catalog.js";
export { displayPath, type DisplayCheck, type DisplayError, type DisplayErrorCode } from "./errors.js";
export * from "./envelope.js";
export {
  blockRows,
  chartSpecSchema,
  gridCellSchema,
  gridColumnSchema,
  gridSpecSchema,
  kpiTileSchema,
  kpisSpecSchema,
  validateBlock,
  type BlockSpec,
  type ChartSpec,
  type GridCell,
  type GridColumn,
  type GridSpec,
  type KpiTile,
  type KpisSpec,
} from "./blocks.js";
export { fallbackInputSchema, type FallbackInput } from "./fallback.js";
export * from "./show.js";
export * from "./caps.js";
