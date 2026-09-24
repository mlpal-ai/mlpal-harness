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
  /** The environment to scrub; default process.env. */
  baseEnv?: NodeJS.ProcessEnv;
  onDeniedHost?: (host: string) => void;
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
      confined = "bwrap";
      wrap = (argv) => bwrapArgv(bwrap, spec, argv);
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
