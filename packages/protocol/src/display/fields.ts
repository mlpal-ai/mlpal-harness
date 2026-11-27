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
