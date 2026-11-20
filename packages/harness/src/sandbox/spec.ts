import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Logger } from "../obs/logger";

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
    /** Absolute paths under the writable roots that stay read-only (ruling R22, `PROTECTED_IN_ROOT`). Empty when
     *  readOnly. */
    protected: string[];
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

/**
 * Ruling R22: what a confined run may not write under a workspace root, because the harness or git later loads or
 * runs it with the person's authority: git's config, hooks and attributes (commands git runs: hooks, `core.fsmonitor`,
 * filter and diff drivers), the harness's own project directory (settings with hooks, a verify command, language and
 * MCP servers, a status line; workflows, skills, agents), `.claude`, and a project's MCP servers. Everything else in
 * `.git` stays writable: objects, refs, the index, so commits work. Instruction files (AGENTS.md, CLAUDE.md) are not
 * here: editing them is sometimes the task.
 */
export const PROTECTED_IN_ROOT = [".git/config", ".git/hooks", ".git/info/attributes", ".gitattributes", ".yodex", ".claude", ".mcp.json"];

/** The directories strictly between `root` and a protected path under it (`.git`, `.git/info`): moving one aside
 *  would take the protected path with it, so the platform layer pins them. */
export function protectedParents(spec: SandboxSpec): string[] {
  const out = new Set<string>();
  for (const p of spec.filesystem.protected) {
    const root = spec.filesystem.writable.filter((w) => p.startsWith(`${w}/`)).sort((a, b) => b.length - a.length)[0];
    if (!root) continue;
    for (let dir = dirname(p); dir.length > root.length; dir = dirname(dir)) out.add(dir);
  }
  return [...out].sort();
}

/** The protected path that holds `path` (an absolute, symlink-resolved path), or null. */
export function protectedBy(spec: SandboxSpec, path: string): string | null {
  return spec.filesystem.protected.find((p) => path === p || path.startsWith(`${p}/`)) ?? null;
}

/** Scratch locations every command may write regardless of mode... except readOnly, which
 *  still needs a place for a shell's own temp files, so /tmp stays writable there too. */
export const SCRATCH_DIRS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/dev/shm"];

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : resolve(p);
}

const homeRelative = (p: string) => p === "~" || p.startsWith("~/");

/** The invoking uid's home as the password database records it, or why it could not be read. */
export type PasswdHome = { home: string } | { error: string };

export interface PasswdLookupDeps {
  /** Run a command by absolute path with an EMPTY environment; null when it could not run (missing, timed out). */
  run?: (argv: string[]) => { code: number; out: string } | null;
  /** The local password file (Linux, when `getent` is absent). */
  readPasswd?: () => string;
}

const runCleared = (argv: string[]): { code: number; out: string } | null => {
  if (!existsSync(argv[0]!)) return null;
  try {
    const r = Bun.spawnSync(argv, { env: {}, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 2000 });
    return r.exitCode === null ? null : { code: r.exitCode, out: new TextDecoder().decode(r.stdout) };
  } catch {
    return null;
  }
};

/** The home field of the passwd-format line for `uid` (`name:pw:uid:gid:…:home:shell`, the Linux and the BSD layout). */
function homeOfEntry(line: string | undefined, uid: number): PasswdHome {
  const f = (line ?? "").trim().split(":");
  if (f.length < 7 || f[2] !== String(uid)) return { error: "no password entry for the uid" };
  const home = f[f.length - 2]!;
  return isAbsolute(home) ? { home } : { error: `the password entry's home is not absolute: ${JSON.stringify(home)}` };
}

/**
 * The invoking uid's home from the password database, read with no environment input: under Bun `os.userInfo()`
 * answers from `$HOME` and `$USER`, so it cannot see past a throwaway home (E-16 review). darwin: `/usr/bin/id -P <uid>`
 * (Directory Services); Linux: `getent passwd <uid>` (NSS), else `/etc/passwd`. Every command runs by absolute path
 * with an empty environment and a 2 s limit. Never throws.
 */
export function lookupPasswdHome(uid: number | undefined = process.getuid?.(), platform: NodeJS.Platform = process.platform, deps: PasswdLookupDeps = {}): PasswdHome {
  if (uid === undefined) return { error: `no uid on ${platform}` };
  const run = deps.run ?? runCleared;
  const first = (r: { code: number; out: string } | null) => (r && r.code === 0 ? r.out.split("\n")[0] : undefined);
  if (platform === "darwin") {
    const r = run(["/usr/bin/id", "-P", String(uid)]);
    return r ? homeOfEntry(first(r), uid) : { error: "/usr/bin/id did not run" };
  }
  if (platform === "linux") {
    for (const getent of ["/usr/bin/getent", "/bin/getent"]) {
      const r = run([getent, "passwd", String(uid)]);
      if (r) return homeOfEntry(first(r), uid);
    }
    try {
      const passwd = (deps.readPasswd ?? (() => readFileSync("/etc/passwd", "utf8")))();
      return homeOfEntry(passwd.split("\n").find((l) => l.split(":")[2] === String(uid)), uid);
    } catch (e) {
      return { error: `no getent and /etc/passwd unreadable: ${(e as Error).message}` };
    }
  }
  return { error: `no password database lookup on ${platform}` };
}

let passwdCache: { uid: number | undefined; result: PasswdHome } | undefined;
/** `lookupPasswdHome()` once per process (per uid): every sandbox of the run shares it. */
function cachedPasswdHome(): PasswdHome {
  const uid = process.getuid?.();
  if (passwdCache === undefined || passwdCache.uid !== uid) passwdCache = { uid, result: lookupPasswdHome(uid) };
  return passwdCache.result;
}

/** The other home the `~`-relative denials also cover, or undefined. An explicit `realHome` must be absolute (null:
 *  none). A failed lookup fails closed to `$HOME` alone and is logged `sandbox.real_home_unknown`, never thrown. */
function otherHome(opts: { realHome?: string | null; passwd?: () => PasswdHome; logger?: Pick<Logger, "warn"> }): string | undefined {
  if (opts.realHome === null) return undefined;
  if (opts.realHome !== undefined) {
    if (!isAbsolute(opts.realHome)) throw new TypeError(`realHome must be an absolute path, got ${JSON.stringify(opts.realHome)}`);
    return opts.realHome;
  }
  const r = (opts.passwd ?? cachedPasswdHome)();
  if ("home" in r) return r.home;
  opts.logger?.warn("sandbox.real_home_unknown", { reason: r.error });
  return undefined;
}

/** Resolve a HOP's (or the host default) sandbox policy against this run's workspace.
 *
 *  `~` is `home` (`$HOME`), where the run's tools look. A host that runs the engine under a throwaway `$HOME` (an eval
 *  harness, a wrapper) leaves the operator's credentials where the password database says, so every `~`-relative
 *  denial also applies under the real home: `realHome`, else `lookupPasswdHome()` (`passwd` replaces it in tests).
 *  That only narrows a HOP's locked policy: a `~`-relative allowRead lifts the run's own path, and only an absolute one
 *  lifts the real home's (E-16). */
export function resolveSandboxSpec(
  policy: SandboxPolicy | undefined,
  opts: {
    roots: string[];
    scratch?: string[];
    home?: string;
    realHome?: string | null;
    passwd?: () => PasswdHome;
    logger?: Pick<Logger, "warn">;
    hasSafetyBlock?: boolean;
    hostNetwork?: HostNetwork;
  },
): SandboxSpec {
  const home = opts.home ?? homedir();
  const ex = (p: string) => expandHome(p, home);
  const real = otherHome(opts);
  const homes = uniq([home, ...(real ? [real] : [])]);
  const denied = (p: string) => (homeRelative(p) ? homes.map((h) => expandHome(p, h)) : [ex(p)]);
  const fs = policy?.filesystem ?? {};
  const mode: FilesystemMode = fs.mode ?? "workspace";
  const allowRead = new Set((fs.allowRead ?? []).map(ex));
  const unreadable = [...DEFAULT_UNREADABLE.flatMap(denied).filter((p) => !allowRead.has(p)), ...(fs.denyRead ?? []).flatMap(denied)];
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
  // R22: under each root as given and as the OS resolves it (macOS's /var is /private/var; seatbelt sees the latter)
  const rootPaths = mode === "readOnly" ? [] : uniq(opts.roots.map(ex).flatMap((r) => [r, realOrSelf(r)]));
  return {
    filesystem: { mode, writable, unreadable: uniq(unreadable), protected: rootPaths.flatMap((r) => PROTECTED_IN_ROOT.map((q) => join(r, q))) },
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
