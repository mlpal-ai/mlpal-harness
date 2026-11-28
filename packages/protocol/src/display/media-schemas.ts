import { z } from "zod";
import { DISPLAY_LIMITS } from "./catalog.js";
import { plainText } from "./fields.js";

/**
 * The media kinds' specs as the envelope carries them (DISPLAY-PROTOCOL-v0.1-media §1.2, §1.5): light, like
 * block-schemas.ts, so a client that only reads envelopes bundles nothing of the checks (media.ts). A spec never
 * holds bytes or a URL: a client fetches the file by its workspace path from the workspace's file route, and checks
 * the hash it is served under.
 */

/** The types each kind takes, by magic number (media.ts). SVG is never an image kind: it is a file. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** A file as the engine checked it: where it is, what its bytes are, how many, and their hash. */
export const mediaFileSchema = z
  .object({
    /** Workspace-relative, POSIX separators, no `..`: the daemon's file route takes it as it is. */
    path: plainText(DISPLAY_LIMITS.media.pathChars),
    /** From the bytes' magic number, never the extension. */
    mime: z.string().min(1).max(100),
    bytes: z.number().int().nonnegative(),
    /** Lowercase hex sha256 of the bytes as checked. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type MediaFile = z.infer<typeof mediaFileSchema>;

/** Who made a media file. `generated`: an image model (GenerateImage, or the model saying so); `uploaded`: the person
 *  attached it. */
export const madeBySchema = z.union([
  z
    .object({
      kind: z.literal("generated"),
      model: plainText(120),
      prompt: plainText(4_000),
      revised_prompt: plainText(4_000).optional(),
      /** What making it cost, from the gateway (GenerateImage only). */
      compute_units: z.number().nonnegative().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("uploaded"), by: z.literal("person") }).strict(),
]);
export type MadeBy = z.infer<typeof madeBySchema>;

/** One checked image: its file, its alt text, and what its header says. */
export const imageItemSchema = z
  .object({
    media: mediaFileSchema,
    alt: plainText(DISPLAY_LIMITS.media.altChars),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** An animated GIF or WebP. */
    animated: z.boolean(),
    /** A JPEG whose EXIF holds a location (shown as "Contains location data"); absent when the header cannot say. */
    gps: z.boolean().optional(),
  })
  .strict();
export type ImageItem = z.infer<typeof imageItemSchema>;

export const imageSpecSchema = imageItemSchema.extend({ made_by: madeBySchema.optional() }).strict();
export type ImageSpec = z.infer<typeof imageSpecSchema>;

export const imageSetSpecSchema = z
  .object({
    /** 2 to 8 images, labelled A to H in order. */
    images: z
      .array(imageItemSchema.extend({ label: z.string().regex(/^[A-H]$/) }).strict())
      .min(2)
      .max(DISPLAY_LIMITS.media.setImages),
    /** The index of the one chosen, when one is. */
    chosen: z.number().int().nonnegative().optional(),
    made_by: madeBySchema.optional(),
  })
  .strict();
export type ImageSetSpec = z.infer<typeof imageSetSpecSchema>;

export type MediaSpec = ImageSpec | ImageSetSpec;
