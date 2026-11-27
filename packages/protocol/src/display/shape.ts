import type { z } from "zod";
import { DisplayRefusal, displayError } from "./errors.js";

type Path = ReadonlyArray<string | number>;

const RECEIVED: Readonly<Record<string, string>> = { undefined: "nothing", null: "null", array: "a list", object: "an object", string: "a string", number: "a number", boolean: "a boolean" };

/** Parse with zod; every issue becomes VALIDATION_FAILED at its path (an unknown key at the key's own path). */
export function parseShape<S extends z.ZodTypeAny>(schema: S, value: unknown, path: Path, hint?: string): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const errors = r.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((k) => displayError("VALIDATION_FAILED", [...path, ...issue.path, k], `unknown field "${k}"`, hint))
      : issue.code === "invalid_type"
        ? [displayError("VALIDATION_FAILED", [...path, ...issue.path], `${issue.expected} expected; ${RECEIVED[issue.received] ?? `a ${issue.received}`} arrived`, hint)]
        : [displayError("VALIDATION_FAILED", [...path, ...issue.path], issue.message, hint)],
  );
  throw new DisplayRefusal(errors);
}
