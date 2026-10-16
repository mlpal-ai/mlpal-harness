import { z } from "zod";
/**
 * Every event carries an author. This is the load-bearing field for inter-agent
 * collaboration: a peer agent's injected turn is rendered "from <displayName>"
 * rather than as the local human. See docs/05 §7.
 */
export declare const authorSchema: z.ZodObject<{
    type: z.ZodEnum<["human", "agent", "system"]>;
    id: z.ZodOptional<z.ZodString>;
    displayName: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "human" | "agent" | "system";
    id?: string | undefined;
    displayName?: string | undefined;
}, {
    type: "human" | "agent" | "system";
    id?: string | undefined;
    displayName?: string | undefined;
}>;
export type Author = z.infer<typeof authorSchema>;
export declare const HUMAN: Author;
export declare const SYSTEM: Author;
export declare function agentAuthor(id: string, displayName?: string): Author;
