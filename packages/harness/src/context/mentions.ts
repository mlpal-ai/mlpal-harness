import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolvePath, withinRoots } from "../tools/types";
import { isMediaPath } from "./attachments";

/**
 * `@path` file mentions. The TUI completes them as you type; on submit we expand each
 * mention that names a real file inside the workspace roots, inlining its contents so the
 * model has them without a round-trip. Tokens that don't resolve to a real in-bounds file
 * are left as plain text (they're probably prose, not a reference) — only out-of-bounds
 * hits are surfaced, since those are an explicit access intent we refused.
 */

const MENTION_RE = /(?:^|\s)@([^\s@]+)/g;
const MAX_FILE_BYTES = 64 * 1024;

export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    // strip trailing punctuation that commonly abuts a path in prose (e.g. "@a.ts," "@a.ts?")
    out.push(m[1]!.replace(/[.,;:!?)\]]+$/, ""));
  }
  return [...new Set(out.filter(Boolean))];
}

export interface MentionAttachment {
  path: string;
  ok: boolean;
  reason?: string;
}

export interface MentionExpansion {
  /** Text to send to the model: original + an inlined <referenced-files> block. */
  text: string;
  /** Files actually inlined, plus any out-of-bounds refusals (for user feedback). */
  attached: MentionAttachment[];
}

export async function expandMentions(
  text: string,
  opts: { cwd: string; roots: string[] },
): Promise<MentionExpansion> {
  const mentions = extractMentions(text);
  if (mentions.length === 0) return { text, attached: [] };

  const blocks: string[] = [];
  const attached: MentionAttachment[] = [];
  for (const ref of mentions) {
    if (isMediaPath(ref)) continue; // images/PDFs/docs attach as content blocks, not inlined text
    const abs = resolvePath(opts.cwd, ref);
    if (!withinRoots(abs, opts.roots)) {
      attached.push({ path: ref, ok: false, reason: "outside allowed directories" });
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) continue; // not a file → treat as prose
    let content = await readFile(abs, "utf8");
    let truncated = false;
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES);
      truncated = true;
    }
    blocks.push(`### ${ref}\n\`\`\`\n${content}${truncated ? "\n…(truncated)" : ""}\n\`\`\``);
    attached.push({ path: ref, ok: true });
  }

  if (blocks.length === 0) return { text, attached };
  return {
    text: `${text}\n\n<referenced-files>\n${blocks.join("\n\n")}\n</referenced-files>`,
    attached,
  };
}
