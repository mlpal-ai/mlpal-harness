import { z } from "zod";
export declare const usageSchema: z.ZodObject<{
    input_tokens: z.ZodNumber;
    output_tokens: z.ZodNumber;
    cache_creation_input_tokens: z.ZodOptional<z.ZodNumber>;
    cache_read_input_tokens: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | undefined;
    cache_read_input_tokens?: number | undefined;
}, {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | undefined;
    cache_read_input_tokens?: number | undefined;
}>;
export type Usage = z.infer<typeof usageSchema>;
export declare function emptyUsage(): Usage;
export declare function addUsage(a: Usage, b: Usage): Usage;
