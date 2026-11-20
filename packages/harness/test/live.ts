import { test } from "bun:test";

/**
 * Tests that call the real gateway run only when asked: `YODEX_LIVE_TESTS=1` and a `YODEX_API_KEY`. A key alone is
 * not consent, since an operator's shell often has one (E-27: a plain `bun test` spent on the operator's key).
 */
export const liveTest = process.env.YODEX_LIVE_TESTS === "1" && process.env.YODEX_API_KEY ? test : test.skip;
