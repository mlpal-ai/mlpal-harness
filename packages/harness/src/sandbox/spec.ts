import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Execution sandbox — the SPEC. What a command the agent runs may touch once it runs, as
 * distinct from whether the agent may run it (the permission cascade decides that).
 *
 * A HOP declares the policy inputs under `safety.sandbox` (locked with the envelope, §10.3);
 * the host resolves them against the run's workspace roots into this concrete spec, and the
 * platform layer (seatbelt.ts on macOS, bwrap.ts on Linux) turns it into enforcement. The
 * network allowlist is enforced by a local proxy (proxy.ts) the sandboxed process is forced
 * through.
 */

export type FilesystemMode =
  /** Writes only inside the workspace roots, the scratch dirs and build caches. */
  | "workspace"
  /** No writes anywhere (recon HOPs): "the engine denies writes" becomes "the OS denies writes". */
  | "readOnly";

export type NetworkMode = "all" | "none" | "allowlist";

/** The HOP-authored block (hop.yaml `safety.sandbox`), every field optional. */
export interface SandboxPolicy {
  filesystem?: {
    mode?: FilesystemMode;
    /** Extra writable paths (absolute or ~-relative), e.g. a HOP that writes a deploy log. */
    allowWrite?: string[];
    /** Credential paths this HOP may read — an infra HOP lists ~/.aws, ~/.kube. Overrides the default denials. */
    allowRead?: string[];
    /** Extra unreadable paths beyond the defaults. */
    denyRead?: string[];
  };
  network?: {
    mode?: NetworkMode;
    /** Hosts for `allowlist`: exact ("api.github.com") or suffix wildcard ("*.mlpal.ai"). */
    allow?: string[];
  };
  env?: {
    /** Secret-looking variables the command may still see (a HOP that runs `aws` keeps AWS_*). */
    keep?: string[];
  };
  /** When the OS sandbox cannot start (unsupported platform, missing bwrap), fail the run
   *  closed instead of degrading to env scrub + redaction only. Default true for a HOP with a
   *  safety block, false otherwise. */
  required?: boolean;
}

/** The resolved, absolute spec the platform layer enforces. */
export interface SandboxSpec {
  filesystem: {
    mode: FilesystemMode;
    /** Absolute writable roots (workspace roots + scratch + caches + allowWrite). Empty when readOnly. */
    writable: string[];
    /** Absolute paths (dirs or files) the process may not read. */
    unreadable: string[];
  };
  network: {
    mode: NetworkMode;
    allow: string[];
    /** Loopback ports the host serves to commands (D-55: the kube credential proxies): reachable in every mode. */
    hostPorts: number[];
    /** Endpoints (`host:port`) no command may reach in any mode (D-55: a governed cluster's real API server, which
     *  commands reach only through the host's proxy). The allowlist proxy refuses them everywhere; the OS layer also
     *  refuses a loopback one. `unenforcedDeny` says which ones the platform cannot refuse. */
    deny: string[];
  };
  env: { keep: string[] };
  required: boolean;
}

/** What the host adds to a HOP's policy for one session (never HOP-authored). */
export interface HostNetwork {
  hostPorts?: number[];
  deny?: string[];
}

/** Credential locations no command reads unless the HOP allows them by name. ~/.ssh is
 *  narrowed to private keys so ssh via the agent and known_hosts keep working. */
export const DEFAULT_UNREADABLE = [
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.docker/config.json",
  "~/.gnupg",
  "~/.kube",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.yodex/credentials.json",
  "~/.ssh/id_rsa",
  "~/.ssh/id_ed25519",
  "~/.ssh/id_ecdsa",
  "~/.ssh/id_dsa",
];

/** Build and package caches a workspace-mode command may write; without these every build
 *  from inside the sandbox re-downloads the world or fails outright. */
export const DEFAULT_WRITABLE_CACHES = [
  "~/.cache",
  "~/.npm",
  "~/.bun",
  "~/.cargo",
  "~/.gradle",
  "~/.m2",
  "~/.pnpm-store",
  "~/.local/share/uv",
  "~/.local/share/pnpm",
  "~/Library/Caches",
];

/** Scratch locations every command may write regardless of mode... except readOnly, which
 *  still needs a place for a shell's own temp files, so /tmp stays writable there too. */
export const SCRATCH_DIRS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/dev/shm"];

export function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : resolve(p);
}

/** Resolve a HOP's (or the host default) sandbox policy against this run's workspace. */
export function resolveSandboxSpec(
  policy: SandboxPolicy | undefined,
  opts: { roots: string[]; scratch?: string[]; home?: string; hasSafetyBlock?: boolean; hostNetwork?: HostNetwork },
): SandboxSpec {
  const home = opts.home ?? homedir();
  const ex = (p: string) => expandHome(p, home);
  const fs = policy?.filesystem ?? {};
  const mode: FilesystemMode = fs.mode ?? "workspace";
  const allowRead = new Set((fs.allowRead ?? []).map(ex));
  const unreadable = [...DEFAULT_UNREADABLE.map(ex).filter((p) => !allowRead.has(p)), ...(fs.denyRead ?? []).map(ex)];
  const writable =
    mode === "readOnly"
      ? uniq([...SCRATCH_DIRS, ...(opts.scratch ?? []).map(ex)])
      : uniq([
          ...opts.roots.map(ex),
          ...SCRATCH_DIRS,
          ...(opts.scratch ?? []).map(ex),
          ...DEFAULT_WRITABLE_CACHES.map(ex),
          ...(fs.allowWrite ?? []).map(ex),
        ]);
  return {
    filesystem: { mode, writable, unreadable: uniq(unreadable) },
    network: {
      mode: policy?.network?.mode ?? "all",
      allow: policy?.network?.allow ?? [],
      hostPorts: uniq(opts.hostNetwork?.hostPorts ?? []),
      deny: uniq((opts.hostNetwork?.deny ?? []).map((e) => e.toLowerCase())),
    },
    env: { keep: policy?.env?.keep ?? [] },
    required: policy?.required ?? Boolean(opts.hasSafetyBlock),
  };
}

/** Host-pattern match for the network allowlist: exact, or `*.suffix` (which also matches the bare suffix). */
export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((pat) => {
    const p = pat.toLowerCase();
    if (p.startsWith("*.")) {
      const suffix = p.slice(2);
      return h === suffix || h.endsWith(`.${suffix}`);
    }
    return h === p;
  });
}

/** An endpoint as `[host, port]`: `host:port` or `[v6]:port`; the port is required. */
export function splitEndpoint(endpoint: string): [string, number] | null {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(endpoint) ?? /^([^:]+):(\d+)$/.exec(endpoint);
  return m ? [m[1]!.toLowerCase().replace(/\.$/, ""), Number(m[2])] : null;
}

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|::1)$/;
export const isLoopback = (host: string): boolean => LOOPBACK.test(host);

/** Whether `host:port` is one of the spec's denied endpoints (a loopback alias of a loopback one included). */
export function endpointDenied(host: string, port: number, deny: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return deny.some((e) => {
    const d = splitEndpoint(e);
    return d !== null && d[1] === port && (d[0] === h || (isLoopback(d[0]) && isLoopback(h)));
  });
}

/** Denied endpoints the OS layer cannot refuse on this platform: seatbelt filters loopback by port but no remote host
 *  by name; bwrap keeps the host network in `all` and `allowlist` (`none` refuses everything). Outside `allowlist`
 *  mode no proxy is in the path either, so a remote one is then reachable. */
export function unenforcedDeny(spec: SandboxSpec, platform: "seatbelt" | "bwrap" | null): string[] {
  if (spec.network.mode === "none" && platform !== null) return [];
  return spec.network.deny.filter((e) => {
    const d = splitEndpoint(e);
    if (!d) return true;
    if (platform === "seatbelt") return !isLoopback(d[0]) && spec.network.mode !== "allowlist";
    return true;
  });
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
