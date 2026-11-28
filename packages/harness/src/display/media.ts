import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DISPLAY_LIMITS, imageInfo, sniffMedia, type DisplayErrorCode, type MediaFacts, type MediaFactsMap, type MediaProbeFault, type MediaProbeResult } from "@mlpal/harness-protocol";
import { foldName } from "../permission/names";
import { contextRoots, resolveInRoots, type ToolContext } from "../tools/types";

/**
 * The media pipeline's filesystem half (DISPLAY-PROTOCOL-v0.1-media §1.3, steps 1-8): for each path a media Show or
 * GenerateImage names, what is there, read from one file descriptor. The protocol's checkMediaSpec judges the facts;
 * nothing here decides what a kind takes.
 *
 * 1. lexical: no NUL, at most 4,096 characters, no scheme (PATH_NOT_ALLOWED);
 * 2. the jail: inside the run's roots after symlinks are resolved (resolveInRoots, as the file tools), and under the
 *    workspace root, the first root, which the daemon serves (PATH_OUTSIDE_WORKSPACE);
 * 3. hidden: `.git` at any depth, `.mlpal*` at the root, on the path (which has no link on it: step 5) (PATH_NOT_ALLOWED);
 * 4. open once, the workspace's real path joined with the relative path, with O_NONBLOCK (a FIFO never blocks), and a
 *    regular file by fstat (MEDIA_NOT_FOUND, MEDIA_NOT_REGULAR);
 * 5. what the descriptor is, not what the path names now (review R3): no link anywhere on the path, so the lexical
 *    jail and hidden checks are exact. The kernel says so: macOS opens with O_NOFOLLOW_ANY; Linux reads the
 *    descriptor's own path from /proc/self/fd. Anywhere else nothing is admitted;
 * 6. its size from fstat, before any read (MEDIA_TOO_LARGE at the caller's cap);
 * 7. the type from the first bytes' magic number, and an image's sides from its header (no decode);
 * 8. sha256 over the same descriptor, and the size and mtime again (MEDIA_CHANGED). With `keep`, the bytes hashed
 *    are returned, so a caller that sends them (GenerateImage's references) never opens the path a second time.
 * Never logs a path's contents; never reads past the cap.
 */

export interface MediaRequest {
  /** As the model or the tool wrote it. */
  path: string;
  /** The most bytes this file may have: larger is MEDIA_TOO_LARGE, and nothing is read. */
  maxBytes: number;
}

/** The facts and the very bytes they were taken from (`readMedia`). */
export type MediaRead = { facts: MediaFacts; bytes: Uint8Array } | MediaProbeFault;

export interface MediaProbe {
  probe(requests: MediaRequest[], ctx: ToolContext): Promise<MediaFactsMap>;
}

const HEAD_BYTES = 256 * 1024;
const CHUNK = 1024 * 1024;

const fault = (code: DisplayErrorCode, message: string, hint?: string): MediaProbeFault => ({ code, message, ...(hint ? { hint } : {}) });

/** Whether a workspace-relative POSIX path is hidden from the person's file view (the daemon's rule). */
function hidden(rel: string): boolean {
  // compared as a case-insensitive, normalising file system would resolve it (`.GIT`, `.Mlpal-state`)
  const parts = foldName(rel).split("/");
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

/** One path, as above. Exported for GenerateImage's written files. */
export function probeMedia(req: MediaRequest, ctx: ToolContext): MediaProbeResult {
  const r = inspect(req, ctx, false);
  return "code" in r ? r : r.facts;
}

/** One path, as above, with the bytes it hashed (at most `maxBytes`): what GenerateImage sends as a reference. */
export function readMedia(req: MediaRequest, ctx: ToolContext): MediaRead {
  return inspect(req, ctx, true);
}

function inspect(req: MediaRequest, ctx: ToolContext, keep: boolean): MediaRead {
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
  let expected: string;
  try {
    expected = join(realpathSync(workspace), rel);
  } catch {
    return fault("MEDIA_UNREADABLE", `${path} could not be read`);
  }
  let fd: number;
  try {
    fd = openSync(expected, constants.O_RDONLY | constants.O_NONBLOCK | (NOFOLLOW_ANY || constants.O_NOFOLLOW));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return fault("MEDIA_NOT_FOUND", `no file at ${path}`, "check the path: list the folder, or save the file first");
    return fault("MEDIA_NOT_REGULAR", `${path} is not a regular file${code === "ELOOP" ? " (a symbolic link is on its path)" : ""}`, "give the path of the file itself, with no link on the way");
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return fault("MEDIA_NOT_REGULAR", `${path} is not a regular file`, "give the path of a file, not a folder");
    if (!isWhatWasOpened(fd, expected)) return fault("MEDIA_CHANGED", `${path} moved, or a link is on its path`, "give the path of the file itself, with no link on the way");
    if (st.size > req.maxBytes) return fault("MEDIA_TOO_LARGE", `${path} is ${st.size} bytes; at most ${req.maxBytes} here`, "save a smaller or more compressed version");
    const head = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
    const got = head.length ? readSync(fd, head, 0, head.length, 0) : 0;
    const first = new Uint8Array(head.buffer, head.byteOffset, got);
    const mime = sniffMedia(first) ?? (utf8Text(first) ? "text/plain" : "application/octet-stream");
    const info = mime.startsWith("image/") && mime !== "image/svg+xml" ? imageInfo(first, mime) : null;
    const hash = createHash("sha256");
    // with `keep`, one buffer the file's size (at most the cap) that the hash reads into; otherwise a 1 MiB window
    const buf = Buffer.alloc(keep ? st.size + 1 : Math.min(CHUNK, Math.max(1, st.size)));
    let total = 0;
    for (;;) {
      const n = keep ? readSync(fd, buf, total, buf.length - total, total) : readSync(fd, buf, 0, buf.length, total);
      if (n === 0) break;
      if (!keep) hash.update(buf.subarray(0, n));
      total += n;
      if (total > req.maxBytes || total > st.size) return fault("MEDIA_CHANGED", `${path} grew while it was checked`, "show it again once it is written");
    }
    // the window is reused when the bytes are not kept: only a kept buffer holds the whole file (review R9)
    const bytes = keep ? new Uint8Array(buf.buffer, buf.byteOffset, total) : new Uint8Array(0);
    if (keep) hash.update(bytes);
    const after = fstatSync(fd);
    if (total !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) return fault("MEDIA_CHANGED", `${path} changed while it was checked`, "show it again once it is written");
    const facts: MediaFacts = { path, mime, bytes: st.size, sha256: hash.digest("hex"), ...(info ? { width: info.width, height: info.height, animated: info.animated, ...(info.gps !== undefined ? { gps: info.gps } : {}) } : {}) };
    return { facts, bytes };
  } catch {
    return fault("MEDIA_UNREADABLE", `${path} could not be read`);
  } finally {
    closeSync(fd);
  }
}

/** macOS's O_NOFOLLOW_ANY (sys/fcntl.h, macOS 11+): the open fails with ELOOP on a link anywhere on the path. It
 *  replaces O_NOFOLLOW there: the two together are EINVAL (review R8). */
const NOFOLLOW_ANY = process.platform === "darwin" ? 0x20000000 : 0;

/**
 * Review R3: whether the descriptor is the file at `expected`, a path with no link on it. O_NOFOLLOW guards only the
 * last component, and any check by path after the open walks the path again (a directory swapped for a link in
 * between passes it), so the answer comes from the kernel: on macOS the open itself refused every link; on Linux
 * /proc/self/fd names what was opened. Anywhere else nothing can say, so nothing is admitted. Every read after this
 * is from the descriptor, so a later swap changes nothing.
 */
function isWhatWasOpened(fd: number, expected: string): boolean {
  if (NOFOLLOW_ANY) return true;
  if (process.platform === "linux") {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === expected;
    } catch {
      return false;
    }
  }
  return false;
}

/** The probe for a run whose workspace is this machine's filesystem. */
export const localMediaProbe: MediaProbe = {
  async probe(requests, ctx) {
    const out = new Map<string, MediaProbeResult>();
    for (const r of requests) if (!out.has(r.path)) out.set(r.path, probeMedia(r, ctx));
    return out;
  },
};
