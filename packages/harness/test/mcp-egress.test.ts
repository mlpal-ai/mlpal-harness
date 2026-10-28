import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EgressRefusedError, egressFetch, egressMcpServer, egressUrl, type EgressRoute } from "../src/egress/proxy";
import { McpManager } from "../src/mcp/manager";
import { runTool, ToolRegistry } from "../src/tools/registry";
import { REFUSALS, type RefusalCode, startFakeEgressProxy, startFakeMcpUpstream } from "./fake-egress-proxy";

/**
 * P6 (contract P6-vault-egress 1.1, §"The engine egress proxy"): an HTTP MCP server that is an egress upstream of
 * the session is reached at `<proxy>/v1/u/<name>/<path>` with `X-Harness-Egress-Token` (the P3b egress token, read
 * from its file per request), and the engine adds no credential of its own: the proxy injects the vault's.
 */

const TOKEN = "eyJlZ3Jlc3MiOjF9.egress-token-1.sig";
const TOKEN_2 = "eyJlZ3Jlc3MiOjJ9.egress-token-2.sig";
const SECRET = "ghp_vault_value_only_the_proxy_holds";
const ENGINE_CREDENTIALS = ["authorization", "proxy-authorization", "x-api-key", "api-key", "cookie"];

let dir: string;
let tokenFile: string;
let upstream: ReturnType<typeof startFakeMcpUpstream>;
let evil: { url: string; hits: number; stop(): void };
let proxy: ReturnType<typeof startFakeEgressProxy>;
let route: EgressRoute;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "p6-egress-"));
  tokenFile = join(dir, "egress.token");
  writeFileSync(tokenFile, `${TOKEN}\n`);
  const evilState = { hits: 0 };
  const evilServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (evilState.hits++, new Response("stolen")) });
  evil = { url: `http://127.0.0.1:${evilServer.port}/steal`, get hits() { return evilState.hits; }, stop: () => evilServer.stop(true) };
  upstream = startFakeMcpUpstream({ redirectTo: evil.url });
  proxy = startFakeEgressProxy({ token: TOKEN, upstreams: [{ name: "github-mcp", base_url: upstream.url, inject: [{ header: "authorization", scheme: "bearer", value: SECRET }] }] });
  route = { proxyUrl: proxy.url, upstream: "github-mcp", tokenFile };
});
afterAll(() => {
  proxy.stop();
  upstream.stop();
  evil.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function connected(config = egressMcpServer(route), name = "github-mcp") {
  const reg = new ToolRegistry();
  const mcp = new McpManager();
  await mcp.connectAll({ [name]: config }, reg);
  return { reg, mcp };
}

describe("the route", () => {
  test("<proxy>/v1/u/<name>/<path>, the name encoded, one slash between", () => {
    expect(egressUrl({ proxyUrl: "http://egress-proxy.harness:7401/", upstream: "github-mcp", tokenFile }, "a/b?x=1")).toBe("http://egress-proxy.harness:7401/v1/u/github-mcp/a/b?x=1");
    expect(egressUrl({ proxyUrl: "http://p:7401", upstream: "a b", tokenFile })).toBe("http://p:7401/v1/u/a%20b/");
    expect(egressMcpServer(route)).toEqual({ url: `${proxy.url}/v1/u/github-mcp/`, egress: route });
  });
});

describe("an HTTP MCP upstream through the egress proxy", () => {
  test("tools list and a call: the egress token on every request, no engine credential, the vault's header injected upstream", async () => {
    const before = proxy.seen.length;
    const { reg, mcp } = await connected();
    try {
      expect(mcp.status()).toEqual([{ server: "github-mcp", ok: true, tools: 2 }]);
      const res = await runTool(reg, "mcp__github-mcp__echo", { text: "hi" }, { cwd: dir });
      expect(res).toMatchObject({ isError: false, content: "echo: hi" });
      const seen = proxy.seen.slice(before);
      expect(seen.length).toBeGreaterThanOrEqual(3); // initialize, tools/list, tools/call (+ the notification)
      for (const r of seen) {
        expect(r.name).toBe("github-mcp");
        expect(r.headers["x-harness-egress-token"]).toBe(TOKEN);
        for (const h of ENGINE_CREDENTIALS) expect(r.headers[h]).toBeUndefined();
      }
      const last = upstream.received.at(-1)!;
      expect(last.authorization).toBe(`Bearer ${SECRET}`);
      expect(last["x-harness-egress-token"]).toBeUndefined();
    } finally {
      await mcp.close();
    }
  }, 15_000);

  test("the token file is read per request: a rotation reaches the next call", async () => {
    const { reg, mcp } = await connected();
    try {
      writeFileSync(tokenFile, TOKEN_2);
      proxy.rotate(TOKEN_2);
      const res = await runTool(reg, "mcp__github-mcp__echo", { text: "rotated" }, { cwd: dir });
      expect(res).toMatchObject({ isError: false, content: "echo: rotated" });
      expect(proxy.seen.at(-1)!.headers["x-harness-egress-token"]).toBe(TOKEN_2);
    } finally {
      writeFileSync(tokenFile, TOKEN);
      proxy.rotate(TOKEN);
      await mcp.close();
    }
  }, 15_000);

  test("headers or OAuth on a proxied server's config are never sent: the engine adds no credential of its own", async () => {
    const before = proxy.seen.length;
    const { reg, mcp } = await connected({ ...egressMcpServer(route), headers: { Authorization: "Bearer engine-held", "X-Api-Key": "engine-held" }, oauth: {} });
    try {
      expect((await runTool(reg, "mcp__github-mcp__echo", { text: "x" }, { cwd: dir })).isError).toBe(false);
      for (const r of proxy.seen.slice(before)) for (const h of ENGINE_CREDENTIALS) expect(r.headers[h]).toBeUndefined();
    } finally {
      await mcp.close();
    }
  }, 15_000);

  test("a 3xx is returned as is, never followed: the redirect target sees nothing and the call is a tool error", async () => {
    const { reg, mcp } = await connected();
    try {
      const res = await runTool(reg, "mcp__github-mcp__moved", {}, { cwd: dir });
      expect(res.isError).toBe(true);
      expect(String(res.content)).toContain("302");
      expect(evil.hits).toBe(0);
    } finally {
      await mcp.close();
    }
  }, 15_000);

  test("each proxy refusal code is the tool's error text `egress refused (<code>) for <upstream>`", async () => {
    const { reg, mcp } = await connected();
    try {
      for (const code of Object.keys(REFUSALS) as RefusalCode[]) {
        proxy.refuseNext(code);
        const res = await runTool(reg, "mcp__github-mcp__echo", { text: "x" }, { cwd: dir });
        expect(res).toEqual({ isError: true, content: `egress refused (${code}) for github-mcp` });
      }
    } finally {
      await mcp.close();
    }
  }, 30_000);

  test("an ungranted upstream is refused at connect: the server's status names the refusal", async () => {
    const { mcp } = await connected(egressMcpServer({ ...route, upstream: "ghost-mcp" }), "ghost-mcp");
    try {
      const [s] = mcp.status();
      expect(s?.ok).toBe(false);
      expect(s?.error).toContain("egress refused (upstream_not_granted) for ghost-mcp");
    } finally {
      await mcp.close();
    }
  }, 15_000);
});

describe("egressFetch", () => {
  test("streams the body through: a chunk is readable before the upstream sends the next", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const enc = new TextEncoder();
    const base = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            c.enqueue(enc.encode("event: message\ndata: 1\n\n"));
            await gate; // the second chunk waits for the reader to have taken the first
            c.enqueue(enc.encode("event: message\ndata: 2\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const res = await egressFetch(route, base)(`${proxy.url}/v1/u/github-mcp/`, { method: "POST" });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("data: 1");
    release();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("data: 2");
  });

  test("redirect is manual, the token header is set from the file, engine credential headers are stripped", async () => {
    let init: RequestInit | undefined;
    const base = (async (_u: unknown, i: RequestInit) => ((init = i), new Response("ok"))) as unknown as typeof fetch;
    await egressFetch(route, base)("http://p/v1/u/github-mcp/", { headers: { authorization: "Bearer x", cookie: "c", accept: "text/event-stream" } });
    const h = new Headers(init!.headers);
    expect(init!.redirect).toBe("manual");
    expect(h.get("x-harness-egress-token")).toBe(TOKEN);
    expect([h.get("authorization"), h.get("cookie"), h.get("accept")]).toEqual([null, null, "text/event-stream"]);
  });

  test("a refusal is a typed EgressRefusedError; a non-refusal error status passes through", async () => {
    const refusedBase = (async () => new Response(JSON.stringify({ code: "secret_revoked" }), { status: 403, headers: { "x-harness-egress": "refused" } })) as unknown as typeof fetch;
    const e = await egressFetch(route, refusedBase)("http://p/v1/u/github-mcp/").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(EgressRefusedError);
    expect([(e as EgressRefusedError).code, (e as EgressRefusedError).status, (e as Error).message]).toEqual(["secret_revoked", 403, "egress refused (secret_revoked) for github-mcp"]);
    const upstream403 = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    expect((await egressFetch(route, upstream403)("http://p/v1/u/github-mcp/")).status).toBe(403);
  });

  test("an unreadable token file: no request, an error naming the path", async () => {
    let calls = 0;
    const base = (async () => (calls++, new Response("ok"))) as unknown as typeof fetch;
    const e = await egressFetch({ ...route, tokenFile: join(dir, "missing.token") }, base)("http://p/").catch((x: unknown) => x);
    expect(String((e as Error).message)).toContain(join(dir, "missing.token"));
    expect(calls).toBe(0);
  });
});

describe("WebFetch through the web-fetch upstream", () => {
  test("a URL under the upstream's base is fetched at the proxy's route with the egress token; the vault header reaches the site", async () => {
    const { createEgressWebFetchTool } = await import("../src/tools/builtin/web");
    const got: Array<Record<string, string>> = [];
    const site = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        got.push(Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])));
        const u = new URL(req.url);
        if (u.pathname === "/docs/moved") return new Response(null, { status: 301, headers: { location: evil.url } });
        return new Response(`<html><body><p>page ${u.pathname}${u.search}</p></body></html>`, { headers: { "content-type": "text/html" } });
      },
    });
    const base = `http://127.0.0.1:${site.port}/docs/`;
    const p = startFakeEgressProxy({ token: TOKEN, upstreams: [{ name: "web-fetch", base_url: base, inject: [{ header: "x-api-key", scheme: "raw", value: SECRET }] }] });
    try {
      const tool = createEgressWebFetchTool({ proxyUrl: p.url, upstream: "web-fetch", tokenFile }, base);
      expect(tool.name).toBe("WebFetch");
      const res = await tool.call({ url: `${base}guide?x=1` }, { cwd: dir });
      expect(res.isError).toBeUndefined();
      expect(String(res.content)).toContain("page /docs/guide?x=1");
      expect(p.seen.at(-1)).toMatchObject({ name: "web-fetch", path: "guide" });
      expect(p.seen.at(-1)!.headers["x-harness-egress-token"]).toBe(TOKEN);
      expect(got.at(-1)!["x-api-key"]).toBe(SECRET);

      const outside = await tool.call({ url: "https://example.com/" }, { cwd: dir });
      expect(outside.isError).toBe(true);
      expect(String(outside.content)).toContain(base);

      const moved = await tool.call({ url: `${base}moved` }, { cwd: dir });
      expect(moved).toEqual({ isError: true, content: "HTTP 301: a redirect, not followed through the egress proxy" });
      expect(evil.hits).toBe(0);

      p.refuseNext("rate_limited");
      expect(await tool.call({ url: `${base}guide` }, { cwd: dir })).toEqual({ isError: true, content: "egress refused (rate_limited) for web-fetch" });
    } finally {
      p.stop();
      site.stop(true);
    }
  }, 15_000);
});
