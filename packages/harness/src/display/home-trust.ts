import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HopUi } from "../profile/ui";
import type { Profile } from "../profile/types";

/**
 * W3-1, controller ruling 2026-11-28: a home script runs when a page opens, with no model and no approval card, as the
 * person. So it runs only for a HOP whose origin makes it the person's or the platform's own code. The origin is read
 * from what the loader and the filesystem already say, never from anything a HOP declares about itself:
 *
 * - `builtin`: compiled into the engine (Profile.source "builtin"). Trusted (a builtin declares no ui today).
 * - `path`: loaded from a directory (Profile.source "path"). Trusted only when the person named it on the command line
 *   that started this process (`--hop <dir>`): the caller says so (`pathNamedByPerson`). A path that arrived any other
 *   way (a child serve started by a front, a project setting) is not trusted.
 * - `user` (`~/.yodex/hops/<name>/<version>/`): the workspace image vendors its HOPs here, and `yodex hop install`
 *   puts catalog HOPs here too, so the source alone cannot tell them apart. What can: the image's files are root's and
 *   read-only (mlpal-workspace-image Dockerfile: `chown -R root:root … chmod -R a+rX,go-w ~/.yodex/hops`, checked by its
 *   smoke test), while an install writes them as the person. Trusted only when the HOP's directory, its parent and
 *   everything under it (a script may import any file of its HOP) are owned by root and writable by no group or other,
 *   and this process is not root (as root, everything would pass).
 * - `project` (`<workspace>/.yodex/hops/`): may arrive with a cloned repository. Not trusted.
 *
 * Anything that cannot be checked (no uid on this platform, a file that cannot be stat'ed) is not trusted.
 */

export type HomeTrust = { trusted: true; why: "builtin" | "local_dir" | "vendored" } | { trusted: false; why: string };

export interface HomeTrustOptions {
  /** The HOP's directory was named on the command line that started this process (`--hop <dir>`). Default false. */
  pathNamedByPerson?: boolean;
  /** This process's uid; default process.getuid(). */
  uid?: number;
  /** Owner and mode of a path (after links); default fs.statSync. */
  stat?: (path: string) => { uid: number; mode: number };
}

/** A vendored HOP is a few dozen files; past this many entries the tree is not walked, and not trusted. */
const MAX_TREE_ENTRIES = 5_000;

export function homeTrust(p: Pick<Profile, "source" | "dir"> & { ui?: HopUi }, opts: HomeTrustOptions = {}): HomeTrust {
  switch (p.source) {
    case "builtin":
      return { trusted: true, why: "builtin" };
    case "path":
      return opts.pathNamedByPerson === true ? { trusted: true, why: "local_dir" } : { trusted: false, why: "a HOP loaded by path that this process's own command line did not name" };
    case "project":
      return { trusted: false, why: "a HOP found in the workspace's .yodex/hops, which may come with a cloned repository" };
    case "user":
      return vendored(p.dir, opts);
  }
}

function vendored(dir: string | null, opts: HomeTrustOptions): HomeTrust {
  const uid = opts.uid ?? process.getuid?.();
  if (uid === undefined) return { trusted: false, why: "file ownership cannot be checked on this platform" };
  if (uid === 0) return { trusted: false, why: "the engine runs as root, so root-owned files say nothing about where a HOP came from" };
  if (!dir) return { trusted: false, why: "the HOP has no directory" };
  const stat = opts.stat ?? ((path: string) => statSync(path));
  let root: string;
  let entries: string[];
  try {
    root = realpathSync(dir);
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return { trusted: false, why: "the HOP's directory cannot be read" };
  }
  if (entries.length > MAX_TREE_ENTRIES) return { trusted: false, why: `the HOP has over ${MAX_TREE_ENTRIES} files` };
  for (const path of [dirname(root), root, ...entries.map((e) => join(root, e))]) {
    let s: { uid: number; mode: number };
    try {
      s = stat(path);
    } catch {
      return { trusted: false, why: `${path} cannot be checked` };
    }
    if (s.uid !== 0 || (s.mode & 0o022) !== 0) return { trusted: false, why: "installed under ~/.yodex/hops by this user (the catalog), not vendored by the image" };
  }
  return { trusted: true, why: "vendored" };
}
