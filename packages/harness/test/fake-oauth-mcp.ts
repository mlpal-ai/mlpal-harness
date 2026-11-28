import { createHash, randomUUID } from "node:crypto";

/**
 * A Streamable-HTTP MCP server on loopback for tests, optionally behind OAuth 2.0 (protected resource metadata,
 * authorization server metadata, dynamic registration, authorization code + PKCE S256). It records the headers of
 * every MCP request. `authorize(url)` plays the person in the browser: it follows the authorization URL and returns
 * the redirect's `code` and `state` without a browser.
 */
export interface FakeOAuthMcp {
  url: string;
  origin: string;
  /** Headers of each MCP POST, lower-cased names. */
  seen: Array<Record<string, string>>;
  /** Visit an authorization URL as the person would; returns the redirect target's query. */
  authorize(url: string): Promise<{ redirect: URL; code: string | null; state: string | null }>;
  /** Codes issued and not yet redeemed; tokens issued. */
  issued: { codes: number; tokens: number };
  stop(): void;
}

export function fakeOAuthMcp(opts: { oauth?: boolean; tools?: Array<{ name: string; readOnly?: boolean }> } = {}): FakeOAuthMcp {
  const tools = opts.tools ?? [{ name: "speak" }, { name: "voices", readOnly: true }];
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  const tokens = new Set<string>();
  const clients = new Map<string, string[]>();
  const seen: Array<Record<string, string>> = [];
  const issued = { codes: 0, tokens: 0 };
  let origin = "";
  const json = (msg: unknown, init: ResponseInit = {}) => Response.json(msg, { ...init, headers: { "mcp-session-id": "s1", ...(init.headers ?? {}) } });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return opts.oauth ? Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] }) : new Response(null, { status: 404 });
      }
      if (u.pathname === "/.well-known/oauth-authorization-server") {
        if (!opts.oauth) return new Response(null, { status: 404 });
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (u.pathname.startsWith("/.well-known/")) return new Response(null, { status: 404 });
      if (u.pathname === "/register" && req.method === "POST") {
        const body = (await req.json()) as { redirect_uris?: string[] };
        const clientId = `c_${randomUUID()}`;
        clients.set(clientId, body.redirect_uris ?? []);
        return Response.json({ ...body, client_id: clientId }, { status: 201 });
      }
      if (u.pathname === "/authorize") {
        const clientId = u.searchParams.get("client_id") ?? "";
        const redirectUri = u.searchParams.get("redirect_uri") ?? "";
        if (!clients.get(clientId)?.includes(redirectUri)) return new Response("unknown client or redirect", { status: 400 });
        const code = `code_${randomUUID()}`;
        codes.set(code, { challenge: u.searchParams.get("code_challenge") ?? "", redirectUri, clientId });
        issued.codes++;
        const to = new URL(redirectUri);
        to.searchParams.set("code", code);
        const state = u.searchParams.get("state");
        if (state) to.searchParams.set("state", state);
        return new Response(null, { status: 302, headers: { location: to.toString() } });
      }
      if (u.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const grant = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!grant || grant.challenge !== challenge || grant.redirectUri !== form.get("redirect_uri")) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        codes.delete(form.get("code")!);
        const access = `at_${randomUUID()}`;
        tokens.add(access);
        issued.tokens++;
        return Response.json({ access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: `rt_${randomUUID()}` });
      }
      if (u.pathname !== "/mcp") return new Response("not found", { status: 404 });
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const headers = Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
      seen.push(headers);
      if (opts.oauth) {
        const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
        if (!bearer || !tokens.has(bearer)) {
          return new Response("unauthorized", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } });
        }
      }
      const msg = (await req.json()) as { id?: number; method: string };
      switch (msg.method) {
        case "initialize":
          return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
        case "tools/list":
          return json({
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: tools.map((t) => ({ name: t.name, inputSchema: { type: "object", properties: {} }, ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}) })) },
          });
        default:
          return new Response(null, { status: 202 });
      }
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    seen,
    issued,
    async authorize(url: string) {
      const r = await fetch(url, { redirect: "manual" });
      const location = r.headers.get("location");
      if (!location) throw new Error(`authorize answered ${r.status}: ${await r.text()}`);
      const redirect = new URL(location);
      return { redirect, code: redirect.searchParams.get("code"), state: redirect.searchParams.get("state") };
    },
    stop: () => server.stop(true),
  };
}
