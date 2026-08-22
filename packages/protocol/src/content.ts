import { z } from "zod";

/**
 * Anthropic-Messages content blocks. This is yodex's internal canonical message
 * format — the gateway translates these to/from each provider, so the engine only
 * ever speaks this one shape. See docs/02 and docs/03.
 */

export const cacheControlSchema = z.object({ type: z.literal("ephemeral") });
export type CacheControl = z.infer<typeof cacheControlSchema>;

export const textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  cache_control: cacheControlSchema.optional(),
});
export type TextBlock = z.infer<typeof textBlockSchema>;

export const thinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional(),
});
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;

export const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;

export const imageBlockSchema = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }),
});
export type ImageBlock = z.infer<typeof imageBlockSchema>;

/** Documents (e.g. PDFs) the model can read natively. */
export const documentBlockSchema = z.object({
  type: z.literal("document"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string(), // application/pdf
    data: z.string(),
  }),
});
export type DocumentBlock = z.infer<typeof documentBlockSchema>;

/** tool_result content can be a plain string or a list of text/image/document blocks. */
export const toolResultBlocksSchema = z.array(
  z.union([textBlockSchema, imageBlockSchema, documentBlockSchema]),
);
export type ToolResultBlocks = z.infer<typeof toolResultBlocksSchema>;

export const toolResultContentSchema = z.union([z.string(), toolResultBlocksSchema]);

export const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: toolResultContentSchema,
  is_error: z.boolean().optional(),
  cache_control: cacheControlSchema.optional(),
});
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;

export const contentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  thinkingBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  imageBlockSchema,
  documentBlockSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;
