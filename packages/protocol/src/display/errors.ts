import { DISPLAY_LIMITS } from "./catalog.js";
import { CONTROL_ALL, defuseReferences } from "./fields.js";

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
  | "RETRY_EXHAUSTED"
  /** The check itself failed on this input (a bug in the validator, never the model's fault). Typed so that no input
   *  can surface as an untyped error: the fallback is shown and the repair counted like any refusal. */
  | "VALIDATION_INTERNAL";

export interface DisplayError {
  code: DisplayErrorCode;
  /** Where, from the Show input's root: `spec.vl.layer[0].encoding.y`. Absent when the whole input is at fault. */
  path?: string;
  message: string;
  /** How to repair it, when there is something more specific to say than the message. */
  hint?: string;
}

/** A refusal lists every fault found, in the input's order, so one repair can fix them all: `error` is the first (the
 *  primary, which counters count), `errors` all of them up to DISPLAY_LIMITS.faults, `omitted` how many more. */
export type DisplayCheck<T> = { ok: true; value: T } | { ok: false; error: DisplayError; errors: DisplayError[]; omitted?: number };

/** A path segment list as the error's dotted path: `["spec", "vl", "layer", 0]` → `spec.vl.layer[0]`. */
export function displayPath(segments: ReadonlyArray<string | number>): string {
  let out = "";
  for (const s of segments) out += typeof s === "number" ? `[${s}]` : out ? `.${s}` : s;
  return out;
}

/** Thrown inside a validator and turned into a DisplayCheck at its public edge, so a check stops at a fault without
 *  threading results through every level. Carries one fault, or several (zod's issues). Never escapes this package's
 *  functions. */
export class DisplayRefusal extends Error {
  constructor(readonly errors: DisplayError[]) {
    super(errors[0]!.message);
  }

  get error(): DisplayError {
    return this.errors[0]!;
  }
}

/** The faults of one check, in the order found. The first at a path is kept, so two checks of one key (a name scan and
 *  the allowlist) report it once. */
class Faults {
  readonly list: DisplayError[] = [];
  total = 0;
  private readonly paths = new Set<string>();

  add(e: DisplayError): void {
    const at = e.path ?? "";
    if (this.paths.has(at)) return;
    this.paths.add(at);
    this.total++;
    if (this.list.length < DISPLAY_LIMITS.faults) this.list.push(e);
  }
}

/** The faults of the check running now (checks are synchronous; collectFaults scopes it and restores the outer one). */
let current: Faults | null = null;

/** Run an independent part of a check: inside collectFaults its refusal is recorded and the check goes on with the
 *  part's siblings (the part's value is then undefined); outside, the refusal propagates. */
export function attempt<T>(run: () => T): T | undefined {
  if (!current) return run();
  try {
    return run();
  } catch (e) {
    if (!(e instanceof DisplayRefusal)) throw e;
    for (const x of e.errors) current.add(x);
    return undefined;
  }
}

/** How many faults the running check has collected so far (0 outside one): lets a part tell whether a rule it ran
 *  reported something before it acts on that rule's input. */
export function collectedNow(): number {
  return current?.total ?? 0;
}

/** Report a fault and go on, inside collectFaults; outside, it is a refusal like fail. */
export function report(code: DisplayErrorCode, path: ReadonlyArray<string | number>, message: string, hint?: string): void {
  attempt(() => fail(code, path, message, hint));
}

/** Run a whole check, collecting every fault its parts report. A fault the parts do not catch ends the check (it is
 *  fatal for what follows); anything else thrown is VALIDATION_INTERNAL. */
export function collectFaults<T>(run: () => T): { value: T | undefined; errors: DisplayError[]; omitted: number } {
  const outer = current;
  const faults = new Faults();
  current = faults;
  let value: T | undefined;
  try {
    value = run();
  } catch (e) {
    if (e instanceof DisplayRefusal) for (const x of e.errors) faults.add(x);
    else faults.add(asDisplayError(e));
  } finally {
    current = outer;
  }
  return { value: faults.total ? undefined : value, errors: faults.list, omitted: faults.total - faults.list.length };
}

/** An error's text quotes names the model chose (keys, fields, kinds), and the step's content shows it: made inert
 *  for any client that renders it as markdown or prints it to a terminal. No control character, no image or link
 *  syntax, no HTML or code span, no autolink; at most 300 characters. */
export function inert(s: string): string {
  const flat = defuseReferences(s)
    .replace(CONTROL_ALL, " ")
    .replace(/!\[/g, "!?")
    .replace(/\]\(/g, "]?")
    .replace(/\]:/g, "]?")
    .replace(/[<>`]/g, "?")
    .replace(/:\/\//g, ":?/")
    .replace(/www\./gi, "www?");
  return [...flat].length > 300 ? `${[...flat].slice(0, 299).join("")}…` : flat;
}

export function displayError(code: DisplayErrorCode, path: ReadonlyArray<string | number>, message: string, hint?: string): DisplayError {
  return { code, ...(path.length ? { path: inert(displayPath(path)) } : {}), message: inert(message), ...(hint ? { hint: inert(hint) } : {}) };
}

export function fail(code: DisplayErrorCode, path: ReadonlyArray<string | number>, message: string, hint?: string): never {
  throw new DisplayRefusal([displayError(code, path, message, hint)]);
}

/** Any exception as a DisplayError: a refusal as itself, anything else (a validator bug) as VALIDATION_INTERNAL,
 *  naming only the exception's class, never its message (which may quote the input). */
export function asDisplayError(e: unknown): DisplayError {
  if (e instanceof DisplayRefusal) return e.error;
  const name = e instanceof Error ? e.name : typeof e;
  return { code: "VALIDATION_INTERNAL", message: inert(`the check failed unexpectedly (${name}); this is not your input's fault as far as the check can tell`), hint: "show the same content another way, or answer in prose" };
}

/** Run a validator, collecting its faults; whatever it throws becomes `{ok: false}` with typed codes, so no input
 *  makes a caller throw. */
export function checked<T>(run: () => T): DisplayCheck<T> {
  const r = collectFaults(run);
  if (r.errors.length === 0) return { ok: true, value: r.value as T };
  return { ok: false, error: r.errors[0]!, errors: r.errors, ...(r.omitted ? { omitted: r.omitted } : {}) };
}
