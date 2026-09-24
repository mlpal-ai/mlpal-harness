import { existsSync, statSync } from "node:fs";
import type { SandboxSpec } from "./spec";

/**
 * Linux enforcement: bubblewrap. The whole filesystem is bound read-only, the writable roots
 * are re-bound read-write, unreadable directories are shadowed by an empty tmpfs and
 * unreadable files by /dev/null. `none` unshares the network namespace.
 *
 * `allowlist` on Linux is proxy-env only in v1: an unshared namespace would also cut the
 * loopback path to the proxy, so the process keeps the host network and is handed the proxy
 * variables. Tools that honour them are confined; the sandbox report says so.
 */

export function bwrapArgv(bwrap: string, spec: SandboxSpec, argv: string[]): string[] {
  const args = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"];
  for (const w of spec.filesystem.writable) {
    if (existsSync(w)) args.push("--bind", w, w);
  }
  for (const u of spec.filesystem.unreadable) {
    if (!existsSync(u)) continue;
    if (statSync(u).isDirectory()) args.push("--tmpfs", u);
    else args.push("--ro-bind", "/dev/null", u);
  }
  if (spec.network.mode === "none") args.push("--unshare-net");
  return [...args, "--", ...argv];
}
