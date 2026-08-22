import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { z } from "zod";
import { defineTool, err, ok, resolveInRoots } from "../types";
import { unifiedDiff } from "./diff";

const IMAGE_MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_INLINE_BYTES = 10 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;

export const readTool = defineTool({
  name: "Read",
  description:
    "Read a file. Text files return numbered lines; images (png/jpg/gif/webp) and PDFs return rich content you can see directly. Supports offset/limit for large text files.",
  readOnly: true,
  schema: z.object({
    path: z.string().describe("File path (absolute or relative to cwd)"),
    offset: z.number().int().min(1).optional().describe("1-based start line"),
    limit: z.number().int().min(1).optional().describe("max lines to read"),
  }),
  async call(input, ctx) {
    const r = resolveInRoots(ctx, input.path);
    if ("error" in r) return r.error;
    const file = r.path;
    if (!existsSync(file)) return err(`File not found: ${input.path}`);

    // Images and PDFs are returned as rich blocks the model reads natively.
    const ext = extname(file).toLowerCase();
    const imageMedia = IMAGE_MEDIA[ext];
    if (imageMedia || ext === ".pdf") {
      const buf = await readFile(file);
      if (buf.length > MAX_INLINE_BYTES) {
        return err(`file too large to read inline (${(buf.length / 1e6).toFixed(1)} MB)`);
      }
      const data = buf.toString("base64");
      return imageMedia
        ? { content: [{ type: "image", source: { type: "base64", media_type: imageMedia, data } }] }
        : {
            content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
            ],
          };
    }

    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    const start = (input.offset ?? 1) - 1;
    // Default line cap keeps an unbounded Read of a huge file from flooding context.
    // The model can page with offset/limit or Grep for the part it needs.
    const end = input.limit ? start + input.limit : Math.min(lines.length, start + DEFAULT_READ_LINES);
    const slice = lines.slice(start, end);
    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`)
      .join("\n");
    const truncated =
      !input.limit && lines.length > end
        ? `\n[read ${end}/${lines.length} lines — pass offset:${end + 1} to continue, or Grep for a specific match]`
        : "";
    return ok(numbered + truncated);
  },
});

export const writeTool = defineTool({
  name: "Write",
  description: "Write content to a file, creating parent directories. Overwrites if it exists.",
  readOnly: false,
  edits: true,
  schema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  async call(input, ctx) {
    const r = resolveInRoots(ctx, input.path);
    if ("error" in r) return r.error;
    const file = r.path;
    const before = existsSync(file) ? await readFile(file, "utf8") : "";
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, input.content, "utf8");
    const diff = unifiedDiff(before, input.content);
    return ok(`Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}`, diff ? { diff } : undefined);
  },
});

export const editTool = defineTool({
  name: "Edit",
  description:
    "Replace an exact string in a file. old_string must be unique unless replace_all is set.",
  readOnly: false,
  edits: true,
  schema: z.object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  async call(input, ctx) {
    const r = resolveInRoots(ctx, input.path);
    if ("error" in r) return r.error;
    const file = r.path;
    if (!existsSync(file)) return err(`File not found: ${input.path}`);
    const text = await readFile(file, "utf8");
    const count = text.split(input.old_string).length - 1;
    if (count === 0) return err("old_string not found in file");
    if (count > 1 && !input.replace_all) {
      return err(`old_string is not unique (${count} matches); set replace_all or add context`);
    }
    const next = input.replace_all
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, input.new_string);
    await writeFile(file, next, "utf8");
    const diff = unifiedDiff(text, next);
    return ok(
      `Replaced ${input.replace_all ? count : 1} occurrence(s) in ${input.path}`,
      diff ? { diff } : undefined,
    );
  },
});
