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

/** The smallest valid spec of each kind, shown to the model (a test holds each to validateBlock). */
export const KIND_EXAMPLES: Record<BlockKind, unknown> = {
  kpis: { tiles: [{ id: "cover", label: "Weeks of cover", value: 5.2, format: "number" }, { id: "fill", label: "Fill rate", value: 94.2, format: "percent" }] },
  grid: { columns: [{ key: "dc", label: "DC", type: "text" }, { key: "units", label: "Units", type: "num" }], rows: [{ dc: "Reno", units: 3400 }], row_key: "dc" },
  chart: { vl: { data: { values: [{ week: "2026-11-30", units: 2140 }] }, mark: "line", encoding: { x: { field: "week", type: "temporal" }, y: { field: "units", type: "quantitative" } } } },
};

/** When to pick each kind: the first thing the model reads about it. */
const KIND_WHEN: Record<BlockKind, string> = {
  kpis: "2 to 6 headline numbers",
  grid: "rows the person will scan or sort",
  chart: "a trend or a comparison",
};

const KIND_RULES: Record<BlockKind, string> = {
  kpis:
    "kpis: format number|integer|percent|currency|text (value is a number unless text; a percent is 94.2 for 94.2 %; currency puts its ISO code in unit); " +
    `optional sub, delta {value, good: up|down}, spark [numbers], status ok|warn|bad|neutral; at most ${DISPLAY_LIMITS.kpiTiles} tiles.`,
  grid: `grid: column type text|code|num|bar|state; row_key is the column whose values are unique; at most ${DISPLAY_LIMITS.gridRows.toLocaleString("en-US")} rows.`,
  chart:
    `chart: Vega-Lite 6 with inline data.values only (at most ${DISPLAY_LIMITS.chartRows.toLocaleString("en-US")} rows, ${DISPLAY_LIMITS.chartCells.toLocaleString("en-US")} cells, ${DISPLAY_LIMITS.chartSeries} series; the whole input at most ${DISPLAY_LIMITS.inputBytes / 1024} KiB). Marks line, area, bar, point, rule, rect, text, tick, errorband, errorbar, boxplot; ` +
    `layer (at most ${DISPLAY_LIMITS.chartLayers}) or a top-level vconcat (${DISPLAY_LIMITS.chartVconcat}); transforms filter (field predicates), aggregate, bin, timeUnit, window, fold, stack. ` +
    "No URL, calculate, expression, facet or concat. No ci0, ci1 or extent \"ci\": compute an interval upstream and draw its low and high fields (errorband with y and y2). " +
    'Sort by a channel ("-y") or {field, order}, never an op; a condition sets a value, never a field. series_order keeps series colours in that order. ' +
    `Cost: ${DISPLAY_LIMITS.chartWholeFrameOps.join(", ")} windows only with frame [null, null]; at most ${DISPLAY_LIMITS.chartMarks.toLocaleString("en-US")} marks across views (every point, bar, tick, rule, rect and text counts); ` +
    `an estimated draw of at most ${DISPLAY_LIMITS.chartCostBudgetMs} ms (TOO_COSTLY: aggregate or draw fewer layers).`,
};

/** Kinds in the order the model should consider them. */
const ORDER: BlockKind[] = ["kpis", "grid", "chart"];

/** The system section a run gets when its client draws blocks: how to choose a kind, the smallest spec of each, the
 *  fallback's rules and the grammar of the kinds this client draws. Stable for a given declaration, so the prompt
 *  cache holds across its runs (the phone hint makes it differ by viewport). */
export function displayInstructions(p: DisplayPolicy): string {
  const kinds = ORDER.filter((k) => p.kinds.has(k));
  return [
    "# Showing results",
    "",
    "This person's client draws blocks. Write the answer's sentence first; then call Show when a block makes it clearer, and do not repeat the block's table in prose.",
    "Pick the kind, smallest spec shown:",
    ...kinds.map((k) => `- ${k}: ${KIND_WHEN[k]}. ${JSON.stringify(KIND_EXAMPLES[k])}`),
    "",
    `Every Show: block_id, kind, spec, and fallback.text: the conclusion and the key numbers in ${DISPLAY_LIMITS.fallbackMinChars} to ${DISPLAY_LIMITS.fallbackMaxChars.toLocaleString("en-US")} characters of markdown, ` +
      `never "see the chart" (fallback.table {"from": "rows"} adds a grid's or chart's rows). Name sources in words: which tool or data, as of when.`,
    ...kinds.map((k) => KIND_RULES[k]),
    "A refusal lists every fault with a path and a hint: fix them all and call Show again with the same block_id, once.",
    ...(p.viewport === "phone" ? ["This person is on a phone: prefer one series, at most four grid columns and short labels."] : []),
  ].join("\n");
}
