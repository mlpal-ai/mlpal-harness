import { MLPAL_SECRET_PREFIX, SECRET_REF_NAME } from "@mlpal/harness-protocol";

/**
 * References to MLPal secrets in an MCP server's header values (tools-admin, T-1): `${MLPAL_SECRET_<NAME>}`, written
 * by the Tools screen instead of a value, so a credential is never in a config file, the transcript or a synced
 * snapshot. The host names where values come from (a `SecretResolver`); the manager resolves a header's references at
 * connect, and a value with a reference is never env-expanded (a secret may itself contain `${`).
 */

/** Looks up one secret by its name, for the server and URL that asked (R51-5: a stored key is bound to the server and
 *  address it was entered for); undefined when there is none for them. Never logs the value. */
export type SecretResolver = (name: string, asker: { server: string; url: string }) => Promise<string | undefined>;

/** R51-4: whether `server` may have `${variable}` filled in: null when it may, else why not (said in its status). */
export type ReferencePolicy = (server: string, variable: string) => string | null;

const REF = /\$\{MLPAL_SECRET_([A-Za-z0-9_]{1,64})\}/g;

/** The reference a header value is written as. `name` must match SECRET_REF_NAME (checked by the caller). */
export function secretRefValue(name: string, scheme?: "bearer"): string {
  const ref = `\${${MLPAL_SECRET_PREFIX}${name}}`;
  return scheme === "bearer" ? `Bearer ${ref}` : ref;
}

/** The secret names a value references, in order, without repeats. */
export function secretRefsIn(value: string): string[] {
  return [...new Set([...value.matchAll(REF)].map((m) => m[1]!))];
}

/** A header value that is exactly a reference, optionally after `Bearer `: what tools-admin writes. Anything else in a
 *  header value is a literal (or an env reference written by hand). */
export function parseSecretRefValue(value: string): { name: string; scheme?: "bearer" } | null {
  const m = /^(Bearer )?\$\{MLPAL_SECRET_([A-Za-z0-9_]{1,64})\}$/.exec(value);
  if (!m || !SECRET_REF_NAME.test(m[2]!)) return null;
  return { name: m[2]!, ...(m[1] ? { scheme: "bearer" as const } : {}) };
}

const VARIABLE = /\$\{([A-Za-z0-9_]+)(?::-[^}]*)?\}/g;

/** The `${VARIABLE}` names a value refers to (an MLPal secret's `MLPAL_SECRET_<NAME>` included), without repeats. */
export function variablesIn(value: string): string[] {
  return [...new Set([...value.matchAll(VARIABLE)].map((m) => m[1]!))];
}

/** Every variable an MCP server's config asks the engine to fill in: an HTTP server's header values, a stdio server's
 *  environment values. (A URL, a command and its arguments are never expanded.) */
export function configVariables(config: { headers?: Record<string, string>; env?: Record<string, string> }): string[] {
  const values = [...Object.values(config.headers ?? {}), ...Object.values(config.env ?? {})].filter((v): v is string => typeof v === "string");
  return [...new Set(values.flatMap(variablesIn))].sort();
}

/** A referenced secret could not be resolved: its name only, never a value. */
export class SecretRefUnavailableError extends Error {
  override name = "SecretRefUnavailableError";
  constructor(readonly secrets: string[], why: string) {
    super(`header references MLPal secret${secrets.length === 1 ? "" : "s"} ${secrets.join(", ")}: ${why}`);
  }
}

/** Replace every reference in `value`. Throws SecretRefUnavailableError naming the missing ones. */
export async function resolveSecretRefsIn(value: string, resolve: SecretResolver | undefined, asker: { server: string; url: string }): Promise<string> {
  const names = secretRefsIn(value);
  if (names.length === 0) return value;
  if (!resolve) throw new SecretRefUnavailableError(names, "no secrets source is configured for this engine");
  const values = new Map<string, string>();
  const missing: string[] = [];
  for (const n of names) {
    const v = await resolve(n, asker);
    if (v === undefined || v === "") missing.push(n);
    else values.set(n, v);
  }
  if (missing.length) throw new SecretRefUnavailableError(missing, "not found for this server and address");
  return value.replace(REF, (_m, n: string) => values.get(n)!);
}
