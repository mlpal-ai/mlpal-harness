import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GatewayClient } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { MemoryMetrics } from "../src/obs/metrics";
import { JsonLogger } from "../src/obs/logger";
import { clearSecrets, redactText } from "../src/obs/redact";
import { EgressRefusedError, egressFetch, egressMcpServer, egressUrl, type EgressRoute, segmentsSafe } from "../src/egress/proxy";
import { McpManager } from "../src/mcp/manager";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { createEgressWebFetchTool, pathUnderBase } from "../src/tools/builtin/web";
import { ToolRegistry } from "../src/tools/registry";
import { startFakeEgressProxy, startFakeMcpUpstream } from "./fake-egress-proxy";

/**
 * P6 review round 1. Critical 1: no dot segment, in any encoding, takes a request from one upstream's route to
 * another's (fetch normalises the url before the proxy sees it). Important 5: SSE upstreams are refused (streamable
 * HTTP only). Minors: non-credential headers reach a proxied upstream; the refusal metric names its cause; a dropped
 * feedback event is logged; every token the engine reads is registered for masking.
 */

const TOKEN = "eyJlZ3Jlc3MiOjF9.round1-egress.sig";
const SECRET = "ghp_vault_value_only_the_proxy_holds";
/** The four ways to write `..` the reviewer named. */
const ESCAPES = ["..", "%2e%2e", "%2E%2E", "%252e%252e"];

let dir: string;
let tokenFile: string;
let github: ReturnType<typeof startFakeMcpUpstream>;
let site: { base: string; stop(): void };
let proxy: ReturnType<typeof startFakeEgressProxy>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "p6-round1-"));
  tokenFile = join(dir, "egress.token");
  writeFileSync(tokenFile, TOKEN);
  github = startFakeMcpUpstream();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => (await req.arrayBuffer(), new Response("<p>docs</p>", { headers: { "content-type": "text/html" } })) });
  site = { base: `http://127.0.0.1:${server.port}/docs/`, stop: () => server.stop(true) };
  proxy = startFakeEgressProxy({
    token: TOKEN,
    upstreams: [
      { name: "web-fetch", base_url: site.base, inject: [] },
      { name: "github-mcp", base_url: github.url, inject: [{ header: "authorization", scheme: "bearer", value: SECRET }] },
    ],
  });
});
afterAll(() => {
  proxy.stop();
  github.stop();
  site.stop();
  rmSync(dir, { recursive: true, force: true });
});

const fetchRoute = (): EgressRoute => ({ proxyUrl: proxy.url, upstream: "web-fetch", tokenFile });

describe("Critical 1: a request never leaves its upstream's route", () => {
  for (const dots of ESCAPES) {
    test(`egressUrl / egressMcpServer refuse ${dots}: path_escape`, () => {
      for (const path of [`${dots}/github-mcp/x`, `a/${dots}/${dots}/github-mcp/x`, `${dots}%2fgithub-mcp/x`]) {
        let e: unknown;
        try {
          egressUrl(fetchRoute(), path);
        } catch (x) {
          e = x;
        }
        expect(e).toBeInstanceOf(EgressRefusedError);
        expect((e as Error).message).toBe("egress refused (path_escape) for web-fetch");
        expect(() => egressMcpServer(fetchRoute(), path)).toThrow("egress refused (path_escape) for web-fetch");
      }
    });

    test(`egressFetch refuses a url that resolves outside the route (${dots}), before any request`, async () => {
      let calls = 0;
      const base = (async () => (calls++, new Response("ok"))) as unknown as typeof fetch;
      const e = await egressFetch(fetchRoute(), base)(`${proxy.url}/v1/u/web-fetch/${dots}/github-mcp/x`).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(EgressRefusedError);
      expect((e as EgressRefusedError).code).toBe("path_escape");
      expect(calls).toBe(0);
    });

    test(`an MCP server whose url escapes its route (${dots}) never connects: the github upstream sees nothing`, async () => {
      const before = github.received.length;
      const reg = new ToolRegistry();
      const mcp = new McpManager();
      try {
        await mcp.connectAll({ docs: { url: `${proxy.url}/v1/u/web-fetch/${dots}/github-mcp/`, egress: fetchRoute() } }, reg);
        expect(mcp.status()[0]).toMatchObject({ ok: false });
        expect(mcp.status()[0]!.error).toContain("egress refused (path_escape) for web-fetch");
        expect(github.received.length).toBe(before);
      } finally {
        await mcp.close();
      }
    });

    test(`WebFetch refuses a url that escapes its base (${dots}): an error, the github upstream never reached`, async () => {
      const before = github.received.length;
      const tool = createEgressWebFetchTool(fetchRoute(), site.base);
      // base /docs/ → the route /v1/u/web-fetch/; one `..` past it is /v1/u/github-mcp/ (the reviewer's escape).
      const res = await tool.call({ url: `${site.base}${dots}/github-mcp/x` }, { cwd: dir });
      expect(res.isError).toBe(true);
      expect(String(res.content)).not.toContain("echo");
      expect(github.received.length).toBe(before);
    });
  }

  test("WebFetch compares the parsed origin and a segment-bounded path: a sibling prefix or another port is outside", async () => {
    const tool = createEgressWebFetchTool(fetchRoute(), site.base);
    const u = new URL(site.base);
    expect((await tool.call({ url: `${u.origin}/docs/x` }, { cwd: dir })).isError).toBeUndefined();
    expect((await tool.call({ url: `${u.origin}/docs-private/x` }, { cwd: dir })).isError).toBe(true);
    expect((await tool.call({ url: `http://127.0.0.1:1/docs/x` }, { cwd: dir })).isError).toBe(true);
  });

  test("a base_url without its trailing slash is the same base", async () => {
    const tool = createEgressWebFetchTool(fetchRoute(), site.base.replace(/\/$/, ""));
    expect((await tool.call({ url: `${site.base}guide` }, { cwd: dir })).isError).toBeUndefined();
    expect((await tool.call({ url: `${site.base.replace(/\/$/, "")}-private/x` }, { cwd: dir })).isError).toBe(true);
  });
});

describe("Important 5: SSE upstreams are not reached through the proxy", () => {
  test("an egress server of type sse is refused at connect: streamable HTTP only", async () => {
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      await mcp.connectAll({ gh: { ...egressMcpServer({ proxyUrl: proxy.url, upstream: "github-mcp", tokenFile }), type: "sse" } }, reg);
      expect(mcp.status()[0]!.error).toContain("streamable HTTP only");
    } finally {
      await mcp.close();
    }
  });
});

describe("minors", () => {
  test("a proxied server's non-credential headers reach the proxy; its credential headers never do", async () => {
    const before = proxy.seen.length;
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      await mcp.connectAll({ gh: { ...egressMcpServer({ proxyUrl: proxy.url, upstream: "github-mcp", tokenFile }), headers: { "X-Trace-Tag": "t-1", Authorization: "Bearer engine-held" } } }, reg);
      expect(mcp.status()[0]!.ok).toBe(true);
      for (const r of proxy.seen.slice(before)) {
        expect(r.headers["x-trace-tag"]).toBe("t-1");
        expect(r.headers.authorization).toBeUndefined();
      }
    } finally {
      await mcp.close();
    }
  });

  test("the refusal metric names its cause: a rejected session token is not a policy refusal", async () => {
    const gw = join(dir, "gateway.token");
    writeFileSync(gw, "eyJzIjoxfQ.round1-session.sig");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: RequestInit) => {
      const model = JSON.parse(init.body as string).model as string;
      return model === "m-401"
        ? new Response(JSON.stringify({ error: { type: "authentication_error", code: "invalid_api_key", message: "bad" } }), { status: 401 })
        : new Response(JSON.stringify({ error: { type: "permission_error", code: "model_not_allowed", message: "no" } }), { status: 403 });
    }) as unknown as typeof fetch;
    try {
      const metrics = new MemoryMetrics();
      for (const model of ["m-401", "m-403"]) {
        const root = mkdtempSync(join(tmpdir(), "p6-metric-"));
        const session = new AgentSession({ agentId: "a", sessionId: "s", workspace: "w", cwd: root, model, systemPrompt: "t", tools: new ToolRegistry(), store: new LocalStore(root), model_client: new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile: gw } }), canUseTool: createPolicy({ mode: "autopilot" }), metrics, stamp: { hop: "infra@1.0.0", origin: "test", workspace: "w" } });
        for await (const _ of session.run({ text: "go" })) void _;
        rmSync(root, { recursive: true, force: true });
      }
      expect(metrics.counters.get("agent.model_access_denied{cause=session_token,model=m-401}")).toBe(1);
      expect(metrics.counters.get("agent.model_access_denied{cause=model_policy,model=m-403}")).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("postFeedback with an unreadable token file is logged, never silent, never a throw", () => {
    const lines: string[] = [];
    const client = new GatewayClient({ baseUrl: "http://gw", apiKey: { tokenFile: join(dir, "missing.token") }, logger: new JsonLogger({ sink: (l) => lines.push(l) }) });
    expect(() => client.postFeedback({ model: "m", task_type: "coding", outcome: "accepted" })).not.toThrow();
    expect(lines.some((l) => l.includes("feedback dropped") && l.includes("missing.token"))).toBe(true);
  });

  test("every session or egress token the engine reads is registered for masking", async () => {
    clearSecrets();
    const gw = join(dir, "gw-mask.token");
    writeFileSync(gw, "eyJtYXNrIjoxfQ.session-to-mask.sig");
    const { readSessionToken } = await import("../src/gateway/client");
    const { readEgressToken } = await import("../src/egress/proxy");
    readSessionToken(gw);
    readEgressToken(tokenFile);
    expect(redactText("a eyJtYXNrIjoxfQ.session-to-mask.sig b")).toBe("a [redacted:gateway session token] b");
    expect(redactText(`x ${TOKEN} y`)).toBe("x [redacted:egress token] y");
    clearSecrets();
  });
});

describe("review 2: W4's per-segment rule (decode each segment until stable, at most 3 rounds)", () => {
  /** Each is refused by the engine itself (`path_escape`), never left for the proxy to answer. */
  const REFUSED = [
    "%3f%2f..%2f..%2fgithub-mcp%2fx", // a segment that decodes to a query and a path
    "..;/github-mcp/x",
    ".;/x",
    "%2e%2e%3b/x", // ..;
    "a%5c..%5cb", // backslashes
    "a%00b", // NUL
    "%25252e%25252e/github-mcp/x", // three encodings of ..
    "%2525252e%2525252e/x", // four: not stable after three rounds
    "ok/%2fetc", // a segment holding a slash
  ];
  for (const path of REFUSED) {
    test(`egressUrl, egressFetch and pathUnderBase refuse ${path}`, async () => {
      expect(() => egressUrl(fetchRoute(), path)).toThrow("egress refused (path_escape) for web-fetch");
      let calls = 0;
      const base = (async () => (calls++, new Response("ok"))) as unknown as typeof fetch;
      const e = await egressFetch(fetchRoute(), base)(`${proxy.url}/v1/u/web-fetch/${path}`).catch((x: unknown) => x);
      expect((e as EgressRefusedError).code).toBe("path_escape");
      expect(calls).toBe(0);
      const { pathUnderBase } = await import("../src/tools/builtin/web");
      expect(pathUnderBase(`${site.base}${path}`, site.base)).toBeNull();
    });
  }

  test("ordinary paths still pass: encoded spaces, dotted names, .well-known, a segment that merely starts with ..", async () => {
    const { pathUnderBase } = await import("../src/tools/builtin/web");
    for (const path of ["a%20b/c.d/file.txt", ".well-known/x", "..foo/bar", "v1.2/x?q=a/../b"]) {
      expect(egressUrl(fetchRoute(), path)).toBe(`${proxy.url}/v1/u/web-fetch/${path}`);
      expect(pathUnderBase(`${site.base}${path}`, site.base)).toBe(path);
    }
  });

  test("a doubled slash under the base: pathUnderBase strips it and agrees with egressUrl (the serve crashed on `//..%2fx`)", async () => {
    const { pathUnderBase } = await import("../src/tools/builtin/web");
    expect(pathUnderBase(`${site.base}/x/y`, site.base)).toBe("x/y");
    expect(pathUnderBase(`${site.base}/..%2fx`, site.base)).toBeNull();
    const rest = pathUnderBase(`${site.base}//x`, site.base);
    expect(rest).toBe("x");
    expect(() => egressUrl(fetchRoute(), rest!)).not.toThrow();
  });
});

describe("review 3: tolerant per-byte decoding, `..;`/`.;` by prefix, the round cap, invalid UTF-8", () => {
  const githubRoute = (): EgressRoute => ({ proxyUrl: proxy.url, upstream: "github-mcp", tokenFile });

  /** Each refused with path_escape by egressUrl, egressFetch (before any request) and pathUnderBase. */
  async function expectRefused(path: string) {
    expect(segmentsSafe(path)).toBe(false);
    expect(() => egressUrl(fetchRoute(), path)).toThrow("egress refused (path_escape) for web-fetch");
    let calls = 0;
    const base = (async () => (calls++, new Response("ok"))) as unknown as typeof fetch;
    const e = await egressFetch(fetchRoute(), base)(`${proxy.url}/v1/u/web-fetch/${path}`).catch((x: unknown) => x);
    expect((e as EgressRefusedError).code).toBe("path_escape");
    expect(calls).toBe(0);
    expect(pathUnderBase(`${site.base}${path}`, site.base)).toBeNull();
  }

  /** A `%` that is not `%XX` is a literal `%` (W4's rule), never a decode error: W4 forwards each of these. */
  const ACCEPTED = ["wiki/100%25", "50%25off.md", "wiki/100%", "50%off.md", "a/%25%25/b", "%252541", "caf%C3%A9"];
  for (const path of ACCEPTED) {
    test(`${path} is an ordinary path: egressUrl and pathUnderBase keep it as sent`, () => {
      expect(segmentsSafe(path)).toBe(true);
      expect(egressUrl(fetchRoute(), path)).toBe(`${proxy.url}/v1/u/web-fetch/${path}`);
      expect(pathUnderBase(`${site.base}${path}`, site.base)).toBe(path);
    });
  }

  for (const path of ["wiki/100%25", "50%25off.md"]) {
    test(`WebFetch of ${path} is fetched at that path through the proxy, not refused`, async () => {
      const before = proxy.seen.length;
      const res = await createEgressWebFetchTool(fetchRoute(), site.base).call({ url: `${site.base}${path}` }, { cwd: dir });
      expect(res.isError).toBeUndefined();
      expect(proxy.seen.slice(before).map((r) => `${r.name}/${r.path}`)).toEqual([`web-fetch/${path}`]);
    });

    test(`an MCP server at ${path} under its upstream connects at that path, not the base`, async () => {
      const before = proxy.seen.length;
      const reg = new ToolRegistry();
      const mcp = new McpManager();
      try {
        await mcp.connectAll({ gh: egressMcpServer(githubRoute(), path) }, reg);
        expect(mcp.status()[0]).toMatchObject({ ok: true });
        const paths = proxy.seen.slice(before).map((r) => r.path);
        expect(paths.length).toBeGreaterThan(0);
        expect(new Set(paths)).toEqual(new Set([path]));
      } finally {
        await mcp.close();
      }
    });
  }

  const REFUSED: Array<[string, string]> = [
    ["%2e%2e%2f%/x", "a decode that leaves a lone `%` is not stable: `../%` holds a slash"],
    ["%2e%2e%2f%zz/x", "`../%zz` holds a slash"],
    ["..;jsessionid=1/x", "starts with `..;`"],
    [".;x/y", "starts with `.;`"],
    ["%2e%2e%3bfoo/x", "decodes to `..;foo`"],
    ["%2e%3bx/y", "decodes to `.;x`"],
    ["%25252541", "`A` encoded four times: not stable after three rounds"],
    ["%2525252541", "`A` encoded five times"],
    ["%c0%ae", "overlong `.`: not UTF-8"],
    ["%c0%ae%c0%ae/github-mcp/x", "overlong `..`: not UTF-8"],
    ["%E9", "a bare Latin-1 byte: not UTF-8"],
    ["%25E9", "a Latin-1 byte after two rounds: not UTF-8"],
    ["%e0%80%ae", "three-byte overlong `.`"],
  ];
  for (const [path, why] of REFUSED) {
    test(`${path} is refused: ${why}`, async () => {
      await expectRefused(path);
    });
  }
});
