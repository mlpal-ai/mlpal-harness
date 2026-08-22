import { join } from "node:path";

/**
 * Host identity — the product the engine is embedded in. The engine itself is
 * product-neutral (the MLPal Harness); everything user-visible or filesystem-shaped
 * that used to hardcode "yodex" reads from here instead: the display name in
 * engine-owned strings, the dot-directory (`~/.yodex`, `./.yodex`), and the env-var
 * prefix (`YODEX_*`).
 *
 * A deliberate module-level singleton: identity is boot-time constant, and threading
 * it through every loader/tool signature would churn 30+ APIs for a value that never
 * changes after startup. The invariant that makes this safe: **configureHost() is
 * called once, before any other engine API, and never again.** Defaults are yodex's,
 * so existing embedders change nothing.
 *
 * NOT host identity: profile (HOP) prompt text. A HOP may be product-branded — the
 * builtin coding HOP says "You are yodex" because yodex IS the coding product. A
 * different product on this engine ships its own HOP.
 */
export interface HostIdentity {
  /** Product name used in engine-owned, user/model-visible strings. */
  name: string;
  /** Dot-directory name under $HOME and project roots. */
  configDirName: string;
  /** Env-var prefix (without trailing underscore). */
  envPrefix: string;
}

const DEFAULT_HOST: HostIdentity = { name: "yodex", configDirName: ".yodex", envPrefix: "YODEX" };

let current: HostIdentity = DEFAULT_HOST;

/** Set the embedding product's identity. Call once at boot, before any engine API. */
export function configureHost(identity: Partial<HostIdentity>): void {
  current = { ...DEFAULT_HOST, ...identity };
}

export function host(): HostIdentity {
  return current;
}

/** `<base>/<configDirName>[/...parts]` — the host's config dir under a home or project root. */
export function hostDir(base: string, ...parts: string[]): string {
  return join(base, current.configDirName, ...parts);
}

/** Read `<PREFIX>_<key>` from an env map. */
export function hostEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  return env[`${current.envPrefix}_${key}`];
}

/** `<PREFIX>_<key>` — for building env maps and error messages. */
export function hostEnvName(key: string): string {
  return `${current.envPrefix}_${key}`;
}
