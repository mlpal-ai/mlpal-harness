import { existsSync } from "node:fs";
import { registerSecrets } from "../obs/redact";
import type { ExecPolicy } from "../tools/types";
import { bwrapArgv } from "./bwrap";
import { scrubEnv } from "./env";
import { type AllowlistProxy, proxyEnv, startAllowlistProxy } from "./proxy";
import { SANDBOX_EXEC, seatbeltArgv } from "./seatbelt";
import type { SandboxSpec } from "./spec";

export * from "./spec";
export { isSecretName, scrubEnv } from "./env";
export { seatbeltProfile } from "./seatbelt";
export { bwrapArgv } from "./bwrap";
export { startAllowlistProxy, type AllowlistProxy } from "./proxy";

/**
 * The sandbox a run hands its command-running tools (Bash, background tasks, monitors) as
 * their ExecPolicy. `wrap` adds the OS confinement, `env` returns the scrubbed environment
 * plus the proxy variables. When the platform cannot confine (no bwrap, an unsupported OS)
 * the sandbox is `available: false` with a reason: the host decides whether that fails the
 * run (`spec.required`) or degrades to scrub + redaction with a visible notice.
 */
export interface Sandbox extends ExecPolicy {
  spec: SandboxSpec;
  /** Which OS mechanism confines commands; null when none could. */
  platform: "seatbelt" | "bwrap" | null;
  available: boolean;
  /** Why `available` is false. */
  reason?: string;
  /** Environment variable names removed from every command's environment. */
  scrubbed: string[];
  /** Hosts the allowlist proxy refused, in order. Empty unless network.mode is "allowlist". */
  deniedHosts: string[];
  /** One line for the session notice. */
  describe(): string;
  close(): void;
}

export interface CreateSandboxOptions {
  platform?: NodeJS.Platform;
  /** Path to bubblewrap; null forces "unavailable" on Linux. Default: `bwrap` on PATH. */
  bwrapPath?: string | null;
  /** Prove bubblewrap can actually confine here, not only that the binary exists. Default: spawn
   *  one trivial command under the same namespaces the real wrap uses. Ubuntu 24.04 ships bwrap
   *  but blocks unprivileged user namespaces (apparmor_restrict_unprivileged_userns=1), so the
   *  binary is present, every wrapped command dies with "setting up uid map: Permission denied",
   *  and a check on PATH alone reported the sandbox active (memory v13 experiment, F1). */
  bwrapProbe?: (bwrap: string) => { ok: boolean; detail?: string };
  /** The environment to scrub; default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  onDeniedHost?: (host: string) => void;
}

/** Run one trivial command under bubblewrap with the namespaces the real wrap needs. A kernel or
 *  policy that forbids them fails here, once, instead of on every Bash call of the run. */
export function probeBwrap(bwrap: string): { ok: boolean; detail?: string } {
  try {
    const r = Bun.spawnSync([bwrap, "--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/true"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    if (r.exitCode === 0) return { ok: true };
    const err = new TextDecoder().decode(r.stderr).trim().split("\n")[0] ?? "";
    return { ok: false, detail: err || `exit ${r.exitCode}` };
  } catch (e) {
    return { ok: false, detail: String((e as Error)?.message ?? e) };
  }
}

/** The known cause and its fix, when the probe's error names it. */
export function bwrapHint(detail: string | undefined): string {
  if (!detail) return "";
  if (/uid map|user namespace|unshare/i.test(detail))
    return " — unprivileged user namespaces are disabled (Ubuntu 24.04: kernel.apparmor_restrict_unprivileged_userns=1); run `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0` or install an AppArmor profile for bwrap";
  return "";
}

export function createSandbox(spec: SandboxSpec, opts: CreateSandboxOptions = {}): Sandbox {
  const platform = opts.platform ?? process.platform;
  const scrub = scrubEnv(opts.baseEnv ?? process.env, spec.env.keep);
  // Whatever was scrubbed is also masked if it surfaces through any other path.
  registerSecrets(scrub.removed);

  let proxy: AllowlistProxy | undefined;
  if (spec.network.mode === "allowlist") proxy = startAllowlistProxy(spec.network.allow, { onDeny: opts.onDeniedHost });
  const env = { ...scrub.env, ...(proxy ? proxyEnv(proxy) : {}) };

  let wrap: (argv: string[]) => string[] = (argv) => argv;
  let confined: "seatbelt" | "bwrap" | null = null;
  let reason: string | undefined;
  if (platform === "darwin") {
    if (existsSync(SANDBOX_EXEC)) {
      confined = "seatbelt";
      wrap = (argv) => seatbeltArgv(spec, argv);
    } else reason = `${SANDBOX_EXEC} is missing`;
  } else if (platform === "linux") {
    const bwrap = opts.bwrapPath === undefined ? Bun.which("bwrap") : opts.bwrapPath;
    if (bwrap) {
      const probe = (opts.bwrapProbe ?? probeBwrap)(bwrap);
      if (probe.ok) {
        confined = "bwrap";
        wrap = (argv) => bwrapArgv(bwrap, spec, argv);
      } else reason = `bubblewrap is installed but cannot confine here: ${probe.detail ?? "the probe command failed"}${bwrapHint(probe.detail)}`;
    } else reason = "bubblewrap (bwrap) is not installed";
  } else {
    reason = `no sandbox for ${platform}`;
  }

  const describe = () => {
    const fs = spec.filesystem.mode === "readOnly" ? "read-only filesystem" : "writes inside the workspace";
    const net =
      spec.network.mode === "none"
        ? "no network"
        : spec.network.mode === "allowlist"
          ? `network to ${spec.network.allow.join(", ") || "nothing"}${confined === "bwrap" || !confined ? " (proxy env only)" : ""}`
          : "network open";
    const creds = `${spec.filesystem.unreadable.length} credential paths unreadable`;
    const envs = scrub.scrubbed.length ? `${scrub.scrubbed.length} secret env vars scrubbed` : "no secret env vars";
    const how = confined ? confined : `NOT confined: ${reason}`;
    return `sandbox: ${how}; ${fs}, ${net}, ${creds}, ${envs}`;
  };

  return {
    spec,
    platform: confined,
    available: confined !== null,
    reason,
    scrubbed: scrub.scrubbed,
    deniedHosts: proxy?.denied ?? [],
    wrap,
    env: () => env,
    describe,
    close: () => proxy?.close(),
  };
}
