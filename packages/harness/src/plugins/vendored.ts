import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * "Vendored by the image": the file-ownership test of the W3-1 home trust rule (feat/hop-home
 * `display/home-trust.ts`, `vendored()`), as one function both may call. The image's files are root's and writable by
 * no group or other (the workspace image's Dockerfile `chown -R root:root … chmod -R a+rX,go-w`), while anything the
 * person or a command run as them writes is theirs. So a tree is the image's only when the directory and everything
 * under it are owned by root and writable by no group or other, and this process is not root (as root, everything
 * would pass). Anything that cannot be checked is not vendored. Nothing a tree says about itself counts.
 *
 * At merge, home-trust's `vendored()` calls this with `withParent: true` (a HOP's version directory sits in a
 * root-owned name directory) instead of keeping its own walk; plugins call it with the default (a pack's parent,
 * ~/.yodex/plugins, is the person's: web installs land there).
 */
export type VendoredCheck = { vendored: true } | { vendored: false; why: string };

export interface VendoredOptions {
  /** Also require the directory's parent to pass. */
  withParent?: boolean;
  /** This process's uid; default process.getuid(). */
  uid?: number;
  /** Owner and mode of a path (after links); default fs.statSync. */
  stat?: (path: string) => { uid: number; mode: number };
}

const MAX_TREE_ENTRIES = 5_000;

export function vendoredTree(dir: string, opts: VendoredOptions = {}): VendoredCheck {
  const uid = opts.uid ?? process.getuid?.();
  if (uid === undefined) return { vendored: false, why: "file ownership cannot be checked on this platform" };
  if (uid === 0) return { vendored: false, why: "the engine runs as root, so root-owned files say nothing about who put them there" };
  const stat = opts.stat ?? ((path: string) => statSync(path));
  let root: string;
  let entries: string[];
  try {
    root = realpathSync(dir);
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return { vendored: false, why: "the directory cannot be read" };
  }
  if (entries.length > MAX_TREE_ENTRIES) return { vendored: false, why: `over ${MAX_TREE_ENTRIES} files` };
  for (const path of [...(opts.withParent ? [dirname(root)] : []), root, ...entries.map((e) => join(root, e))]) {
    let s: { uid: number; mode: number };
    try {
      s = stat(path);
    } catch {
      return { vendored: false, why: `${path} cannot be checked` };
    }
    if (s.uid !== 0 || (s.mode & 0o022) !== 0) return { vendored: false, why: "written by this user, not vendored by the image" };
  }
  return { vendored: true };
}
