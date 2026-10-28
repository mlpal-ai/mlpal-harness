import { proxyRefusals } from "./egress-fixtures";

/**
 * A stand-in for the engine egress proxy (contract P6-vault-egress 1.2, §"The engine egress proxy"); its refusals
 * are W4's fixtures (fixtures/egress-proxy, mlpal-harness-stack d5d56a5), answered byte for byte. `ANY
 * /v1/u/{name}/{path…}`:
 *
 * - auth: `X-Harness-Egress-Token` must equal `token` (settable, to rotate), else 401 `token_invalid`;
 * - `name` must be one of `upstreams`, else 403 `upstream_not_granted`;
 * - it strips `X-Harness-Egress-Token`, `Proxy-*`, hop-by-hop headers and every header named in `inject`, sets each
 *   `inject` header (`Bearer <value>` for `bearer`, the value for `raw`), and forwards to `base_url + path` (with the
 *   query), never following a redirect; both bodies stream; a response header equal to an injected value is dropped;
 * - `refuseNext(code)` answers the next request with that refusal, `X-Harness-Egress: refused`, body `{code}`.
 *
 * `seen` records what the ENGINE sent (before stripping), so a test can assert the engine added no credential.
 */

/** Every refusal the proxy answers, by code, as its contract fixtures show it. */
export const REFUSALS = proxyRefusals();
export type RefusalCode = string;

export interface FakeUpstream {
  name: string;
  base_url: string;
  /** `value` is the vault's secret, which only the proxy ever holds. */
  inject: Array<{ header: string; scheme: "bearer" | "raw"; value: string }>;
}

export interface SeenRequest {
  name: string;
  path: string;
  method: string;
  /** The engine's headers, lower-cased, as they reached the proxy. */
  headers: Record<string, string>;
}

const HOP_BY_HOP = ["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"];

export function startFakeEgressProxy(opts: { token: string; upstreams: FakeUpstream[] }) {
  const state = { token: opts.token, refuse: [] as RefusalCode[] };
  const seen: SeenRequest[] = [];
  const refused = (code: RefusalCode) => {
    const f = REFUSALS[code];
    if (!f) throw new Error(`no fixture for the refusal ${code}`);
    return new Response(JSON.stringify(f.body), { status: f.status, headers: { "content-type": f.content_type ?? "application/json", ...f.headers } });
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const m = /^\/v1\/u\/([^/]+)\/(.*)$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const name = decodeURIComponent(m[1]!);
      const path = m[2]!;
      seen.push({ name, path, method: req.method, headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])) });
      const forced = state.refuse.shift();
      if (forced) return refused(forced);
      if (req.headers.get("x-harness-egress-token") !== state.token) return refused("token_invalid");
      const up = opts.upstreams.find((u) => u.name === name);
      if (!up) return refused("upstream_not_granted");
      const injected = new Set(up.inject.map((i) => i.header.toLowerCase()));
      const headers = new Headers();
      for (const [k, v] of req.headers) {
        const key = k.toLowerCase();
        if (key === "x-harness-egress-token" || key.startsWith("proxy-") || HOP_BY_HOP.includes(key) || injected.has(key)) continue;
        headers.set(key, v);
      }
      const values = up.inject.map((i) => (i.scheme === "bearer" ? `Bearer ${i.value}` : i.value));
      up.inject.forEach((i, n) => headers.set(i.header, values[n]!));
      let res: Response;
      try {
        res = await fetch(`${up.base_url}${path}${url.search}`, {
          method: req.method,
          headers,
          ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req.body }),
          redirect: "manual",
        });
      } catch {
        return refused("upstream_unreachable");
      }
      const out = new Headers();
      for (const [k, v] of res.headers) if (!values.includes(v) && !HOP_BY_HOP.includes(k.toLowerCase()) && k.toLowerCase() !== "content-encoding") out.set(k, v);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    seen,
    rotate(token: string) {
      state.token = token;
    },
    refuseNext(code: RefusalCode) {
      state.refuse.push(code);
    },
    stop: () => server.stop(true),
  };
}

/** A minimal streamable-HTTP MCP server, answering requests over SSE. Tools: `echo` (returns its `text`), `moved`
 *  (its call is answered with a 302 to `redirectTo`). `received` keeps each request's headers. */
export function startFakeMcpUpstream(opts: { redirectTo?: string } = {}) {
  const received: Array<Record<string, string>> = [];
  const sse = (msg: unknown) => `event: message\ndata: ${JSON.stringify(msg)}\n\n`;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      received.push(Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])));
      if (req.method !== "POST") return (await req.arrayBuffer(), new Response(null, { status: 405 }));
      const msg = (await req.json()) as { id?: number; method: string; params?: { name?: string; arguments?: { text?: string } } };
      const answer = (result: unknown) => new Response(sse({ jsonrpc: "2.0", id: msg.id, result }), { headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" } });
      switch (msg.method) {
        case "initialize":
          return answer({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "upstream", version: "0" } });
        case "tools/list":
          return answer({ tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }, { name: "moved", inputSchema: { type: "object", properties: {} } }] });
        case "tools/call":
          if (msg.params?.name === "moved") return new Response(null, { status: 302, headers: { location: opts.redirectTo ?? "http://127.0.0.1:1/" } });
          return answer({ content: [{ type: "text", text: `echo: ${msg.params?.arguments?.text ?? ""}` }] });
        default:
          return new Response(null, { status: 202 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp/`, received, stop: () => server.stop(true) };
}
