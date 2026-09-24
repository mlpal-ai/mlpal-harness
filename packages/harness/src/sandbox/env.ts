/**
 * Environment scrub: the child a command runs in never inherits provider keys, tokens or
 * passwords from the agent's own environment. A test that phones home, a build script that
 * prints `env`, a dependency that uploads its host's variables — none of them see a secret
 * the HOP did not explicitly keep.
 *
 * Detection is by NAME (values are not inspected here): the conventional secret suffixes plus
 * the well-known provider variables. A HOP keeps specific names via `safety.sandbox.env.keep`.
 */

const SECRET_NAME = /(^|_)(KEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|API_KEY|AUTH)($|_)/i;

/** Well-known variables whose names do not match the pattern but carry credentials. */
const KNOWN_SECRETS = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "NPM_CONFIG__AUTH",
  "NPM_CONFIG__AUTHTOKEN",
  "DOCKER_AUTH_CONFIG",
  "KUBECONFIG_DATA",
  "DATABASE_URL",
  "REDIS_URL",
]);

/** Names the pattern would catch that are not secrets and that programs rely on. */
const NOT_SECRETS = new Set(["SSH_AUTH_SOCK", "GPG_TTY", "LESSKEY", "XAUTHORITY", "AUTH_SOCK", "PUBKEY", "KEYMAP", "TERM_PROGRAM_KEY"]);

export function isSecretName(name: string): boolean {
  if (NOT_SECRETS.has(name)) return false;
  if (KNOWN_SECRETS.has(name)) return true;
  return SECRET_NAME.test(name);
}

export interface ScrubbedEnv {
  env: Record<string, string>;
  /** Names removed, for the session notice and the run log (never the values). */
  scrubbed: string[];
  /** Name → value of what was removed, so the redactor can mask them if they surface anyway. */
  removed: Record<string, string>;
}

export function scrubEnv(base: NodeJS.ProcessEnv, keep: string[] = []): ScrubbedEnv {
  const keepSet = new Set(keep);
  const env: Record<string, string> = {};
  const scrubbed: string[] = [];
  const removed: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!keepSet.has(name) && isSecretName(name)) {
      scrubbed.push(name);
      removed[name] = value;
      continue;
    }
    env[name] = value;
  }
  scrubbed.sort();
  return { env, scrubbed, removed };
}
