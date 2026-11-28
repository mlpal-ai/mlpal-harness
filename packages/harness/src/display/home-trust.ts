import { vendoredTree } from "../plugins/vendored";
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
  if (!dir) return { trusted: false, why: "the HOP has no directory" };
  const v = vendoredTree(dir, { withParent: true, ...(opts.uid !== undefined ? { uid: opts.uid } : {}), ...(opts.stat ? { stat: opts.stat } : {}) });
  if (v.vendored) return { trusted: true, why: "vendored" };
  return { trusted: false, why: v.byUser ? "installed under ~/.yodex/hops by this user (the catalog), not vendored by the image" : v.why };
}
