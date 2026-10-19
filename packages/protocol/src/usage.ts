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
  };
}
