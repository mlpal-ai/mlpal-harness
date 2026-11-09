import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withinRoots } from "./types";

/** Where a shell command runs, and the note to show when that is not the folder it was given. */
export interface ShellCwd {
  cwd: string;
  note?: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function nearestExisting(p: string, keep: (dir: string) => boolean): string | undefined {
  for (let dir = dirname(resolve(p)); keep(dir); dir = dirname(dir)) {
    if (isDir(dir)) return dir;
    if (dirname(dir) === dir) return undefined;
  }
  return undefined;
}

/**
 * The folder a shell command runs in. A spawn into a folder that no longer exists fails with
 * ENOENT naming the shell itself (`posix_spawn '/bin/bash'`), so every later command of the
 * session would fail the same way. When `cwd` is gone the command runs instead in, by preference:
 * its nearest existing parent inside `roots`; the first existing root; its nearest existing parent
 * anywhere. When nothing exists, `cwd` is returned unchanged and the spawn reports the error.
 */
export function shellCwd(cwd: string, roots: readonly string[] = []): ShellCwd {
  if (isDir(cwd)) return { cwd };
  const fallback =
    (roots.length > 0 ? nearestExisting(cwd, (dir) => withinRoots(dir, [...roots])) : undefined) ??
    roots.find(isDir) ??
    nearestExisting(cwd, () => true);
  if (fallback === undefined) return { cwd };
  return { cwd: fallback, note: `[note: the working folder ${cwd} no longer exists; this command ran in ${fallback}]` };
}
