import { z } from "zod";

/** The meter's unit: 1 compute unit is USD 10, so `usd = compute_units * USD_PER_CU`. */
export const USD_PER_CU = 10;

export const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  /** The gateway's own charge for the call(s), in compute units (protocol 0.17.0). Absent when
   *  the gateway reported none (an older gateway, a failed call). */
  compute_units: z.number().optional(),
  /** An estimate of a charge that could not be confirmed, kept apart from `compute_units`: a GenerateImage request
   *  whose engine died before the gateway named its job, too long ago to ask again under its idempotency key. */
  compute_units_unconfirmed: z.number().optional(),
  /** How many such unconfirmed charges have no estimate at all (a model priced only after its render): unknown, never
   *  zero. */
  unpriced_charges: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    ...(a.compute_units !== undefined || b.compute_units !== undefined ? { compute_units: (a.compute_units ?? 0) + (b.compute_units ?? 0) } : {}),
    ...(a.compute_units_unconfirmed !== undefined || b.compute_units_unconfirmed !== undefined ? { compute_units_unconfirmed: (a.compute_units_unconfirmed ?? 0) + (b.compute_units_unconfirmed ?? 0) } : {}),
    ...(a.unpriced_charges !== undefined || b.unpriced_charges !== undefined ? { unpriced_charges: (a.unpriced_charges ?? 0) + (b.unpriced_charges ?? 0) } : {}),
  };
}
