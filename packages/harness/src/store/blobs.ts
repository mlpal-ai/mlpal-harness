/**
 * Attachments out of line. An image or a document arrives as a base64 block inside a message,
 * and the conversation file used to keep it that way: one session on the founder's machine was
 * 9 MB in 17 lines, with single lines of 4 MB, so every reader of the file paid for bytes the
 * model had already been sent once. On append a large block's bytes go to a blob file named by
 * their hash beside the conversation, and the line keeps a small reference; on read the block is
 * rebuilt exactly as it was, so no consumer of the conversation changes. A blob that is gone
 * (deleted by hand) reads back as a text note rather than failing the whole session.
 */
import { createHash } from "node:crypto";

/** Base64 length past which a block is stored as a blob (about 12 KB of bytes). */
export const BLOB_THRESHOLD = 16 * 1024;

export interface BlobRef {
  type: "blob";
  media_type: string;
  /** sha256 of the decoded bytes; the file name. */
  ref: string;
  bytes: number;
}

export interface BlobWrite {
  ref: string;
  data: Uint8Array;
}

function isBase64Source(v: unknown): v is { type: "base64"; media_type: string; data: string } {
  return !!v && typeof v === "object" && (v as { type?: unknown }).type === "base64" && typeof (v as { data?: unknown }).data === "string";
}

function isBlobRef(v: unknown): v is BlobRef {
  return !!v && typeof v === "object" && (v as { type?: unknown }).type === "blob" && typeof (v as { ref?: unknown }).ref === "string";
}

/** Walk any payload; replace each large base64 `source` with a blob reference and collect the
 *  bytes to write. Small blocks stay inline. Returns the same object when nothing changed. */
export function externalizeBlobs<T>(payload: T, threshold = BLOB_THRESHOLD): { payload: T; blobs: BlobWrite[] } {
  const blobs: BlobWrite[] = [];
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if ((o.type === "image" || o.type === "document") && isBase64Source(o.source) && o.source.data.length > threshold) {
      const data = Buffer.from(o.source.data, "base64");
      const ref = createHash("sha256").update(data).digest("hex");
      blobs.push({ ref, data });
      const source: BlobRef = { type: "blob", media_type: o.source.media_type, ref, bytes: data.length };
      return { ...o, source };
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      const y = walk(x);
      if (y !== x) changed = true;
      out[k] = y;
    }
    return changed ? out : v;
  };
  return { payload: walk(payload) as T, blobs };
}

/** The reverse: every blob reference becomes the base64 block it was. A missing blob becomes a
 *  text block naming it, so a session with a lost attachment still loads. */
export async function rehydrateBlobs<T>(payload: T, readBlob: (ref: string) => Promise<Uint8Array | null>): Promise<T> {
  const walk = async (v: unknown): Promise<unknown> => {
    if (Array.isArray(v)) return Promise.all(v.map(walk));
    if (!v || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    if ((o.type === "image" || o.type === "document") && isBlobRef(o.source)) {
      const data = await readBlob(o.source.ref);
      if (!data) return { type: "text", text: `[attachment missing: ${o.type} ${o.source.media_type}, ${o.source.bytes} bytes, ${o.source.ref.slice(0, 12)}]` };
      return { ...o, source: { type: "base64", media_type: o.source.media_type, data: Buffer.from(data).toString("base64") } };
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = await walk(x);
    return out;
  };
  return (await walk(payload)) as T;
}

/** Does the payload hold any blob reference? Lets a reader skip the async walk for the common case. */
export function hasBlobRefs(payload: unknown): boolean {
  let found = false;
  const walk = (v: unknown): void => {
    if (found || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (isBlobRef(o.source)) {
      found = true;
      return;
    }
    for (const x of Object.values(o)) walk(x);
  };
  walk(payload);
  return found;
}
