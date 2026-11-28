import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { DISPLAY_LIMITS, imageInfo, sniffMedia, type DisplayErrorCode, type MediaFacts, type MediaFactsMap, type MediaProbeResult } from "@mlpal/harness-protocol";
import { contextRoots, resolveInRoots, type ToolContext } from "../tools/types";

/**
 * The media pipeline's filesystem half (DISPLAY-PROTOCOL-v0.1-media §1.3, steps 1-8): for each path a media Show or
 * GenerateImage names, what is there, read from one file descriptor. The protocol's checkMediaSpec judges the facts;
 * nothing here decides what a kind takes.
 *
 * 1. lexical: no NUL, at most 4,096 characters, no scheme (PATH_NOT_ALLOWED);
 * 2. the jail: inside the run's roots after symlinks are resolved (resolveInRoots, as the file tools), and under the
 *    workspace root, the first root, which the daemon serves (PATH_OUTSIDE_WORKSPACE);
 * 3. hidden: `.git` at any depth, `.mlpal*` at the root, on the given and on the real path (PATH_NOT_ALLOWED);
 * 4. open with O_NOFOLLOW and O_NONBLOCK, a regular file (MEDIA_NOT_FOUND, MEDIA_NOT_REGULAR);
 * 5. its size from fstat, before any read (MEDIA_TOO_LARGE at the caller's cap);
 * 6. the type from the first bytes' magic number, and an image's sides from its header (no decode);
 * 7. sha256 over the same descriptor, and the size and mtime again (MEDIA_CHANGED).
 * Never logs a path's contents; never reads past the cap.
 */

export interface MediaRequest {
  /** As the model or the tool wrote it. */
  path: string;
  /** The most bytes this file may have: larger is MEDIA_TOO_LARGE, and nothing is read. */
  maxBytes: number;
}

export interface MediaProbe {
  probe(requests: MediaRequest[], ctx: ToolContext): Promise<MediaFactsMap>;
}

const HEAD_BYTES = 256 * 1024;
const CHUNK = 1024 * 1024;

const fault = (code: DisplayErrorCode, message: string, hint?: string): MediaProbeResult => ({ code, message, ...(hint ? { hint } : {}) });

/** Whether a workspace-relative POSIX path is hidden from the person's file view (the daemon's rule). */
function hidden(rel: string): boolean {
  const parts = rel.split("/");
  return parts.includes(".git") || (parts[0] ?? "").startsWith(".mlpal");
}

const posix = (p: string) => p.split(sep).join("/");

/** Text a person could read: valid UTF-8 with no NUL (a file card names it text/plain). */
function utf8Text(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b.length === 256 * 1024 ? b.subarray(0, b.length - 4) : b);
    return true;
  } catch {
    return false;
  }
}

/** One path, as above. Exported for GenerateImage's references and its written files. */
export function probeMedia(req: MediaRequest, ctx: ToolContext): MediaProbeResult {
  const p = req.path;
  if (p.length === 0 || p.length > DISPLAY_LIMITS.media.pathChars || p.includes("\0")) return fault("PATH_NOT_ALLOWED", "a media path is 1 to 4,096 characters with no NUL");
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|\\\\)/.test(p)) return fault("URL_NOT_ALLOWED", "a media source is a workspace path, never a URL");
  const resolved = resolveInRoots(ctx, p);
  if ("error" in resolved) return fault("PATH_OUTSIDE_WORKSPACE", `${p} is outside the workspace`, "save the file in the workspace (media/ for what you make) and give its path");
  const workspace = contextRoots(ctx)[0]!;
  const rel = relative(workspace, resolved.path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return fault("PATH_OUTSIDE_WORKSPACE", `${p} is outside the workspace`, "save the file in the workspace (media/ for what you make) and give its path");
  const path = posix(rel);
  if (hidden(path)) return fault("PATH_NOT_ALLOWED", `${path} is a hidden path (.git, .mlpal*)`);
  let real: string;
  try {
    real = realpathSync(resolved.path);
  } catch {
    return fault("MEDIA_NOT_FOUND", `no file at ${path}`, "check the path: list the folder, or save the file first");
  }
  let realWorkspace = workspace;
  try {
    realWorkspace = realpathSync(workspace);
  } catch {
    // the root's own realpath unreadable: keep it as given; resolveInRoots already checked the jail
  }
  const realRel = relative(realWorkspace, real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) return fault("PATH_OUTSIDE_WORKSPACE", `${path} links outside the workspace`);
  if (hidden(posix(realRel))) return fault("PATH_NOT_ALLOWED", `${path} links to a hidden path (.git, .mlpal*)`);
  let fd: number;
  try {
    fd = openSync(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fault("MEDIA_NOT_FOUND", `no file at ${path}`);
    return fault("MEDIA_NOT_REGULAR", `${path} is not a regular file${code === "ELOOP" ? " (a symbolic link)" : ""}`, "give the path of the file itself");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return fault("MEDIA_NOT_REGULAR", `${path} is not a regular file`, "give the path of a file, not a folder");
    if (st.size > req.maxBytes) return fault("MEDIA_TOO_LARGE", `${path} is ${st.size} bytes; at most ${req.maxBytes} here`, "save a smaller or more compressed version");
    const head = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
    const got = head.length ? readSync(fd, head, 0, head.length, 0) : 0;
    const first = new Uint8Array(head.buffer, head.byteOffset, got);
    const mime = sniffMedia(first) ?? (utf8Text(first) ? "text/plain" : "application/octet-stream");
    const info = mime.startsWith("image/") && mime !== "image/svg+xml" ? imageInfo(first, mime) : null;
    const hash = createHash("sha256");
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, st.size)));
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, total);
      if (n === 0) break;
      total += n;
      if (total > req.maxBytes) return fault("MEDIA_CHANGED", `${path} grew while it was checked`, "show it again once it is written");
      hash.update(buf.subarray(0, n));
    }
    const after = fstatSync(fd);
    if (total !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) return fault("MEDIA_CHANGED", `${path} changed while it was checked`, "show it again once it is written");
    const facts: MediaFacts = { path, mime, bytes: st.size, sha256: hash.digest("hex"), ...(info ? { width: info.width, height: info.height, animated: info.animated, ...(info.gps !== undefined ? { gps: info.gps } : {}) } : {}) };
    return facts;
  } catch {
    return fault("MEDIA_UNREADABLE", `${path} could not be read`);
  } finally {
    closeSync(fd);
  }
}

/** The probe for a run whose workspace is this machine's filesystem. */
export const localMediaProbe: MediaProbe = {
  async probe(requests, ctx) {
    const out = new Map<string, MediaProbeResult>();
    for (const r of requests) if (!out.has(r.path)) out.set(r.path, probeMedia(r, ctx));
    return out;
  },
};
