import { z } from "zod";
import { blockRows, parseShape, type BlockSpec, type GridSpec } from "./blocks.js";
import { DISPLAY_LIMITS, isBlockKind, type BlockKind } from "./catalog.js";
import { fail } from "./errors.js";

/**
 * 0.27.0 display protocol: the text every display carries (DISPLAY-PROTOCOL-v0 §2.5). It is what a terminal, an
 * e-mail, a screen reader and a pinned UI show, so it must stand alone: the conclusion and the key numbers, in plain
 * GFM. The checks are cheap heuristics, not a semantic judgement.
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
const HTML = /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>|<!--/i;
const IMAGE = /!\[[^\]]*\]\(/;
const FENCE = /^\s*(```|~~~)/m;

/** The fallback as the model sent it, checked. A bare string is taken as its text (models flatten small objects).
 *  `kind`, when it is a block kind, adds the rule that a chart, kpis or grid fallback states a number. */
export function checkFallbackInput(raw: unknown, kind: unknown, path: Path): FallbackInput {
  if (raw === undefined || raw === null) fail("FALLBACK_MISSING", path, "every Show needs a fallback", '"fallback": { "text": "<the conclusion and key numbers>" }');
  const obj = typeof raw === "string" ? { text: raw } : raw;
  if (typeof obj === "object" && !Array.isArray(obj) && (obj as { text?: unknown }).text === undefined) fail("FALLBACK_MISSING", [...path, "text"], "the fallback has no text", '"fallback": { "text": "<the conclusion and key numbers>" }');
  const input = parseShape(fallbackInputSchema, obj, path);
  const text = input.text.trim();
  const at = [...path, "text"];
  if (!text) fail("FALLBACK_MISSING", at, "the fallback text is empty", "state the conclusion and the key numbers");
  const chars = [...text].length;
  if (chars > DISPLAY_LIMITS.fallbackMaxChars) fail("FALLBACK_TOO_LONG", at, `${chars} characters; a fallback is at most ${DISPLAY_LIMITS.fallbackMaxChars}`, "keep the conclusion and key numbers; ask for a table with fallback.table instead of writing one");
  if (chars < DISPLAY_LIMITS.fallbackMinChars) fail("FALLBACK_UNINFORMATIVE", at, `${chars} characters; a fallback is at least ${DISPLAY_LIMITS.fallbackMinChars}`, "a person who cannot see the block reads only this: state the conclusion and the key numbers");
  if (REFERENCE_ONLY.test(text)) fail("FALLBACK_UNINFORMATIVE", at, "the fallback only points at the block", "say what the block shows, not where to look");
  if (typeof kind === "string" && isBlockKind(kind) && !/\d/.test(text)) fail("FALLBACK_UNINFORMATIVE", at, `a ${kind} fallback states at least one number`, "give the key numbers the block shows");
  if (HTML.test(text)) fail("VALIDATION_FAILED", at, "the fallback is plain markdown: no HTML", "write it as text and GFM tables");
  if (IMAGE.test(text)) fail("VALIDATION_FAILED", at, "the fallback is plain markdown: no images", "describe what the image would show");
  if (FENCE.test(text)) fail("VALIDATION_FAILED", at, "the fallback is plain markdown: no code fences");
  return { ...input, text };
}

const cell = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|"));

/** The complete fallback: the model's text, then the table it asked for (at most 20 rows, then how many more).
 *  A table is refused for a kind without rows, and for a column the rows do not have. */
export function completeFallback(input: FallbackInput, kind: BlockKind, spec: BlockSpec, path: Path): string {
  if (!input.table) return input.text;
  const at = [...path, "table"];
  const rows = blockRows(kind, spec);
  if (!rows) fail("VALIDATION_FAILED", at, `a ${kind} block has no rows to tabulate`, kind === "kpis" ? "write one line per tile in the text" : undefined);
  const known = kind === "grid" ? (spec as GridSpec).columns.map((c) => c.key) : [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns = input.table.columns ?? known;
  columns.forEach((c, i) => {
    if (!known.includes(c)) fail("VALIDATION_FAILED", [...at, "columns", i], `"${c}" is not a field of the rows`, `fields: ${known.join(", ")}`);
  });
  const labels = kind === "grid" ? new Map((spec as GridSpec).columns.map((c) => [c.key, c.label])) : new Map<string, string>();
  const shown = rows.slice(0, input.table.max_rows ?? DISPLAY_LIMITS.fallbackTableRows);
  const numeric = (c: string) => shown.some((r) => typeof r[c] === "number") && shown.every((r) => r[c] === null || r[c] === undefined || typeof r[c] === "number");
  const lines = [
    `| ${columns.map((c) => cell(labels.get(c) ?? c)).join(" | ")} |`,
    `| ${columns.map((c) => (numeric(c) ? "---:" : "---")).join(" | ")} |`,
    ...shown.map((r) => `| ${columns.map((c) => cell(r[c])).join(" | ")} |`),
  ];
  const more = rows.length - shown.length;
  return `${input.text}\n\n${lines.join("\n")}${more > 0 ? `\n\n${more} more row${more === 1 ? "" : "s"} not shown.` : ""}`;
}
