/**
 * 0.27.0 display protocol: the catalog's names and the limits the engine enforces (DISPLAY-PROTOCOL-v0 §2.6, §5).
 */

/** Every level a client may declare (§2.4). This engine writes `text` and `block`. */
export const DISPLAY_LEVELS = ["text", "block", "app", "page", "file"] as const;
export type DisplayLevel = (typeof DISPLAY_LEVELS)[number];

/** The catalog version this engine validates against. */
export const DISPLAY_CATALOG = "harness.v1/1";

/** The block kinds of `harness.v1/1` this engine validates (wave 1, §5.1; `log` and `files` follow). */
export const BLOCK_KINDS = ["chart", "kpis", "grid"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** Kinds only the host draws (§7.2); the model emitting one is refused `HOST_OWNED_KIND`. */
export const HOST_OWNED_KINDS: ReadonlySet<string> = new Set(["approval"]);

export function isBlockKind(kind: string): kind is BlockKind {
  return (BLOCK_KINDS as readonly string[]).includes(kind);
}

/** `^[a-z][a-z0-9-]{0,39}$`: chosen by the model, unique in the session; a later Show with the same id replaces it. */
export const BLOCK_ID = /^[a-z][a-z0-9-]{0,39}$/;

export const DISPLAY_LIMITS = {
  /** The Show input as compact UTF-8 JSON. */
  inputBytes: 256 * 1024,
  fallbackMinChars: 40,
  fallbackMaxChars: 8_000,
  /** Rows the engine appends to a fallback as a text table. */
  fallbackTableRows: 20,
  chartRows: 5_000,
  chartCells: 50_000,
  chartSeries: 12,
  chartLayers: 8,
  chartVconcat: 2,
  gridRows: 2_000,
  gridColumns: 40,
  kpiTiles: 8,
  blocksPerTurn: 12,
  revisionsPerBlock: 200,
  notes: 20,
  sources: 20,
} as const;
