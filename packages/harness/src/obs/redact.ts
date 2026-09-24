import type { ToolResultBlocks } from "@mlpal/harness-protocol";
import type { ToolResult } from "../tools/types";

/**
 * Secret redaction at the tool boundary. Every key the host loads (gateway key, HOP key,
 * keyring rungs) and every value the env scrub removed is registered here; any tool result
 * that contains one of those values has it replaced by `[redacted:<label>]` before the model,
 * the conversation log or the terminal sees it. Values shorter than MIN_LEN are not registered:
 * masking a 4-character string would shred ordinary output.
 */

const MIN_LEN = 8;
const secrets = new Map<string, string>(); // value → label

export function registerSecret(label: string, value: string | undefined | null): void {
  if (!value || value.length < MIN_LEN) return;
  secrets.set(value, label);
}

export function registerSecrets(values: Record<string, string>): void {
  for (const [label, value] of Object.entries(values)) registerSecret(label, value);
}

/** Test seam. */
export function clearSecrets(): void {
  secrets.clear();
}

export function redactText(text: string): string {
  if (secrets.size === 0 || !text) return text;
  let out = text;
  // Longest first, so a secret that contains another is masked whole.
  for (const [value, label] of [...secrets.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (out.includes(value)) out = out.split(value).join(`[redacted:${label}]`);
  }
  return out;
}

export function redactBlocks(blocks: ToolResultBlocks): ToolResultBlocks {
  return blocks.map((b) => (b.type === "text" ? { ...b, text: redactText(b.text) } : b)) as ToolResultBlocks;
}

export function redactResult(res: ToolResult): ToolResult {
  if (secrets.size === 0) return res;
  return {
    ...res,
    content: typeof res.content === "string" ? redactText(res.content) : redactBlocks(res.content),
    ...(res.meta?.diff ? { meta: { ...res.meta, diff: redactText(res.meta.diff) } } : {}),
  };
}
