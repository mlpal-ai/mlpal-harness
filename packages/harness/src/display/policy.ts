import { BLOCK_KINDS, DISPLAY_CATALOG, DISPLAY_LIMITS, type BlockKind, type DisplayCaps } from "@mlpal/harness-protocol";

/**
 * What this engine shows a run's client (DISPLAY-PROTOCOL-v0 §4.2): the levels it writes that the client declared,
 * and the kinds. A client that declares `block` but not catalog `harness.v1/1`, or none of its kinds, is a text
 * client here. The HOP's `ui:` narrowing and the hosting tier's policy join this with their slices.
 */
export interface DisplayPolicy {
  client: DisplayCaps["client"];
  viewport: DisplayCaps["viewport"];
  /** `text` always; `block` when blocks are drawn. */
  levels: ReadonlySet<"text" | "block">;
  /** The kinds Show may emit; empty for a text client. */
  kinds: ReadonlySet<BlockKind>;
}

export function resolveDisplay(caps: DisplayCaps): DisplayPolicy {
  const kinds = new Set(BLOCK_KINDS.filter((k) => !caps.kinds || caps.kinds.includes(k)));
  const blocks = caps.levels.includes("block") && caps.catalogs.includes(DISPLAY_CATALOG) && kinds.size > 0;
  return {
    client: caps.client,
    viewport: caps.viewport,
    levels: new Set(blocks ? ["text", "block"] : ["text"]),
    kinds: blocks ? kinds : new Set(),
  };
}

export const drawsBlocks = (p: DisplayPolicy): boolean => p.levels.has("block");

const KIND_GRAMMAR: Record<BlockKind, string> = {
  chart:
    `- chart: spec {vl, series_order?}. vl is Vega-Lite 6 JSON with inline data only: data.values, rows of plain values, at most ${DISPLAY_LIMITS.chartRows} rows and ${DISPLAY_LIMITS.chartSeries} series. ` +
    "Marks: line, area, bar, point, rule, rect, text, tick, errorband, errorbar, boxplot. Channels: x, y, x2, y2, color, opacity, size, shape, strokeDash, text, tooltip, detail, order. " +
    `Compose with layer (at most ${DISPLAY_LIMITS.chartLayers}) or a top-level vconcat (at most ${DISPLAY_LIMITS.chartVconcat}). Transforms: filter with field predicates, aggregate, bin, timeUnit, window, fold, stack. ` +
    "No URL anywhere, no calculate, no expression or test strings, no facet, repeat or concat; a selection is a param with select point or interval and no bind. " +
    "series_order lists the series names so their colours keep that order everywhere the block is drawn.",
  kpis:
    `- kpis: spec {tiles: [{id, label, value, format: number|integer|percent|currency|text, unit?, sub?, delta?: {value, label?, good?: up|down}, spark?: [numbers], status?: ok|warn|bad|neutral}]}, at most ${DISPLAY_LIMITS.kpiTiles} tiles. ` +
    "value is a number except for text; a percent is the percentage (94.2); currency names its ISO 4217 code in unit. The fallback gives one line per tile.",
  grid:
    `- grid: spec {columns: [{key, label, type: text|code|num|bar|state}], rows: [{<key>: value}], row_key}, at most ${DISPLAY_LIMITS.gridRows} rows. ` +
    "num and bar cells are numbers, state cells a status word; row_key names the column whose values identify rows, each unique.",
};

/** The system section a run gets when its client draws blocks (null otherwise): when to Show, the fallback's rules,
 *  and the grammar of the kinds this client draws. Stable for a given client, so the prompt cache holds across its
 *  runs. */
export function displayInstructions(p: DisplayPolicy): string | null {
  if (!drawsBlocks(p)) return null;
  return [
    "# Showing results",
    "",
    "This person's client draws typed blocks. When a chart, a table or a few headline numbers make the answer clearer than prose, call Show; otherwise answer in prose. " +
      "Each Show is one block, and a later Show with the same block_id replaces it. Still say the conclusion in your reply: the block supports it.",
    "",
    "Every Show needs fallback.text: what a person who cannot see the block reads (a terminal, an e-mail, a screen reader). State the conclusion and the key numbers " +
      `in ${DISPLAY_LIMITS.fallbackMinChars} to ${DISPLAY_LIMITS.fallbackMaxChars} characters of plain markdown, never "see the chart". fallback.table {from: "rows"} appends the block's rows (at most ${DISPLAY_LIMITS.fallbackTableRows}).`,
    "",
    "Kinds this client draws:",
    ...[...p.kinds].map((k) => KIND_GRAMMAR[k]),
    "",
    "Put the ids of the tool calls a block shows in sources, and add notes for its sources, assumptions and caveats. A refused Show returns a code with a path and a hint: " +
      "fix that and call Show again with the same block_id, once; the person sees your fallback meanwhile.",
    ...(p.viewport === "phone" ? ["", "This person is on a phone: prefer one series, at most four grid columns and short labels."] : []),
  ].join("\n");
}
