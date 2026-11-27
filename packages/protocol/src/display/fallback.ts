import { z } from "zod";
import { blockRows, parseShape, type BlockSpec, type GridSpec } from "./blocks.js";
import { DISPLAY_LIMITS, isBlockKind, type BlockKind } from "./catalog.js";
import { attempt, fail, notice } from "./errors.js";
import { CONTROL, CONTROL_ALL, defuseReferences } from "./fields.js";

/**
 * 0.26.8 display protocol: the text every display carries (DISPLAY-PROTOCOL-v0 §2.5). It is what a terminal, an
 * e-mail, a screen reader and a pinned UI show, so it must stand alone: the conclusion and the key numbers. The checks
 * are cheap heuristics, not a semantic judgement.
 *
 * Fallback text is markdown (CommonMark with tables). Clients render it with raw HTML disabled, load no images, and
 * follow only http(s) and relative links. The engine stores it neutralised (HTML-significant characters
 * entity-encoded, image syntax and link definitions defused), so a client that renders it with HTML enabled is still
 * safe. A client that cannot render markdown shows it as it is, after decoding the entity codes.
 */

/** What the model writes. `table: {from: "rows"}` asks the engine to append the block's rows as a text table. */
export const fallbackInputSchema = z
  .object({
    text: z.string(),
    table: z
      .object({
        from: z.literal("rows"),
        columns: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
        max_rows: z.number().int().min(1).max(DISPLAY_LIMITS.fallbackTableRows).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FallbackInput = z.infer<typeof fallbackInputSchema>;

type Path = ReadonlyArray<string | number>;

const REFERENCE_ONLY = /^(see|shown|as shown)\b/i;
/** Anything that could open HTML: a tag (whatever follows its name), a closing tag, a comment, CDATA, a processing
 *  instruction, an autolink. */
const HTML = /<[A-Za-z!/?]/;
/** Any image: inline, reference, collapsed or shortcut. */
const IMAGE = /!\[/;
const FENCE = /^\s*(```|~~~)/m;
/** A link destination that may stay a link: http(s), or a relative path with no scheme, no entity and no leading `//`
 *  (protocol-relative is another host). */
const SAFE_DEST = /^(?:<?https?:\/\/|(?!\/\/)[A-Za-z0-9._~/#?=%+-]*(?:[)\s>]|$))/i;
const INLINE_LINK = /\]\(\s*/g;
/** A link reference definition is `]:` after its label, wherever the label starts (a block quote, a list item, a label
 *  with an escaped bracket or a line ending). No fallback needs one, so the sequence itself is refused and rewritten:
 *  definitions are never parsed. */
const DEFINITION = /\]:/;

function unsafeLinks(text: string): boolean {
  for (const m of text.matchAll(INLINE_LINK)) if (!SAFE_DEST.test(text.slice(m.index! + m[0].length))) return true;
  return false;
}

/**
 * The fallback as stored and sent: inert in a markdown renderer by construction, whatever the checks above miss.
 * Every `<` becomes `&lt;` (so nothing opens a tag or an autolink, whatever follows), every `![` starts with `&#33;`
 * (so no image, of any form), every `]:` becomes `]&#58;` (so no reference definition, however written), and an inline
 * link whose destination is not http(s) or a relative path loses its link syntax. First, a character reference the
 * model wrote that would decode to a control character is defused (defuseReferences). Entities, not backslashes: a
 * backslash the model wrote before them cannot undo them. A client that cannot render markdown decodes the entity codes
 * before showing the text.
 */
export function inertFallbackText(text: string): string {
  const out = defuseReferences(text).replace(/</g, "&lt;").replace(/!\[/g, "&#33;[").replace(/\]:/g, "]&#58;");
  return out.replace(INLINE_LINK, (m, offset: number, all: string) => (SAFE_DEST.test(all.slice(offset + m.length)) ? m : `]&#40;${m.slice(2)}`));
}

/** The fallback as the model sent it, checked. A bare string is taken as its text (models flatten small objects).
 *  `kind`, when it is a block kind, adds the rule that a chart, kpis or grid fallback states a number. */
export function checkFallbackInput(raw: unknown, kind: unknown, path: Path): FallbackInput {
  return checkFallbackText(parseFallbackShape(raw, path), kind, path);
}

/** The fallback's shape: present, with text, its table well formed. Checked apart from the text's rules, so a table
 *  fault and a text fault are reported together. */
export function parseFallbackShape(raw: unknown, path: Path): FallbackInput {
  if (raw === undefined || raw === null) fail("FALLBACK_MISSING", path, "every Show needs a fallback", '"fallback": { "text": "the conclusion and the key numbers" }');
  let obj = typeof raw === "string" ? { text: raw } : raw;
  // `table: null` is no table (a missing optional, sent as null)
  if (typeof obj === "object" && obj !== null && !Array.isArray(obj) && Object.hasOwn(obj, "table") && (obj as { table?: unknown }).table === null) {
    const { table: _none, ...rest } = obj as Record<string, unknown>;
    obj = rest;
  }
  if (typeof obj === "object" && !Array.isArray(obj) && (obj as { text?: unknown }).text === undefined) fail("FALLBACK_MISSING", [...path, "text"], "the fallback has no text", '"fallback": { "text": "the conclusion and the key numbers" }');
  // the table is parsed on its own, so a table fault does not hide the text's faults
  const o = typeof obj === "object" && obj !== null && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  if (o && Object.hasOwn(o, "table")) {
    const table = attempt(() => parseShape(fallbackInputSchema.shape.table, o.table, [...path, "table"]));
    const { table: _t, ...rest } = o;
    const base = parseShape(fallbackInputSchema, rest, path);
    return table ? { ...base, table } : base;
  }
  return parseShape(fallbackInputSchema, obj, path);
}

/** The fallback text's rules, on a well-formed fallback; the text comes back trimmed and neutralised. */
export function checkFallbackText(input: FallbackInput, kind: unknown, path: Path): FallbackInput {
  const text = input.text.trim();
  const at = [...path, "text"];
  if (!text) fail("FALLBACK_MISSING", at, "the fallback text is empty", "state the conclusion and the key numbers");
  const chars = [...text].length;
  if (chars > DISPLAY_LIMITS.fallbackMaxChars) fail("FALLBACK_TOO_LONG", at, `${chars} characters; a fallback is at most ${DISPLAY_LIMITS.fallbackMaxChars}`, "keep the conclusion and key numbers; ask for a table with fallback.table instead of writing one");
  if (chars < DISPLAY_LIMITS.fallbackMinChars) fail("FALLBACK_UNINFORMATIVE", at, `${chars} characters; a fallback is at least ${DISPLAY_LIMITS.fallbackMinChars}`, "a person who cannot see the block reads only this: state the conclusion and the key numbers");
  if (REFERENCE_ONLY.test(text)) fail("FALLBACK_UNINFORMATIVE", at, "the fallback only points at the block", "say what the block shows, not where to look");
  if (typeof kind === "string" && isBlockKind(kind) && !/\d/.test(text)) fail("FALLBACK_UNINFORMATIVE", at, `a ${kind} fallback states at least one number`, "give the key numbers the block shows");
  if (HTML.test(text)) fail("VALIDATION_FAILED", at, "the fallback is plain markdown: no HTML, no autolinks", 'write "less than" for a bare <, and links as [text](https://...)');
  if (IMAGE.test(text)) fail("VALIDATION_FAILED", at, "the fallback is plain markdown: no images", "describe what the image would show");
  if (FENCE.test(text)) fail("VALIDATION_FAILED", at, "the fallback is plain markdown: no code fences");
  if (CONTROL.test(text)) fail("VALIDATION_FAILED", at, "the fallback has a control character (a terminal escape)", "write plain text; tabs and newlines are fine");
  if (DEFINITION.test(text)) fail("VALIDATION_FAILED", at, "the fallback has a link reference definition (]:)", "write links inline: [text](https://...)");
  if (unsafeLinks(text)) fail("VALIDATION_FAILED", at, "a link in the fallback goes to http(s) or a relative path only", "drop the link or use its https address");
  return { ...input, text: inertFallbackText(text) };
}

const ANSI = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|.)/g;
const CELL_CHARS = 120;

/** A value as an inert GFM table cell. The checks already refuse control characters in cells; the engine still
 *  strips them here, since this text reaches terminals and markdown renderers whatever the checks become. Then every
 *  markdown- and HTML-active character is backslash-escaped and autolinks are broken, so a cell can never become an
 *  image, a link, HTML or a terminal escape; a cell is at most 120 characters. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const plain = String(v).replace(ANSI, "").replace(CONTROL_ALL, " ").replace(/\s+/g, " ").trim();
  const cut = [...plain].length > CELL_CHARS ? `${[...plain].slice(0, CELL_CHARS - 1).join("")}…` : plain;
  return defuseReferences(cut).replace(/[\\`*_[\]<>&!|~#]/g, "\\$&").replace(/\]:/g, "]\\:").replace(/:\/\//g, ":\\/\\/").replace(/www\./gi, (m) => `${m.slice(0, 3)}\\.`);
}

/** The complete fallback: the model's text, then the table it asked for (at most 20 rows, then how many more).
 *  A table is refused for a kind without rows, and for a column the rows do not have. */
export function completeFallback(input: FallbackInput, kind: BlockKind, spec: BlockSpec, path: Path): string {
  if (!input.table) return input.text;
  const at = [...path, "table"];
  const rows = blockRows(kind, spec);
  if (!rows) fail("VALIDATION_FAILED", at, `a ${kind} block has no rows to tabulate`, kind === "kpis" ? "write one line per tile in the text" : undefined);
  const known = kind === "grid" ? (spec as GridSpec).columns.map((c) => c.key) : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  // a column the rows do not have is left out (the table is the engine's, so this costs nothing); none left: all
  const asked = input.table.columns ?? known;
  const missing = asked.filter((c) => !known.includes(c));
  if (missing.length) notice(`fallback.table: left out columns that are not fields of the rows (${missing.join(", ")})`);
  const kept = asked.filter((c) => known.includes(c));
  const columns = kept.length ? kept : known;
  const labels = kind === "grid" ? new Map((spec as GridSpec).columns.map((c) => [c.key, c.label])) : new Map<string, string>();
  const shown = rows.slice(0, input.table.max_rows ?? DISPLAY_LIMITS.fallbackTableRows).map((r) => (c: string) => (Object.hasOwn(r, c) ? r[c] : undefined));
  const numeric = (c: string) => shown.some((r) => typeof r(c) === "number") && shown.every((r) => r(c) === null || r(c) === undefined || typeof r(c) === "number");
  const lines = [
    `| ${columns.map((c) => cell(labels.get(c) ?? c)).join(" | ")} |`,
    `| ${columns.map((c) => (numeric(c) ? "---:" : "---")).join(" | ")} |`,
    ...shown.map((r) => `| ${columns.map((c) => cell(r(c))).join(" | ")} |`),
  ];
  const more = rows.length - shown.length;
  return `${input.text}\n\n${lines.join("\n")}${more > 0 ? `\n\n${more} more row${more === 1 ? "" : "s"} not shown.` : ""}`;
}
