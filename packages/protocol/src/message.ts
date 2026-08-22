import { z } from "zod";
import { contentBlockSchema } from "./content";

export const roleSchema = z.enum(["user", "assistant"]);
export type Role = z.infer<typeof roleSchema>;

export const messageSchema = z.object({
  role: roleSchema,
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});
export type Message = z.infer<typeof messageSchema>;

/** Anthropic stop_reason vocabulary — the gateway normalizes every provider into this. */
export const stopReasonSchema = z.enum([
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
]);
export type StopReason = z.infer<typeof stopReasonSchema>;
