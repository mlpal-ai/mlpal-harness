import type { BlockDisplay, TextDisplay } from "./display/envelope.js";

/**
 * The HOP-shaped home (WAVE-3-HOP-SHAPED-HOME §2–3, DISPLAY-PROTOCOL-v0 §11), first version: a HOP's author declares
 * starters and up to four home blocks, each fed by one script the HOP ships; the engine runs the scripts with no model
 * call, validates what each prints as a Show block, and serves the result behind the capability `hop_home`.
 *
 * Messages: `get_home {requestId, hop?}` → `home {requestId, hop, starters, blocks}` at once (the cached view), then a
 * `home_update {hop, block}` on the same connection for each block as its refresh ends. A HOP without `ui` answers
 * empty `starters` and `blocks`: the client draws the home it draws today.
 */

/** The limits of the first version's `ui` section, enforced by the HOP loader. */
export const HOME_LIMITS = {
  starters: 4,
  starterChars: 60,
  blocks: 4,
  titleChars: 120,
  /** `refresh` is at least this many minutes; default 15. */
  refreshMinMinutes: 5,
  refreshMaxMinutes: 24 * 60,
  refreshDefault: "15m",
  /** A block whose last attempt is younger than this is not run again on `get_home`. */
  rerunAfterMs: 60_000,
  /** One script's wall time and stdout. */
  scriptTimeoutMs: 10_000,
  scriptOutputBytes: 256 * 1024,
  /** Scripts of one HOP running at once. */
  concurrency: 2,
} as const;

/** `ui` as `describe_hop` shows it (`HopView.ui`): what hop.yaml declares, script paths relative to the HOP's directory. */
export interface HopUiView {
  starters: string[];
  home?: { blocks: Array<{ id: string; title: string; script: string; refresh: string }> };
}

/**
 * Why a block's last refresh did not produce a block. Present on a `HomeBlock` only when that refresh failed.
 * - `timeout`: the script ran past 10 s and was killed.
 * - `exit_nonzero`: it exited with a code other than 0.
 * - `output_too_large`: it printed over 256 KiB and was killed.
 * - `not_json`: stdout was not one JSON object.
 * - `invalid_block`: the object is not `{kind, spec, fallback, as_of?}`, or its block fails the Show checks.
 * - `denied`: the HOP's permission rules refuse running it.
 * - `sandbox`: the sandbox took back something it wrote where a command may not write.
 * - `not_started`: it could not be started (no interpreter, the file is gone).
 */
export type HomeRefreshError = "timeout" | "exit_nonzero" | "output_too_large" | "not_json" | "invalid_block" | "denied" | "sandbox" | "not_started";

/**
 * One home block as the client draws it.
 * - `display`: the last good block (`level: "block"`, `source: {by: "host", origin: "home"}`); or, when the block has
 *   never resolved but its newest script output had a valid fallback, that fallback alone (`level: "text"`,
 *   `status: "fallback_only"`); or null when nothing is known yet (never resolved, or never succeeded).
 * - `as_of`: when `display`'s data was true (the script's `as_of`, else when it ran), ISO 8601; null with no display.
 * - `stale`: `display` is not known to be current: its newest refresh failed (`error` says why), or it is older than the
 *   block's `refresh` and a refresh has not landed yet.
 * - `error`: present when the newest refresh failed. With `stale`, draw "Could not refresh"; with `display: null`, "Could
 *   not load".
 */
export interface HomeBlock {
  id: string;
  title: string;
  as_of: string | null;
  stale: boolean;
  display: BlockDisplay | TextDisplay | null;
  error?: HomeRefreshError;
}

/** The home of one HOP. `hop` is `name@version`. */
export interface HomeView {
  hop: string;
  starters: string[];
  blocks: HomeBlock[];
}
