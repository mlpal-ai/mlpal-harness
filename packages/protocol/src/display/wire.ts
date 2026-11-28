/**
 * The light half of the display protocol: what a client needs for every envelope on the wire (the envelope and
 * block schemas, the catalog, error types, capability parsing, settling). It never reaches the chart grammar or the
 * cost walker; those are validate.ts (subpath export "@mlpal/harness-protocol/validate"). A test holds the import
 * graph to that.
 */
export * from "./catalog.js";
export { arrived, asDisplayError, displayPath, type DisplayCheck, type DisplayError, type DisplayErrorCode } from "./errors.js";
export * from "./envelope.js";
export * from "./block-schemas.js";
export * from "./media-schemas.js";
export * from "./caps.js";
export { settleDisplays } from "./settle.js";
/** The character rule of every plain-text field a person reads (display titles, a HOP's home text): no C0/C1 control
 *  but tab and newline, no bidi mark, embedding, override or isolate, no zero-width space, no BOM. */
export { CONTROL } from "./fields.js";
