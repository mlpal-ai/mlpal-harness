/**
 * The heavy half of the display protocol: validating a block (the chart grammar, the cost walker) and a Show input.
 * Its own subpath export, "@mlpal/harness-protocol/validate", so a client that only reads envelopes does not bundle it;
 * the package root re-exports it too, for the engine and yodex.
 */
export { blockRows, validateBlock } from "./blocks.js";
export { fallbackInputSchema, type FallbackInput } from "./fallback.js";
export * from "./show.js";
export { chartCost, type ChartCostCheck } from "./cost.js";
