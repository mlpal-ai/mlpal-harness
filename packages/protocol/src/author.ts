import { z } from "zod";

/**
 * Every event carries an author. This is the load-bearing field for inter-agent
 * collaboration: a peer agent's injected turn is rendered "from <displayName>"
 * rather than as the local human. See docs/05 §7.
 */
export const authorSchema = z.object({
  type: z.enum(["human", "agent", "system"]),
  id: z.string().optional(),
  displayName: z.string().optional(),
});
export type Author = z.infer<typeof authorSchema>;

export const HUMAN: Author = { type: "human" };
export const SYSTEM: Author = { type: "system" };

export function agentAuthor(id: string, displayName?: string): Author {
  return { type: "agent", id, displayName: displayName ?? id };
}
