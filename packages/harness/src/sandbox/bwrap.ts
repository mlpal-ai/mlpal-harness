import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitEntryWritable, type SandboxSpec } from "./spec";

/**
 * Linux enforcement: bubblewrap. The whole filesystem is bound read-only, the writable roots
 * are re-bound read-write, unreadable directories are shadowed by an empty tmpfs and
 * unreadable files by /dev/null. `none` unshares the network namespace.
 *
 * R22, R22b: a protected path that exists is bound read-only over its writable root. A root's `.git` directory is bound
 * onto itself (a mount point cannot be moved aside) and every entry in it that ordinary git work does not write
 * (`gitEntryWritable`) is bound read-only; a `.git` that is a file (a worktree's pointer) is bound read-only whole.
 * A path that does not exist cannot be mounted over without creating it in the person's workspace, so bubblewrap does
 * not stop its creation: the sandbox takes it back when the command ends (`revertCreated`, R22d).
 */

export function bwrapArgv(bwrap: string, spec: SandboxSpec, argv: string[]): string[] {
  const args = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"];
  for (const w of spec.filesystem.writable) {
    if (existsSync(w)) args.push("--bind", w, w);
  }
  for (const g of spec.filesystem.gitDirs) {
    if (!existsSync(g)) continue;
    if (!statSync(g).isDirectory()) {
      args.push("--ro-bind", g, g);
      continue;
    }
    args.push("--bind", g, g);
    for (const name of readdirSync(g).sort()) if (!gitEntryWritable(name)) args.push("--ro-bind", join(g, name), join(g, name));
  }
  for (const p of spec.filesystem.protected) {
    if (existsSync(p)) args.push("--ro-bind", p, p);
  }
  for (const u of spec.filesystem.unreadable) {
    if (!existsSync(u)) continue;
    if (statSync(u).isDirectory()) args.push("--tmpfs", u);
    else args.push("--ro-bind", "/dev/null", u);
  }
  if (spec.network.mode === "none") args.push("--unshare-net");
  return [...args, "--", ...argv];
}
