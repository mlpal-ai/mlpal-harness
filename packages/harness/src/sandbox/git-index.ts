/**
 * Ruling R22g: the git index of a confined run's workspace never names a path inside `.git`.
 *
 * `objects` and `index` are writable (commits need them), so a confined command can store a blob and an index entry
 * whose path is `.git/config`. git refuses to add such an entry, but not to check one out: the person's later
 * `git checkout -- .`, `git restore .` or `git checkout-index -a -f` writes the blob over the real `.git/config`,
 * and the next `git status` runs what it names. After a confined command the sandbox reads the index with git
 * itself (inside the sandbox, with nothing a configuration names enabled) and rewrites it without such entries.
 */
import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** Unicode code points HFS+ ignores in a file name, so `.g‌it` is `.git` there (git's own `is_hfs_dotgit`). */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

/**
 * Whether a path, as an index entry names it, has a component a filesystem would resolve to `.git`: `.git` in any
 * case, with the characters HFS+ ignores, with the trailing dots and spaces or the `:stream` NTFS drops, or as the
 * 8.3 short name `git~1`. Backslashes separate components too (Windows-style tooling).
 */
export function namesDotGit(path: string): boolean {
  return path.split(/[\\/]/).some((part) => {
    const name = part.replace(HFS_IGNORABLE, "").toLowerCase().split(":")[0]!.replace(/[. ]+$/, "");
    return name === ".git" || /^git~\d+$/.test(name);
  });
}

/** One git run: argv after `git`, optional stdin and extra environment; the exit code and stdout. */
export type GitRun = (args: string[], o?: { stdin?: Buffer; env?: Record<string, string> }) => { code: number; stdout: Buffer };

/** Nothing a configuration names runs while the sandbox itself reads or rewrites an index, and no system
 *  configuration is read (one that includes a `~` path fails outright without a HOME). */
const QUIET = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.pager=cat"];
const QUIET_ENV = { GIT_CONFIG_NOSYSTEM: "1" };

/**
 * Rewrite `<gitDir>/index` without the entries `namesDotGit` catches; answers their paths (empty when there are
 * none, or when git cannot read the index: git then cannot check it out either). The other entries keep their mode,
 * object and stage; their cached stat data is dropped, so git re-reads those files once.
 */
export function scrubIndex(gitDir: string, git: GitRun): string[] {
  const root = dirname(gitDir);
  const listed = git(["-C", root, ...QUIET, "ls-files", "-s", "-z"], { env: QUIET_ENV });
  if (listed.code !== 0) return [];
  // each record: "<mode> <object> <stage>\t<path>", NUL-terminated; latin1 keeps every byte of the path
  const records = listed.stdout.toString("latin1").split("\0").filter(Boolean);
  const pathOf = (record: string) => Buffer.from(record.slice(record.indexOf("\t") + 1), "latin1").toString("utf8");
  const bad = records.filter((r) => namesDotGit(pathOf(r)));
  if (bad.length === 0) return [];
  const tmp = join(gitDir, `index.r22g-${process.pid}`);
  const env = { ...QUIET_ENV, GIT_INDEX_FILE: tmp };
  const kept = Buffer.from(records.filter((r) => !bad.includes(r)).map((r) => `${r}\0`).join(""), "latin1");
  const built = git(["-C", root, ...QUIET, "read-tree", "--empty"], { env }).code === 0 && git(["-C", root, ...QUIET, "update-index", "-z", "--index-info"], { stdin: kept, env }).code === 0;
  if (built) renameSync(tmp, join(gitDir, "index"));
  else {
    // the clean index could not be built: no index is safer than this one (git rebuilds it from HEAD on `git reset`)
    rmSync(tmp, { force: true });
    rmSync(join(gitDir, "index"), { force: true });
  }
  return bad.map((r) => `the index entry ${JSON.stringify(pathOf(r))} of ${root}`);
}

/** The index's content digest, or null when there is none: the scan runs only when it changed since it was clean. */
export function indexDigest(gitDir: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(join(gitDir, "index"))).digest("hex");
  } catch {
    return null;
  }
}
