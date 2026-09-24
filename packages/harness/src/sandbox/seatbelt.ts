import type { SandboxSpec } from "./spec";

/**
 * macOS enforcement: a Seatbelt profile handed to /usr/bin/sandbox-exec. The profile starts
 * from `allow default` and subtracts — writes outside the writable roots, reads of credential
 * paths, and (by network mode) everything but loopback — so a command keeps every ordinary
 * capability and loses exactly what the spec names.
 *
 * Seatbelt cannot filter outbound connections by host name; the allowlist mode therefore
 * confines the process to loopback and the proxy (proxy.ts) does the host check.
 */

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function lit(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function seatbeltProfile(spec: SandboxSpec): string {
  const lines: string[] = ["(version 1)", "(allow default)"];

  lines.push("(deny file-write*)");
  for (const w of spec.filesystem.writable) lines.push(`(allow file-write* (subpath ${lit(w)}))`);
  // Terminals, pipes and the null device are not "the estate".
  lines.push(
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/pty"))',
  );
  // Process-scoped state: without these, `bash` itself and any `mkdir -p $TMPDIR` fail.
  lines.push('(allow file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/(T|C)/"))');
  lines.push('(allow file-write* (regex #"^/private/var/run/"))');

  for (const u of spec.filesystem.unreadable) lines.push(`(deny file-read* (literal ${lit(u)}) (subpath ${lit(u)}))`);

  switch (spec.network.mode) {
    case "none":
      lines.push("(deny network*)");
      lines.push("(allow network* (local unix-socket) (remote unix-socket))");
      break;
    case "allowlist":
      lines.push("(deny network*)");
      // Loopback only, split by direction: a `network*` rule with a `local ip` filter also
      // admits outbound connects (the local address is unbound at connect time), which is
      // exactly the escape this mode exists to close. Inbound/bind for dev servers and local
      // databases; outbound only to loopback — the proxy does the host check.
      lines.push('(allow network-bind network-inbound (local ip "localhost:*"))');
      lines.push('(allow network-outbound (remote ip "localhost:*"))');
      // Unix sockets: ssh-agent, docker, gpg-agent, mDNSResponder.
      lines.push("(allow network* (local unix-socket) (remote unix-socket))");
      break;
    case "all":
      break;
  }
  return `${lines.join("\n")}\n`;
}

export function seatbeltArgv(spec: SandboxSpec, argv: string[]): string[] {
  return [SANDBOX_EXEC, "-p", seatbeltProfile(spec), ...argv];
}
