import { BLOCK_KINDS, DISPLAY_CATALOG, DISPLAY_LIMITS, type BlockKind, type DisplayCaps } from "@mlpal/harness-protocol";

/**
 * What this engine shows a run's client (DISPLAY-PROTOCOL-v0 §4.2): the block kinds it draws. Only a client that
 * declares the `block` level and catalog `harness.v1/1`, and draws at least one of its kinds, gets a policy; any other
 * declaration (text only, the terminal's text and file, another catalog) is served exactly as a client that declared
 * nothing: no Show, no catalog in the prompt. The HOP's `ui:` narrowing and the hosting tier's policy join this with
 * their slices.
 */
export interface DisplayPolicy {
  client: DisplayCaps["client"];
  viewport: DisplayCaps["viewport"];
  /** The kinds Show may emit; never empty. */
  kinds: ReadonlySet<BlockKind>;
}

export function resolveDisplay(caps: DisplayCaps): DisplayPolicy | null {
  const kinds = new Set(BLOCK_KINDS.filter((k) => !caps.kinds || caps.kinds.includes(k)));
  if (!caps.levels.includes("block") || !caps.catalogs.includes(DISPLAY_CATALOG) || kinds.size === 0) return null;
  return { client: caps.client, viewport: caps.viewport, kinds };
}

const KIND_GRAMMAR: Record<BlockKind, string> = {
  chart:
    `- chart: spec {vl, series_order?}. vl is Vega-Lite 6 JSON with inline data only: data.values, rows of plain values, at most ${DISPLAY_LIMITS.chartRows} rows and ${DISPLAY_LIMITS.chartSeries} series. ` +
    "Marks: line, area, bar, point, rule, rect, text, tick, errorband, errorbar, boxplot. Channels: x, y, x2, y2, color, opacity, size, shape, strokeDash, text, tooltip, detail, order. " +
    `Compose with layer (at most ${DISPLAY_LIMITS.chartLayers}) or a top-level vconcat (at most ${DISPLAY_LIMITS.chartVconcat}). Transforms: filter with field predicates, aggregate, bin, timeUnit, window, fold, stack. ` +
    `A window with ${DISPLAY_LIMITS.chartWholeFrameOps.join(", ")} takes frame [null, null]; a bounded frame's rows x span is at most ${DISPLAY_LIMITS.chartWindowRowsTimesSpan.toLocaleString("en-US")}, and all windows of a chart at most ${DISPLAY_LIMITS.chartWindowOpRows.toLocaleString("en-US")} rows x ops. ` +
    `At most ${DISPLAY_LIMITS.chartMarks.toLocaleString("en-US")} points, ticks, rules, texts, rects or bars across all views (rows x views), and a chart's estimated drawing cost at most ${DISPLAY_LIMITS.chartCostBudgetMs} ms: aggregate rows or draw fewer layers when a chart is refused TOO_COSTLY. ` +
    "No URL anywhere, no calculate, no expression or test strings, no facet, repeat or concat; a selection is a param with select point or interval and no bind. " +
    "series_order lists the series names so their colours keep that order everywhere the block is drawn.",
  kpis:
    `- kpis: spec {tiles: [{id, label, value, format: number|integer|percent|currency|text, unit?, sub?, delta?: {value, label?, good?: up|down}, spark?: [numbers], status?: ok|warn|bad|neutral}]}, at most ${DISPLAY_LIMITS.kpiTiles} tiles. ` +
    "value is a number except for text; a percent is the percentage (94.2); currency names its ISO 4217 code in unit. The fallback gives one line per tile.",
  grid:
    `- grid: spec {columns: [{key, label, type: text|code|num|bar|state}], rows: [{<key>: value}], row_key}, at most ${DISPLAY_LIMITS.gridRows} rows. ` +
    "num and bar cells are numbers, state cells a status word; row_key names the column whose values identify rows, each unique.",
};

/** The system section a run gets when its client draws blocks: when to Show, the fallback's rules, and the grammar of
 *  the kinds this client draws. Stable for a given declaration, so the prompt cache holds across its runs (the phone
 *  hint makes it differ by viewport). */
export function displayInstructions(p: DisplayPolicy): string {
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
    "Name a block's sources in words in sources (which tool or data, and as of when; a tool call id only if you have it verbatim), and add notes for its assumptions and caveats. A refused Show returns a code with a path and a hint: " +
      "fix that and call Show again with the same block_id, once; the person sees your fallback meanwhile.",
    ...(p.viewport === "phone" ? ["", "This person is on a phone: prefer one series, at most four grid columns and short labels."] : []),
  ].join("\n");
}
