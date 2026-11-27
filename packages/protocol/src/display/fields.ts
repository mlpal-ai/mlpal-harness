import { z } from "zod";

/** C0 and C1 controls except tab and newline. */
export const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

/** One to `max` characters of text a person reads, with no control characters. */
export const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !CONTROL.test(s), "no control characters");
