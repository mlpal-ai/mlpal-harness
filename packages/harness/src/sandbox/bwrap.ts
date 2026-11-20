import { existsSync, statSync } from "node:fs";
import { protectedParents, type SandboxSpec } from "./spec";

/**
 * Linux enforcement: bubblewrap. The whole filesystem is bound read-only, the writable roots
 * are re-bound read-write, unreadable directories are shadowed by an empty tmpfs and
 * unreadable files by /dev/null. `none` unshares the network namespace.
 *
 * R22: a protected path that exists is bound read-only over its writable root, and each directory above it inside the
 * root is bound onto itself, so it is a mount point and cannot be moved aside. One that does not exist cannot be
 * mounted over without creating it in the person's workspace, so its creation is not prevented here
 * (`unprotectedHere`); the file tools refuse it either way.
 *
 * `allowlist` on Linux is proxy-env only in v1: an unshared namespace would also cut the
 * loopback path to the proxy, so the process keeps the host network and is handed the proxy
 * variables. Tools that honour them are confined; the sandbox report says so. For the same reason the spec's denied
 * endpoints are refused only by the allowlist proxy here, and the host's loopback ports are unreachable under `none`
 * (a fresh namespace has its own loopback): both fail closed or are reported (`unenforcedDeny`), never silent.
 */

export function bwrapArgv(bwrap: string, spec: SandboxSpec, argv: string[]): string[] {
  const args = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"];
  for (const w of spec.filesystem.writable) {
    if (existsSync(w)) args.push("--bind", w, w);
  }
  for (const d of protectedParents(spec)) {
    if (existsSync(d) && statSync(d).isDirectory()) args.push("--bind", d, d);
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

/** The protected paths bubblewrap cannot keep read-only because they do not exist yet. */
export function unprotectedHere(spec: SandboxSpec): string[] {
  return spec.filesystem.protected.filter((p) => !existsSync(p));
}
