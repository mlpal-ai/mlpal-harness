import type { ToolResultBlocks } from "@mlpal/harness-protocol";
import type { ToolResult } from "../tools/types";

/**
 * Secret redaction at the tool boundary. Every key the host loads (gateway key, HOP key,
 * keyring rungs) and every value the env scrub removed is registered here; any tool result
 * that contains one of those values has it replaced by `[redacted:<label>]` before the model,
 * the conversation log or the terminal sees it. Values shorter than MIN_LEN are not registered:
 * masking a 4-character string would shred ordinary output.
 *
 * Patterns (C8 §8) catch what the host never saw: a key a command has just minted, a JWT, a database URL's password.
 * A host opts in (`registerPlatformPatterns` on a hosted engine): on a person's own machine a JWT in their output may
 * be what they are debugging. Known values are masked first, so their labels win.
 */

const MIN_LEN = 8;
const secrets = new Map<string, string>(); // value → label
const patterns = new Map<string, RegExp>(); // label → pattern (global)

/** The platform's secret shapes (C8 §8). A reveal handle (`rvl_…`, C4) is deliberately not one: the UI needs it, and
 *  it is single use and bound to its owner. */
export const PLATFORM_SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // 16 or more after the prefix: a key's 8-character display prefix (`mlpal_sk_abcd1234...`, C1 §2.4) is no secret, and
  // the person needs it to tell keys apart (review F1). `mlpal_rc_` is a delegated runner code (hop-service
  // `runner_codes`, 43 urlsafe characters): a runner who pastes one into a session must not have it read back.
  { label: "mlpal-key", pattern: /\b(?:mlpal_(?:sk|hk|svc|rc)|cde_sk)_[A-Za-z0-9_-]{16,}/g },
  { label: "sandbox-stand-in", pattern: /\bmlpal-se-[0-9a-f]{32}\b/g },
  // Only the password: the scheme, user and host stay readable.
  { label: "db-url-password", pattern: /(?<=\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:@/\s]+:)[^@\s]+(?=@)/g },
];

export function registerSecret(label: string, value: string | undefined | null): void {
  if (!value || value.length < MIN_LEN) return;
  for (const form of encodedForms(value)) if (form.length >= MIN_LEN && !secrets.has(form)) secrets.set(form, label);
}

/**
 * REVIEW-2 RQ-6(b): the forms a read of a secret commonly takes besides the value itself: JSON-escaped (as a JSON
 * file holds it), URL-encoded, hex (as `xxd -p` and `od` print it, lower and upper), and base64 (standard and URL-safe)
 * at each of the three alignments a value can have inside a larger encoded file: for a value that does not start the
 * file, the characters that mix it with its neighbours are dropped and the rest is still unique to it. A determined
 * transform (reversed, split, spaced) is not covered: masking is a backstop, not the boundary.
 */
export function encodedForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const forms = new Set<string>([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), bytes.toString("hex"), bytes.toString("hex").toUpperCase()]);
  for (let k = 0; k < 3; k++) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString("base64");
    // The leading group mixes the k padding bytes in; the trailing group may mix in what follows the value.
    const core = b64.slice(k === 0 ? 0 : 4, b64.length - 4);
    if (core.length >= MIN_LEN) {
      forms.add(core);
      forms.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  forms.add(bytes.toString("base64").replace(/=+$/, ""));
  return [...forms];
}

export function registerSecrets(values: Record<string, string>): void {
  for (const [label, value] of Object.entries(values)) registerSecret(label, value);
}

/** Every match of `pattern` (which must be global) becomes `[redacted:<label>]`. A label registered again is replaced. */
export function registerPattern(label: string, pattern: RegExp): void {
  if (!pattern.global) throw new Error(`redaction pattern ${label} must be global (the g flag)`);
  patterns.set(label, pattern);
}

export function registerPlatformPatterns(): void {
  for (const { label, pattern } of PLATFORM_SECRET_PATTERNS) registerPattern(label, pattern);
}

/** Test seam. */
export function clearSecrets(): void {
  secrets.clear();
  patterns.clear();
}

const active = (): boolean => secrets.size > 0 || patterns.size > 0;

export function redactText(text: string): string {
  if (!active() || !text) return text;
  let out = text;
  // Longest first, so a secret that contains another is masked whole.
  for (const [value, label] of [...secrets.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (out.includes(value)) out = out.split(value).join(`[redacted:${label}]`);
  }
  for (const [label, pattern] of patterns) out = out.replace(pattern, `[redacted:${label}]`);
  return out;
}

export function redactBlocks(blocks: ToolResultBlocks): ToolResultBlocks {
  return blocks.map((b) => (b.type === "text" ? { ...b, text: redactText(b.text) } : b)) as ToolResultBlocks;
}

/** Every string inside a JSON value, redacted; the shape is kept. */
function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redactText(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}

export function redactResult(res: ToolResult): ToolResult {
  if (!active()) return res;
  const meta = res.meta;
  return {
    ...res,
    content: typeof res.content === "string" ? redactText(res.content) : redactBlocks(res.content),
    ...(meta && (meta.diff || meta.displayText || meta.display)
      ? {
          meta: {
            ...meta,
            ...(meta.diff ? { diff: redactText(meta.diff) } : {}),
            ...(meta.displayText ? { displayText: redactText(meta.displayText) } : {}),
            ...(meta.display ? { display: redactDeep(meta.display) } : {}),
          },
        }
      : {}),
  };
}
