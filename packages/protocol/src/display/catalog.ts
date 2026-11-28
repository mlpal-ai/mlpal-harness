/**
 * 0.26.8 display protocol: the catalog's names and the limits the engine enforces (DISPLAY-PROTOCOL-v0 §2.6, §5).
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

/** The media kinds (DISPLAY-PROTOCOL-v0.1-media §1): offered only to a client that names them in `kinds` and
 *  declares `media` (caps.ts), and only where the engine can read the workspace's files. */
/** Chart marks a client draws only by naming them in `run.display.marks` (a UI pinned before them refuses them). */
export const CHART_OPTIONAL_MARKS = ["arc"] as const;
export type ChartOptionalMark = (typeof CHART_OPTIONAL_MARKS)[number];
export const MEDIA_KINDS = ["image", "image_set", "audio", "video", "file"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export function isMediaKind(kind: string): kind is MediaKind {
  return (MEDIA_KINDS as readonly string[]).includes(kind);
}
/** Every kind Show takes. */
export type DisplayKind = BlockKind | MediaKind;

/** `^[a-z][a-z0-9-]{0,39}$`: chosen by the model, unique in the session; a later Show with the same id replaces it. */
export const BLOCK_ID = /^[a-z][a-z0-9-]{0,39}$/;

export const DISPLAY_LIMITS = {
  /** The Show input as compact UTF-8 JSON. */
  inputBytes: 256 * 1024,
  /** Nesting of the Show input (or a spec), its root at 0. */
  inputDepth: 32,
  /** Values in the Show input (or a spec): every object, array and scalar counts one. */
  inputNodes: 100_000,
  fallbackMinChars: 40,
  fallbackMaxChars: 8_000,
  /** Rows the engine appends to a fallback as a text table. */
  fallbackTableRows: 20,
  chartRows: 5_000,
  chartCells: 50_000,
  chartSeries: 12,
  /** Slices a pie or donut (an `arc` view) draws. */
  chartSlices: 12,
  chartLayers: 8,
  chartVconcat: 2,
  /** A window whose frame start is bounded: rows it runs on times frame span (an open end counts to the edge). */
  chartWindowRowsTimesSpan: 1_000_000,
  /** Over the whole chart: the sum, for every window transform, of rows it runs on times its ops, at most this. */
  chartWindowOpRows: 100_000,
  /** Point-like marks (point, tick, rule, text, rect, bar) a chart draws: rows x views that draw them. */
  chartMarks: 15_000,
  /** The estimated milliseconds a chart may cost to compile, run and draw (chartCost; well under a second). */
  chartCostBudgetMs: 400,
  /** Window ops that recompute over the whole frame for every row: allowed only with frame [null, null]. */
  chartWholeFrameOps: ["median", "q1", "q3", "distinct"],
  gridRows: 2_000,
  gridColumns: 40,
  kpiTiles: 8,
  blocksPerTurn: 12,
  revisionsPerBlock: 200,
  notes: 20,
  sources: 20,
  /** Faults one refusal lists (the rest are counted). */
  faults: 10,
  /** Media kinds: a file's bytes, an image's sides and pixels (from its header), images in a set, an alt text. */
  media: {
    imageBytes: 20 * 1024 * 1024,
    audioBytes: 100 * 1024 * 1024,
    videoBytes: 500 * 1024 * 1024,
    fileBytes: 500 * 1024 * 1024,
    posterBytes: 5 * 1024 * 1024,
    transcriptChars: 8_000,
    nameChars: 200,
    maxSide: 16_384,
    maxPixels: 40_000_000,
    setImages: 8,
    altChars: 300,
    pathChars: 4_096,
  },
} as const;
