import { z } from "zod";

/** C0 and C1 controls except tab and newline, and the invisible characters that reorder or hide text (bidirectional
 *  marks, embeddings, overrides and isolates, the zero-width space, the BOM): "\u202e0041" shows as "1400". The
 *  zero-width joiner and non-joiner stay, since emoji and several scripts need them. */
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
/** CONTROL with tab and newline, for engine-written text that is stripped rather than refused. */
export const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;

/** One to `max` characters of text a person reads, with no control characters. */
export const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !CONTROL.test(s), "no control characters");

/** Named references that decode to an ordinary printable character; any other name is defused, since the HTML list
 *  also names invisible ones (`&lrm;`, `&ZeroWidthSpace;`, `&NegativeThinSpace;`...). */
const SAFE_NAMED: ReadonlySet<string> = new Set([
  "amp", "lt", "gt", "quot", "apos", "nbsp", "ndash", "mdash", "hellip", "middot", "bull", "deg", "plusmn", "times",
  "divide", "minus", "le", "ge", "ne", "asymp", "infin", "micro", "para", "sect", "copy", "reg", "trade", "euro", "pound",
  "yen", "cent", "laquo", "raquo", "lsquo", "rsquo", "ldquo", "rdquo", "larr", "rarr", "uarr", "darr", "frac12",
  "frac14", "frac34", "sup2", "sup3", "permil", "prime", "Prime",
]);
const REFERENCE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]{0,31});?/g;
const ONE_CONTROL = new RegExp(`^${CONTROL.source}$`);

function harmless(body: string): boolean {
  if (!body.startsWith("#")) return SAFE_NAMED.has(body);
  const hex = body[1] === "x" || body[1] === "X";
  const digits = body.slice(hex ? 2 : 1);
  // more digits than any scalar value needs is out of range, however many leading zeros
  if (digits.replace(/^0+/, "").length > (hex ? 6 : 7)) return false;
  const cp = parseInt(digits, hex ? 16 : 10);
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
  return !ONE_CONTROL.test(String.fromCodePoint(cp));
}

/**
 * Text a client may decode (a client that cannot render markdown decodes entity codes) never decodes to a control
 * character: the `&` of a numeric reference (decimal or hex, any case, leading zeros, with or without `;`) whose code
 * point is in CONTROL or is no scalar value, and of a named reference outside a small list of printable ones, becomes
 * `&amp;`, so the reference shows as written. References to printable characters stay, HTML-significant ones included
 * (`&#60;`): a reference never forms markup in a markdown renderer, and a plain-text client shows the character.
 */
export function defuseReferences(text: string): string {
  return text.replace(REFERENCE, (m, body: string) => (harmless(body) ? m : `&amp;${m.slice(1)}`));
}
