import { z } from "zod";
import { DISPLAY_LEVELS, type DisplayLevel } from "./catalog.js";
import { parseShape } from "./shape.js";
import { checked, type DisplayCheck } from "./errors.js";

/**
 * 0.27.0 display protocol: what a client draws, declared on every `run` (DISPLAY-PROTOCOL-v0 §4.2) and sent only to a
 * server whose `ready.capabilities` has "display". A run without it is served exactly as before: no Show tool, no
 * display in any event. What this version does not know is dropped, not refused, so a newer client's declaration
 * still parses: unknown fields, levels and an unknown `a2ui` version. `client`, `viewport` and `theme` are closed sets
 * in v1.
 */
const LEVELS: ReadonlySet<string> = new Set(DISPLAY_LEVELS);
export const displayCapsSchema = z.object({
  v: z.literal(1),
  client: z.enum(["web", "mobile", "cli", "ide", "api"]),
  /** What the client renders; `text` is implied. */
  levels: z
    .array(z.string().max(40))
    .max(16)
    .transform((ls) => [...new Set(ls.filter((l): l is DisplayLevel => LEVELS.has(l)))]),
  /** Catalog versions it draws blocks from: `["harness.v1/1"]`. */
  catalogs: z.array(z.string().min(1).max(40)).max(8),
  /** A subset of the catalogs' kinds; absent: all of them. */
  kinds: z.array(z.string().min(1).max(40)).max(64).optional(),
  a2ui: z.literal("1.0").optional().catch(undefined),
  viewport: z.enum(["phone", "tablet", "desktop", "wide"]),
  /** Only for server-drawn snapshots. */
  theme: z.enum(["light", "dark"]),
  locale: z.string().min(2).max(35),
  timeZone: z.string().min(1).max(64),
});
export type DisplayCaps = z.infer<typeof displayCapsSchema>;

/** Check a declaration at the server's edge. An invalid one is the server's to drop (the run proceeds without
 *  display) and count; it never fails the run. */
export function parseDisplayCaps(x: unknown): DisplayCheck<DisplayCaps> {
  return checked(() => parseShape(displayCapsSchema, x, ["display"]));
}
