import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ContentBlock } from "@mlpal/harness-protocol";

const execFileAsync = promisify(execFile);

/**
 * File attachments in a prompt: drag-dropping a file into the terminal inserts its path
 * (usually quoted or with backslash-escaped spaces), and users also type @path mentions.
 * We detect media paths in the submitted text and turn them into content blocks — images
 * and PDFs as native base64 blocks the model reads directly, Word docs as extracted text.
 * Explicitly naming a file in the prompt is user intent, so this deliberately ignores the
 * workspace roots that bound *tool* access (dragging ~/Desktop/x.png must just work).
 * Multi-model: callers gate on the current model's vision/pdf capability and skip with a
 * note when unsupported instead of sending blocks the provider would reject.
 */

export const IMAGE_MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const IMAGE_MAX = 5 * 1024 * 1024;
const PDF_MAX = 20 * 1024 * 1024;
const DOCX_TEXT_MAX = 80_000;

export type AttachmentKind = "image" | "pdf" | "docx";

export interface Attachment {
  path: string;
  name: string;
  kind: AttachmentKind;
  block?: ContentBlock;
  /** Set when the file could not be attached (too large, unreadable, …). */
  skipped?: string;
}

/** Extensions we treat as attachable media (everything else stays plain text). */
function kindForPath(p: string): AttachmentKind | null {
  const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
  if (IMAGE_MEDIA[ext]) return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  return null;
}

/** True if the path is attachable media (used to keep it out of text inlining). */
export function isMediaPath(p: string): boolean {
  return kindForPath(p) !== null;
}

const EXT_RE = "(?:png|jpe?g|gif|webp|pdf|docx)";
// Path tokens as terminals produce them on drag-drop: 'single-quoted', "double-quoted",
// or bare with backslash-escaped specials. Also plain @-mentions and relative tokens.
const PATH_PATTERNS = [
  new RegExp(`'([^']+\\.${EXT_RE})'`, "gi"), // '/path/with spaces.png'
  new RegExp(`"([^"]+\\.${EXT_RE})"`, "gi"), // "/path/with spaces.png"
  new RegExp(`((?:[^\\s\\\\]|\\\\.)+\\.${EXT_RE})`, "gi"), // /path/with\ spaces\,commas.png or rel/x.pdf
];

// Terminals backslash-escape shell-special characters in a dragged path: spaces, commas,
// parens, `&`, quotes, etc. Undo that — but only before a NON-alphanumeric char, so a Windows
// separator like `C:\Users\x.png` (backslash before a letter) is left intact.
function unescapeShell(s: string): string {
  return s.replace(/\\([^A-Za-z0-9])/g, "$1");
}

/** Unique candidate media paths found in the text, unescaped, ~ expanded. */
export function detectMediaPaths(text: string): string[] {
  const found = new Set<string>();
  for (const re of PATH_PATTERNS) {
    for (const m of text.matchAll(re)) {
      let p = unescapeShell(m[1]!);
      if (p.startsWith("@")) p = p.slice(1);
      if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
      found.add(p);
    }
  }
  return [...found];
}

/**
 * Robust drag-drop detection: for each media extension in the text, take the LONGEST
 * path (from an earlier `/` or `~`, or the line start) that actually EXISTS on disk after
 * unescaping. Checking the filesystem — not just a regex — recovers paths with spaces the
 * terminal left unescaped (e.g. "Screenshot … 3.51.16 AM.png"), which the pattern-only pass
 * would clip to "AM.png" and miss. Returns absolute paths.
 */
function detectExistingMediaPaths(text: string, cwd: string): string[] {
  const out = new Set<string>();
  const extRe = new RegExp(`\\.${EXT_RE}\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = extRe.exec(text))) {
    const end = m.index + m[0].length;
    const starts = [0];
    for (let i = 0; i < end; i++) if (text[i] === "/" || text[i] === "~") starts.push(i);
    // Longest first (smallest start) → recover the most spaces.
    for (const start of [...new Set(starts)].sort((a, b) => a - b)) {
      let cand = unescapeShell(text.slice(start, end)).trim();
      if (cand.startsWith("@")) cand = cand.slice(1);
      const abs = cand.startsWith("~/")
        ? join(homedir(), cand.slice(2))
        : isAbsolute(cand)
          ? cand
          : join(cwd, cand);
      try {
        if (existsSync(abs) && statSync(abs).isFile()) {
          out.add(abs);
          break;
        }
      } catch {
        // not accessible — keep trying shorter candidates
      }
    }
  }
  return [...out];
}

/** Extract plain text from a .docx: macOS textutil, falling back to unzip + tag-strip. */
async function docxToText(path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", path], {
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stdout.trim()) return stdout;
  } catch {
    // textutil unavailable (non-macOS) — fall through
  }
  const { stdout } = await execFileAsync("unzip", ["-p", path, "word/document.xml"], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout
    .replace(/<w:p[ >]/g, "\n<")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function toAttachment(path: string, cwd: string): Promise<Attachment | null> {
  const abs = isAbsolute(path) ? path : join(cwd, path);
  const kind = kindForPath(abs);
  if (!kind) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) return null; // prose, not a file
  const name = basename(abs);

  try {
    if (kind === "image" || kind === "pdf") {
      const buf = await readFile(abs);
      const max = kind === "image" ? IMAGE_MAX : PDF_MAX;
      if (buf.length > max) {
        return { path: abs, name, kind, skipped: `too large (${(buf.length / 1e6).toFixed(1)} MB)` };
      }
      const data = buf.toString("base64");
      const block: ContentBlock =
        kind === "image"
          ? { type: "image", source: { type: "base64", media_type: IMAGE_MEDIA[abs.slice(abs.lastIndexOf(".")).toLowerCase()]!, data } }
          : { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
      return { path: abs, name, kind, block };
    }
    // docx → extracted text block (no provider supports docx natively)
    let text = await docxToText(abs);
    if (text.length > DOCX_TEXT_MAX) text = `${text.slice(0, DOCX_TEXT_MAX)}\n\n[truncated]`;
    return {
      path: abs,
      name,
      kind,
      block: { type: "text", text: `<attached-document name="${name}">\n${text}\n</attached-document>` },
    };
  } catch (e) {
    return { path: abs, name, kind, skipped: (e as Error).message };
  }
}

/** Find and load every attachable media file referenced in the text. */
export async function collectAttachments(text: string, cwd: string): Promise<Attachment[]> {
  return collectAttachmentsForPaths(candidatePaths(text, cwd), cwd);
}

/** Candidate media paths in the text: pattern pass (quoted / backslash-escaped) + disk pass
 *  (recovers unescaped-space paths). Not deduped/validated — that happens in toAttachment. */
function candidatePaths(text: string, cwd: string): string[] {
  return [...detectMediaPaths(text), ...detectExistingMediaPaths(text, cwd)];
}

/** Load Attachments for an explicit list of paths (e.g. resolved from `[Image #N]` placeholders),
 *  deduped by absolute path. Non-media / missing paths are dropped. */
export async function collectAttachmentsForPaths(paths: string[], cwd: string): Promise<Attachment[]> {
  const out: Attachment[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const a = await toAttachment(p, cwd);
    if (a && !seen.has(a.path)) {
      seen.add(a.path);
      out.push(a);
    }
  }
  return out;
}

/** Absolute paths of existing IMAGE files referenced in the text — detection only, no file read.
 *  Used to swap a just-dropped/pasted image path for an `[Image #N]` placeholder as it lands. */
export function detectImagePaths(text: string, cwd: string): string[] {
  return detectImageSpans(text, cwd).map((s) => s.path);
}

/**
 * Like detectImagePaths, but returns the EXACT matched substring (`raw`) alongside the resolved
 * absolute `path`, so a caller can find-and-replace the placeholder without reconstructing the
 * terminal's escaping. Robust to backslash-escaped specials (spaces, commas, parens, …) — the
 * filesystem check recovers the real path from the longest existing candidate.
 */
export function detectImageSpans(text: string, cwd: string): { raw: string; path: string }[] {
  const out: { raw: string; path: string }[] = [];
  const seen = new Set<string>();
  const extRe = new RegExp(`\\.${EXT_RE}\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = extRe.exec(text))) {
    const end = m.index + m[0].length;
    const starts = new Set([0]);
    for (let i = 0; i < end; i++) if (text[i] === "/" || text[i] === "~") starts.add(i);
    // Longest first (smallest start) → recovers the most escaped specials.
    for (const start of [...starts].sort((a, b) => a - b)) {
      const raw = text.slice(start, end);
      let cand = unescapeShell(raw).trim();
      if (cand.startsWith("@")) cand = cand.slice(1);
      const abs = cand.startsWith("~/")
        ? join(homedir(), cand.slice(2))
        : isAbsolute(cand)
          ? cand
          : join(cwd, cand);
      if (kindForPath(abs) !== "image") continue;
      try {
        if (existsSync(abs) && statSync(abs).isFile()) {
          if (!seen.has(abs)) {
            seen.add(abs);
            out.push({ raw, path: abs });
          }
          break;
        }
      } catch {
        // not accessible — try a shorter candidate
      }
    }
  }
  return out;
}
