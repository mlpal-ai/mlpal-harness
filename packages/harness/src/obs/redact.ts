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
  // the person needs it to tell keys apart (review F1).
  { label: "mlpal-key", pattern: /\b(?:mlpal_(?:sk|hk|svc)|cde_sk)_[A-Za-z0-9_-]{16,}/g },
  { label: "sandbox-stand-in", pattern: /\bmlpal-se-[0-9a-f]{32}\b/g },
  // Only the password: the scheme, user and host stay readable.
  { label: "db-url-password", pattern: /(?<=\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:@/\s]+:)[^@\s]+(?=@)/g },
];

export function registerSecret(label: string, value: string | undefined | null): void {
  if (!value || value.length < MIN_LEN) return;
  secrets.set(value, label);
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

export function redactResult(res: ToolResult): ToolResult {
  if (!active()) return res;
  return {
    ...res,
    content: typeof res.content === "string" ? redactText(res.content) : redactBlocks(res.content),
    ...(res.meta?.diff ? { meta: { ...res.meta, diff: redactText(res.meta.diff) } } : {}),
  };
}
