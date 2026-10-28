import { readFileSync } from "node:fs";
import type { HttpServerConfig } from "../mcp/manager";
import { registerSecret } from "../obs/redact";

/**
 * The engine egress proxy (contract P6-vault-egress 1.2, §"The engine egress proxy"). On the platform the engine
 * holds no upstream credential: a named upstream is reached at `<proxy>/v1/u/<name>/<path>` with the session's
 * egress token (P3b `/run/session/egress.token`, read per request), and the proxy injects the vault's header. The
 * engine sends no credential header of its own, never follows a redirect (a 3xx could carry the injected credential
 * to another host), lets both bodies stream (SSE, chunked), and never sends a request outside its upstream's route:
 * fetch normalises dot segments before the proxy sees the url, so `/v1/u/a/../b/` would be upstream b's route, with
 * b's credential injected.
 */

export const EGRESS_TOKEN_HEADER = "x-harness-egress-token";

/** Headers the engine never sends to a proxied upstream: the proxy alone authenticates it. */
const ENGINE_CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie"];

/** One upstream of the session, as the engine reaches it. */
export interface EgressRoute {
  /** The proxy's base, e.g. `http://egress-proxy.harness:7401`. */
  proxyUrl: string;
  /** The upstream's `name` in the session's EngineEgress (and its egress token). */
  upstream: string;
  /** The egress token's file, read on every request. */
  tokenFile: string;
}

/** The proxy refused the request itself (`X-Harness-Egress: refused`, body `{code}`): not the upstream's answer. */
export class EgressRefusedError extends Error {
  override name = "EgressRefusedError";
  constructor(
    readonly code: string,
    readonly upstream: string,
    readonly status: number,
  ) {
    super(`egress refused (${code}) for ${upstream}`);
  }
}

/** The engine's own refusal of a url that resolves outside its upstream's route: never sent. */
export const PATH_ESCAPE = "path_escape";

/** True when `url`, as fetch will send it (dot segments resolved, `%2e` included) and once more after one decoding
 *  (what an upstream that decodes would resolve), stays on the proxy's origin under `/v1/u/<name>/`. */
export function insideRoute(url: string, route: EgressRoute): boolean {
  let parsed: URL;
  let proxy: URL;
  try {
    parsed = new URL(url);
    proxy = new URL(route.proxyUrl);
  } catch {
    return false;
  }
  const prefix = `${proxy.pathname.replace(/\/+$/, "")}/v1/u/${encodeURIComponent(route.upstream)}/`;
  if (parsed.origin !== proxy.origin || !parsed.pathname.startsWith(prefix)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  const again = new URL(decoded, parsed.origin);
  return again.origin === parsed.origin && again.pathname.startsWith(prefix);
}

/** `<proxy>/v1/u/<name>/<path>`: `path` (with its query) is relative to the upstream's base_url. A path that resolves
 *  outside the route is refused (`path_escape`). */
export function egressUrl(route: EgressRoute, path = ""): string {
  const url = `${route.proxyUrl.replace(/\/+$/, "")}/v1/u/${encodeURIComponent(route.upstream)}/${path.replace(/^\/+/, "")}`;
  if (!insideRoute(url, route)) throw new EgressRefusedError(PATH_ESCAPE, route.upstream, 0);
  return url;
}

/** An HTTP MCP server reached through the proxy: its endpoint is the upstream's base_url plus `path`. */
export function egressMcpServer(route: EgressRoute, path = ""): HttpServerConfig {
  return { url: egressUrl(route, path), egress: route };
}

/** The egress token now. The path is named in an error, the value never. */
export function readEgressToken(file: string): string {
  let token: string;
  try {
    token = readFileSync(file, "utf8").trim();
  } catch (e) {
    throw new Error(`egress token file ${file} is unreadable (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!token) throw new Error(`egress token file ${file} is empty`);
  registerSecret("egress token", token); // masked wherever a tool result would echo it
  return token;
}

type FetchLike = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

/** A machine code from the refusal body; anything else is `unknown` (never prose from the body). */
async function refusalCode(res: Response): Promise<string> {
  try {
    const code = ((await res.json()) as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unknown";
  } catch {
    return "unknown";
  }
}

/** `base` for requests to `route`'s upstream: the egress token set per request, engine credentials stripped, no
 *  redirect followed, a url outside the route refused before it is sent, a proxy refusal raised as
 *  EgressRefusedError. The response body is returned untouched. */
export function egressFetch(route: EgressRoute, base: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!insideRoute(url, route)) throw new EgressRefusedError(PATH_ESCAPE, route.upstream, 0);
    const headers = new Headers(init?.headers);
    for (const h of ENGINE_CREDENTIAL_HEADERS) headers.delete(h);
    headers.set(EGRESS_TOKEN_HEADER, readEgressToken(route.tokenFile));
    const res = await base(input, { ...init, headers, redirect: "manual" });
    if (res.headers.get("x-harness-egress")?.toLowerCase() === "refused") throw new EgressRefusedError(await refusalCode(res), route.upstream, res.status);
    return res;
  };
}
