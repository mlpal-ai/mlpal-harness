import { z } from "zod";
import { checkBlockSpec } from "./blocks.js";
import type { BlockSpec } from "./block-schemas.js";
import { checkMediaSpec, mediaFallback, type MediaFactsMap } from "./media.js";
import type { MediaSpec } from "./media-schemas.js";
import { parseShape } from "./shape.js";
import { checkBounds } from "./bounds.js";
import { BLOCK_ID, BLOCK_KINDS, DISPLAY_LIMITS, HOST_OWNED_KINDS, isBlockKind, isMediaKind, MEDIA_KINDS, type DisplayKind } from "./catalog.js";
import { placementSchema, noteInputSchema, type NoteInput, type Placement } from "./envelope.js";
import { asDisplayError, attempt, collectFaults, fail, report, type DisplayError } from "./errors.js";
import { checkFallbackText, completeFallback, fallbackInputSchema, parseFallbackShape } from "./fallback.js";
import { plainText } from "./fields.js";

/**
 * 0.26.8 display protocol: the input of the engine's `Show` tool (DISPLAY-PROTOCOL-v0 §3.2) and its check. The model
 * calls Show to put one typed block in front of the person; the check runs before any client sees it, and every
 * refusal is a typed code with the path and a hint the model repairs from.
 *
 * This slice shows blocks (`snapshot` only): patch, remove and the app, page and file levels add fields later.
 */

const utf8 = new TextEncoder();

export const showInputSchema = z
  .object({
    block_id: z
      .string()
      .regex(BLOCK_ID)
      .describe("lowercase id for this block, unique in the session (fig-1, stock-by-dc); Show it again with the same id to replace it"),
    kind: z.enum(BLOCK_KINDS).describe("kpis: 2 to 6 headline numbers; grid: rows to scan or sort; chart: a trend or a comparison"),
    spec: z.unknown().describe("the block's spec, an object; your instructions give each kind's smallest one"),
    fallback: fallbackInputSchema.describe(
      "REQUIRED. text: the conclusion and the key numbers in plain markdown (40 to 8,000 characters, no HTML, images or code fences), all a person who cannot see the block reads. table: {from: \"rows\"} adds a grid's or chart's rows",
    ),
    title: plainText(120).optional(),
    caption: plainText(300).optional().describe("one line under the block: what the data is and how fresh"),
    sources: z
      .array(z.string())
      .max(DISPLAY_LIMITS.sources)
      .optional()
      .describe(
        "where the block's data came from, in words: which tool or data, and as of when (\"erp_query, inventory as of 27 Nov 06:00\"). Add a tool call id only if you have it verbatim. Never a reason to refuse: a source the engine can match to a call of this session is verified, the rest is shown unverified",
      ),
    as_of: z.string().datetime({ offset: true }).optional().describe("when the data was true, ISO 8601"),
    placement: placementSchema.optional().describe("where: the thread (default) or the canvas beside it"),
    notes: z.array(noteInputSchema).max(DISPLAY_LIMITS.notes).optional().describe("sources, assumptions and caveats, shown under the block"),
  })
  .strict();

/** A Show input that passed every check: its spec as drawn, its fallback complete. */
export interface ValidShow {
  block_id: string;
  kind: DisplayKind;
  spec: BlockSpec | MediaSpec;
  /** The model's text with the requested table appended. */
  fallback: string;
  title?: string;
  caption?: string;
  sources?: string[];
  as_of?: string;
  placement?: Placement;
  notes?: NoteInput[];
  /** What the check normalised instead of refusing (a table column left out, a row_key taken from row_id): one line
   *  each, for the model. */
  notices?: string[];
}

/** A refused Show. `errors` lists every fault found, in the input's order, so one repair can fix them all; `error`
 *  is the first (the primary, which counters count), `omitted` how many past DISPLAY_LIMITS.faults were not listed.
 *  `block_id` and `fallback` are present when they themselves passed, so the engine can show the fallback while the
 *  model repairs the rest. */
export type ShowCheck =
  | { ok: true; show: ValidShow }
  | { ok: false; error: DisplayError; errors: DisplayError[]; omitted?: number; block_id?: string; fallback?: string };

export interface ShowCheckOptions {
  /** The kinds this run's client draws; a catalog kind outside them is `KIND_NOT_ALLOWED`. Default: every kind. */
  kinds?: ReadonlySet<DisplayKind>;
  /** What the engine found at each path a media spec names (it probes them before the check; this never touches
   *  disk). Absent: every media path is MEDIA_NOT_FOUND. */
  media?: MediaFactsMap;
  /** The media types this client draws (`run.display.media.formats`). */
  formats?: ReadonlySet<string>;
  /** The optional chart marks this client draws (`run.display.marks`: arc); one outside them is KIND_NOT_ALLOWED. Default:
   *  every mark. */
  marks?: ReadonlySet<string>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Check a Show input, collecting every fault. Order: block_id (fatal), fallback, depth and size (fatal), kind, the
 *  other fields, the spec, the fallback's table. */
/** The Show input's other fields, checked on their own so their faults join the spec's. */
const otherFieldsSchema = showInputSchema.omit({ kind: true, spec: true, fallback: true });

export function checkShowInput(raw: unknown, opts: ShowCheckOptions = {}): ShowCheck {
  let blockId: string | undefined;
  let fallback: string | undefined;
  const r = collectFaults((): ValidShow | undefined => {
    if (!isObj(raw)) fail("VALIDATION_FAILED", [], "the Show input is an object");
    if (typeof raw.block_id !== "string" || !BLOCK_ID.test(raw.block_id)) fail("VALIDATION_FAILED", ["block_id"], "block_id is lowercase letters, digits and hyphens, starting with a letter, at most 40", 'for example "fig-1"');
    blockId = raw.block_id;
    // The fallback's check reads fixed fields only, so it is safe before the bounds; checking it first lets the
    // fallback be shown whatever is wrong with the rest.
    // A media block's fallback is the engine's (its lines name each file), so the model's text is optional and short
    // text is fine; a table is for rows, which media have none of.
    const media = typeof raw.kind === "string" && isMediaKind(raw.kind);
    const given = !media || (raw.fallback !== undefined && raw.fallback !== null);
    const shape = given ? attempt(() => parseFallbackShape(raw.fallback, ["fallback"])) : undefined;
    if (media && shape?.table) report("VALIDATION_FAILED", ["fallback", "table"], "a media block has no rows to tabulate", "describe what it shows in the text");
    const fb = shape ? attempt(() => checkFallbackText(shape, raw.kind, ["fallback"], { minChars: !media })) : undefined;
    fallback = fb?.text;
    // Fatal: nothing below may walk an unbounded input.
    checkBounds(raw, []);
    const bytes = utf8.encode(JSON.stringify(raw)).length;
    if (bytes > DISPLAY_LIMITS.inputBytes) fail("SPEC_TOO_LARGE", [], `${bytes} bytes; a Show input is at most ${DISPLAY_LIMITS.inputBytes}`, "aggregate the data, or show fewer rows and give the total in the fallback");
    const kind = attempt(() => checkKind(raw.kind, opts));
    if (kind && !Object.hasOwn(raw, "spec")) report("VALIDATION_FAILED", ["spec"], `a ${kind} block needs its spec`);
    const { kind: _k, spec: _s, fallback: _f, ...others } = raw;
    const input = attempt(() => parseShape(otherFieldsSchema, others, []));
    if (kind && isMediaKind(kind)) {
      const spec = Object.hasOwn(raw, "spec") ? attempt(() => checkMediaSpec(kind, raw.spec, ["spec"], { facts: opts.media ?? new Map(), ...(opts.formats ? { formats: opts.formats } : {}) })) : undefined;
      if ((given && !fb) || !input || !spec) return undefined;
      return withOptional(input, { block_id: input.block_id, kind, spec, fallback: mediaFallback(kind, spec, fb?.text) });
    }
    const spec = kind && Object.hasOwn(raw, "spec") ? attempt(() => checkBlockSpec(kind, raw.spec, ["spec"], opts.marks ? { marks: opts.marks } : {})) : undefined;
    // the table is checked against the rows even when the text itself was refused, so both faults come together
    const tabled = fb ?? shape;
    const complete = tabled && kind && spec ? attempt(() => completeFallback(tabled, kind, spec, ["fallback"])) : undefined;
    if (!fb || !input || !kind || !spec || complete === undefined) return undefined;
    return withOptional(input, { block_id: input.block_id, kind, spec, fallback: complete });
  });
  if (r.errors.length === 0 && r.value) return { ok: true, show: r.notices.length ? { ...r.value, notices: r.notices } : r.value };
  // A refusal, or (typed VALIDATION_INTERNAL) anything else the checks threw: never an exception for the caller.
  const errors = r.errors.length ? r.errors : [asDisplayError(new Error("no fault and no value"))];
  return { ok: false, error: errors[0]!, errors, ...(r.omitted ? { omitted: r.omitted } : {}), ...(blockId ? { block_id: blockId } : {}), ...(fallback ? { fallback } : {}) };
}

/** The optional fields the input carried, beside the required ones. */
function withOptional(input: z.infer<typeof otherFieldsSchema>, required: Pick<ValidShow, "block_id" | "kind" | "spec" | "fallback">): ValidShow {
  const { title, caption, sources, as_of, placement, notes } = input;
  const optional = { title, caption, sources, as_of, placement, notes };
  for (const k of Object.keys(optional) as Array<keyof typeof optional>) if (optional[k] === undefined) delete optional[k];
  return { ...required, ...optional };
}

function checkKind(kind: unknown, opts: ShowCheckOptions): DisplayKind {
  const known = [...BLOCK_KINDS, ...MEDIA_KINDS].join(", ");
  if (typeof kind !== "string") fail("VALIDATION_FAILED", ["kind"], "kind names the block kind", `kinds: ${known}`);
  if (HOST_OWNED_KINDS.has(kind)) fail("HOST_OWNED_KIND", ["kind"], `${kind} blocks are drawn by the host, never by Show`, kind === "approval" ? "call the tool that needs approval; the host asks the person" : undefined);
  if (!isBlockKind(kind) && !isMediaKind(kind)) fail("KIND_UNKNOWN", ["kind"], `"${kind}" is not a kind of this catalog`, `kinds: ${known}`);
  // a media kind is drawn only by a client that names it (absent `kinds` means the wave-1 kinds)
  const allowed = opts.kinds ? opts.kinds.has(kind) : isBlockKind(kind);
  if (!allowed) fail("KIND_NOT_ALLOWED", ["kind"], `this client does not draw ${kind} blocks`, `it draws: ${[...(opts.kinds ?? BLOCK_KINDS)].join(", ") || "none"}`);
  return kind;
}
