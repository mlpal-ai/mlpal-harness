/**
 * 0.27.0 display protocol (DISPLAY-PROTOCOL-v0 §3.3): why the engine refused a display. The model reads the code with
 * a path and a hint as a tool error and repairs from it; metrics count it by code. A2UI's names are reused where they
 * overlap. Only the codes this engine produces are listed; patch and remove (BLOCK_NOT_FOUND, REVISION_CONFLICT,
 * PATCH_FAILED) and the other levels (LEVEL_NOT_SUPPORTED) arrive with the slices that add them.
 */
export type DisplayErrorCode =
  /** The fallback text is absent or blank. */
  | "FALLBACK_MISSING"
  /** The fallback text is over 8,000 characters. */
  | "FALLBACK_TOO_LONG"
  /** The fallback text is under 40 characters, only points at the block ("See the chart"), or, for a chart, kpis or
   *  grid, carries no number. A cheap heuristic, not a semantic check. */
  | "FALLBACK_UNINFORMATIVE"
  /** The kind is not in the catalog. */
  | "KIND_UNKNOWN"
  /** The kind is in the catalog but this run's client does not draw it. */
  | "KIND_NOT_ALLOWED"
  /** The kind is drawn by the host only (an approval); the model cannot emit it. */
  | "HOST_OWNED_KIND"
  /** The input or the spec does not match its schema; `path` and `hint` say where and how. */
  | "VALIDATION_FAILED"
  /** A URL appears in a chart spec (data, marks, encodings: anywhere). Only inline data is drawn. */
  | "URL_NOT_ALLOWED"
  /** An expression appears in a chart spec (`calculate`, an expression filter, a `test` string, `expr`, `signal`). */
  | "EXPRESSION_NOT_ALLOWED"
  /** The Show input is over 256 KiB of JSON. */
  | "SPEC_TOO_LARGE"
  /** Over the row or cell limit (chart 5,000 rows / 50,000 cells; grid 2,000 inline rows). */
  | "ROWS_OVER_LIMIT"
  /** Over 12 blocks in one turn, or 200 revisions of one block. */
  | "TOO_MANY_BLOCKS"
  /** A cited tool_use id is not in this session. */
  | "SOURCE_UNKNOWN"
  /** This block already failed twice this turn; the person sees its fallback. */
  | "RETRY_EXHAUSTED";

export interface DisplayError {
  code: DisplayErrorCode;
  /** Where, from the Show input's root: `spec.vl.layer[0].encoding.y`. Absent when the whole input is at fault. */
  path?: string;
  message: string;
  /** How to repair it, when there is something more specific to say than the message. */
  hint?: string;
}

export type DisplayCheck<T> = { ok: true; value: T } | { ok: false; error: DisplayError };

/** A path segment list as the error's dotted path: `["spec", "vl", "layer", 0]` → `spec.vl.layer[0]`. */
export function displayPath(segments: ReadonlyArray<string | number>): string {
  let out = "";
  for (const s of segments) out += typeof s === "number" ? `[${s}]` : out ? `.${s}` : s;
  return out;
}

/** Thrown inside a validator and turned into a DisplayCheck at its public edge, so a deep walk stops at the first
 *  fault without threading results through every level. Never escapes this package's functions. */
export class DisplayRefusal extends Error {
  constructor(readonly error: DisplayError) {
    super(error.message);
  }
}

export function fail(code: DisplayErrorCode, path: ReadonlyArray<string | number>, message: string, hint?: string): never {
  throw new DisplayRefusal({ code, ...(path.length ? { path: displayPath(path) } : {}), message, ...(hint ? { hint } : {}) });
}

/** Run a validator; its refusal becomes `{ok: false}`. Any other exception is a bug and propagates. */
export function checked<T>(run: () => T): DisplayCheck<T> {
  try {
    return { ok: true, value: run() };
  } catch (e) {
    if (e instanceof DisplayRefusal) return { ok: false, error: e.error };
    throw e;
  }
}
