import { z } from "zod";
import { chartSpecSchema, gridSpecSchema, kpisSpecSchema } from "./block-schemas.js";
import { plainText as plain } from "./fields.js";
import { BLOCK_ID, DISPLAY_CATALOG, DISPLAY_LIMITS, type BlockKind } from "./catalog.js";

/**
 * 0.26.8 display protocol (DISPLAY-PROTOCOL-v0 §2): what an agent deliberately shows, as a render-only field on the
 * tool result that showed it (`ToolResultEvent.display`). Every envelope carries a complete text fallback, so a
 * client that draws nothing else still has the conclusion and the numbers. A client that did not ask for display
 * never receives one.
 *
 * This engine writes two levels: `block` (a typed block of catalog `harness.v1/1`, drawn by our components) and
 * `text` (the fallback alone: a block that failed validation is shown as its fallback while the model repairs it).
 * The `app`, `page` and `file` levels exist on the capability declaration only; their envelopes arrive with the
 * slices that write them.
 */

const NOTE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SLOT = /^[a-z][a-z0-9_-]{0,39}$/;

/** §2.3 Placement. `home` (describe-and-add, §11.4) arrives with the home slice. */
export const placementSchema = z
  .object({
    surface: z.enum(["thread", "canvas"]),
    slot: z.string().regex(SLOT).optional(),
    size: z.enum(["compact", "regular", "wide", "full"]).optional(),
  })
  .strict();
export type Placement = z.infer<typeof placementSchema>;

/** §8 a note the model writes on a block: where a number came from, what it assumed, what to be careful about.
 *  `memory` and `verifier` notes are the engine's and arrive with the slices that write them. */
export const noteInputSchema = z
  .object({
    id: z.string().regex(NOTE_ID),
    kind: z.enum(["source", "assumption", "caveat"]),
    text: plain(300),
    ref: z
      .object({
        /** A tool call id, only if the model has it verbatim. Never a gate: the engine keeps it when it names a call of
         *  this session (the note is then verified) and drops it otherwise. */
        tool_use_id: z.string().optional(),
        block_id: z.string().regex(BLOCK_ID).optional(),
        path: plain(300).optional(),
      })
      .strict()
      .optional(),
    as_of: z.string().datetime({ offset: true }).optional(),
    rows: z.number().int().nonnegative().optional(),
    query: plain(300).optional(),
  })
  .strict();
export type NoteInput = z.infer<typeof noteInputSchema>;

/** A note as the envelope carries it: `verified` is the engine's, true when its `ref` names a tool call or a block
 *  of this session (a path is not checked, so it carries none). */
export const noteSchema = noteInputSchema.extend({
  /** Only ids the engine checked are written, so a stored or wire envelope's id is bounded (review 5, O5). */
  ref: z
    .object({ tool_use_id: z.string().min(1).max(128).optional(), block_id: z.string().regex(BLOCK_ID).optional(), path: plain(300).optional() })
    .strict()
    .optional(),
  verified: z.boolean().optional(),
});
export type Note = z.infer<typeof noteSchema>;

/** §2.3 who made the block. This engine writes model blocks only; `engine`, `mcp` and `host` sources arrive with the
 *  slices that map tool results and draw host blocks. */
export const displaySourceSchema = z
  .object({
    by: z.enum(["model", "host"]),
    /** W3-1: what the host drew the block from, present exactly when `by` is `host`: `home`, a HOP's home script. */
    origin: z.literal("home").optional(),
    /** The tool calls of this session whose results the block shows (every one checked to exist). */
    tool_use_ids: z.array(z.string()).max(DISPLAY_LIMITS.sources).optional(),
    as_of: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((s) => (s.by === "host") === (s.origin !== undefined), { message: "origin is given exactly when by is host", path: ["origin"] });
export type DisplaySource = z.infer<typeof displaySourceSchema>;

/** Every other string of an envelope (title, caption, note text, cells, labels, chart data) is plain text: a client
 *  never entity-decodes it (review 5, O1); only the fallback is markdown. */

/** §2.5 the fallback as the envelope carries it, the engine's text table (when the model asked for one) already
 *  appended. Fallback text is markdown (CommonMark with tables). Clients render it with raw HTML disabled, load no images, and
 *  follow only http(s) and relative links. The engine stores it neutralised (HTML-significant characters
 *  entity-encoded, image syntax and link definitions defused), so a client that renders it with HTML enabled is still
 *  safe. A client that cannot render markdown shows it as it is, after decoding the entity codes. In detail:
 *  no `<` but as `&lt;`, no image syntax, no `]:` (so no reference definition), inline links only to http(s) or
 *  relative paths, table cells backslash-escaped, no control characters, and no character reference that decodes to
 *  one (its `&` stored as `&amp;`). */
export const fallbackSchema = z.object({ text: z.string().min(1) }).strict();
export type Fallback = z.infer<typeof fallbackSchema>;

const common = {
  v: z.literal(1),
  block_id: z.string().regex(BLOCK_ID),
  /** Engine-assigned: 1, then +1 for every envelope of this block in the session. A client keeps the highest. */
  revision: z.number().int().positive(),
  /** Patch and remove arrive with `get_block` (phase B). */
  op: z.literal("snapshot"),
  fallback: fallbackSchema,
  source: displaySourceSchema,
  title: plain(120).optional(),
  caption: plain(300).optional(),
  placement: placementSchema.optional(),
  notes: z.array(noteSchema).max(DISPLAY_LIMITS.notes).optional(),
};

/** The fallback alone. `repairing`: the block failed validation and the model has one repair; `fallback_only`: the
 *  repair failed (the engine writes it whenever a second attempt fails, on the last valid fallback or a plain
 *  sentence), and this text is what stays. A `repairing` envelope still the block's latest once its run has ended (the
 *  model never retried) is final: draw it as `fallback_only`. */
export const textDisplaySchema = z.object({ ...common, level: z.literal("text"), status: z.enum(["repairing", "fallback_only"]) }).strict();

const block = <K extends BlockKind, S extends z.ZodTypeAny>(kind: K, spec: S) =>
  z.object({ ...common, level: z.literal("block"), kind: z.literal(kind), catalog: z.literal(DISPLAY_CATALOG), spec, status: z.literal("ok") }).strict();

export const chartDisplaySchema = block("chart", chartSpecSchema);
export const kpisDisplaySchema = block("kpis", kpisSpecSchema);
export const gridDisplaySchema = block("grid", gridSpecSchema);

/** One display, discriminated by `level`, then (for `block`) by `kind`. Validate an incoming one with
 *  `displayEnvelopeSchema`; a block's spec is checked further by `validateBlock` (the allowlist zod cannot state). */
export const displayEnvelopeSchema = z.union([textDisplaySchema, chartDisplaySchema, kpisDisplaySchema, gridDisplaySchema]);
export type TextDisplay = z.infer<typeof textDisplaySchema>;
export type ChartDisplay = z.infer<typeof chartDisplaySchema>;
export type KpisDisplay = z.infer<typeof kpisDisplaySchema>;
export type GridDisplay = z.infer<typeof gridDisplaySchema>;
export type BlockDisplay = ChartDisplay | KpisDisplay | GridDisplay;
export type DisplayEnvelope = TextDisplay | BlockDisplay;
