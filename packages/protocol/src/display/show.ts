import { z } from "zod";
import { checkBlockSpec, parseShape, type BlockSpec } from "./blocks.js";
import { checkBounds } from "./bounds.js";
import { BLOCK_ID, BLOCK_KINDS, DISPLAY_LIMITS, HOST_OWNED_KINDS, isBlockKind, type BlockKind } from "./catalog.js";
import { placementSchema, noteInputSchema, type NoteInput, type Placement } from "./envelope.js";
import { asDisplayError, fail, type DisplayError } from "./errors.js";
import { checkFallbackInput, completeFallback, fallbackInputSchema } from "./fallback.js";
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
    kind: z.enum(BLOCK_KINDS).describe("the block kind; your instructions list the kinds this client draws and each kind's spec"),
    spec: z.unknown().describe("the block's spec, as the kind's grammar in your instructions says"),
    fallback: fallbackInputSchema.describe(
      "REQUIRED. text: what a person who cannot see the block reads (terminal, e-mail, screen reader): the conclusion and the key numbers in plain markdown, 40 to 8,000 characters, no HTML, images or code fences. table: {from: \"rows\"} appends the block's rows as a text table (at most 20)",
    ),
    title: plainText(120).optional(),
    caption: plainText(300).optional().describe("one line under the block: what the data is and how fresh"),
    sources: z.array(z.string().min(1).max(128)).max(DISPLAY_LIMITS.sources).optional().describe("ids of this session's tool calls whose results the block shows"),
    as_of: z.string().datetime({ offset: true }).optional().describe("when the data was true, ISO 8601"),
    placement: placementSchema.optional().describe("where: the thread (default) or the canvas beside it"),
    notes: z.array(noteInputSchema).max(DISPLAY_LIMITS.notes).optional().describe("sources, assumptions and caveats, shown under the block"),
  })
  .strict();

/** A Show input that passed every check: its spec as drawn, its fallback complete. */
export interface ValidShow {
  block_id: string;
  kind: BlockKind;
  spec: BlockSpec;
  /** The model's text with the requested table appended. */
  fallback: string;
  title?: string;
  caption?: string;
  sources?: string[];
  as_of?: string;
  placement?: Placement;
  notes?: NoteInput[];
}

/** A refused Show. `block_id` and `fallback` are present when they themselves passed, so the engine can show the
 *  fallback while the model repairs the rest. */
export type ShowCheck = { ok: true; show: ValidShow } | { ok: false; error: DisplayError; block_id?: string; fallback?: string };

export interface ShowCheckOptions {
  /** The kinds this run's client draws; a catalog kind outside them is `KIND_NOT_ALLOWED`. Default: every kind. */
  kinds?: ReadonlySet<BlockKind>;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Check a Show input. Order: block_id, fallback, depth and size, kind, the other fields, the spec, the fallback's
 *  table; the first fault wins. */
export function checkShowInput(raw: unknown, opts: ShowCheckOptions = {}): ShowCheck {
  let blockId: string | undefined;
  let fallback: string | undefined;
  try {
    if (!isObj(raw)) fail("VALIDATION_FAILED", [], "the Show input is an object");
    if (typeof raw.block_id !== "string" || !BLOCK_ID.test(raw.block_id)) fail("VALIDATION_FAILED", ["block_id"], "block_id is lowercase letters, digits and hyphens, starting with a letter, at most 40", 'for example "fig-1"');
    blockId = raw.block_id;
    // The fallback's check reads fixed fields only, so it is safe before the bounds; checking it first lets the
    // fallback be shown whatever is wrong with the rest.
    const fb = checkFallbackInput(raw.fallback, raw.kind, ["fallback"]);
    fallback = fb.text;
    checkBounds(raw, []);
    const bytes = utf8.encode(JSON.stringify(raw)).length;
    if (bytes > DISPLAY_LIMITS.inputBytes) fail("SPEC_TOO_LARGE", [], `${bytes} bytes; a Show input is at most ${DISPLAY_LIMITS.inputBytes}`, "aggregate the data, or show fewer rows and give the total in the fallback");
    const kind = raw.kind;
    if (typeof kind !== "string") fail("VALIDATION_FAILED", ["kind"], "kind names the block kind", `kinds: ${BLOCK_KINDS.join(", ")}`);
    if (HOST_OWNED_KINDS.has(kind)) fail("HOST_OWNED_KIND", ["kind"], `${kind} blocks are drawn by the host, never by Show`, kind === "approval" ? "call the tool that needs approval; the host asks the person" : undefined);
    if (!isBlockKind(kind)) fail("KIND_UNKNOWN", ["kind"], `"${kind}" is not a kind of this catalog`, `kinds: ${BLOCK_KINDS.join(", ")}`);
    if (opts.kinds && !opts.kinds.has(kind)) fail("KIND_NOT_ALLOWED", ["kind"], `this client does not draw ${kind} blocks`, `it draws: ${[...opts.kinds].join(", ") || "none"}`);
    if (!Object.hasOwn(raw, "spec")) fail("VALIDATION_FAILED", ["spec"], `a ${kind} block needs its spec`);
    const input = parseShape(showInputSchema, { ...raw, fallback: fb }, []);
    const spec = checkBlockSpec(kind, input.spec, ["spec"]);
    const complete = completeFallback(fb, kind, spec, ["fallback"]);
    const { block_id, title, caption, sources, as_of, placement, notes } = input;
    const optional = { title, caption, sources, as_of, placement, notes };
    for (const k of Object.keys(optional) as Array<keyof typeof optional>) if (optional[k] === undefined) delete optional[k];
    return { ok: true, show: { block_id, kind, spec, fallback: complete, ...optional } };
  } catch (e) {
    // A refusal, or (typed VALIDATION_INTERNAL) anything else the checks threw: never an exception for the caller.
    return { ok: false, error: asDisplayError(e), ...(blockId ? { block_id: blockId } : {}), ...(fallback ? { fallback } : {}) };
  }
}
