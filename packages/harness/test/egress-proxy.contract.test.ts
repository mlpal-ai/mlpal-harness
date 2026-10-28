/**
 * The engine's proxy client against W4's egress proxy contract fixtures (test/fixtures/egress-proxy, see its
 * README): every `proxy-*` file is replayed through `egressFetch` against the fake proxy, which must answer the
 * fixture's status, body and `X-Harness-Egress` header, and the client must read it as the contract says (a refusal
 * is an EgressRefusedError with the fixture's code; a 3xx is returned, never followed; an injected credential is the
 * proxy's, never the engine's). The vault's own routes are W6's and skipped by name.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EgressRefusedError, egressFetch, egressMcpServer, egressUrl, type EgressRoute } from "../src/egress/proxy";
import { type EgressFixture, egressFixtures } from "./egress-fixtures";
import { startFakeEgressProxy } from "./fake-egress-proxy";

const TOKEN = "eyJyb2xlIjoiZW5naW5lIn0.contract-egress.sig";
const VALUE = "vault-value-for-the-contract";

let dir: string;
let tokenFile: string;
let badTokenFile: string;
let upstream: { base: string; saw: Array<{ headers: Record<string, string>; method: string; pathAndQuery: string }>; stop(): void };
let proxy: ReturnType<typeof startFakeEgressProxy>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "p6-contract-"));
  tokenFile = join(dir, "egress.token");
  badTokenFile = join(dir, "other.token");
  writeFileSync(tokenFile, TOKEN);
  writeFileSync(badTokenFile, "not-the-sessions-token");
  const saw: Array<{ headers: Record<string, string>; method: string; pathAndQuery: string }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      // Drain the body: an unread chunked body leaves the keep-alive connection dirty for the next case (a 400).
      await req.arrayBuffer();
      const u = new URL(req.url);
      saw.push({ headers: Object.fromEntries([...req.headers].map(([k, v]) => [k.toLowerCase(), v])), method: req.method, pathAndQuery: u.pathname + u.search });
      if (u.pathname === "/mcp/moved") return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/steal" } });
      return Response.json({ ok: true });
    },
  });
  upstream = { base: `http://127.0.0.1:${server.port}/mcp/`, saw, stop: () => server.stop(true) };
  proxy = startFakeEgressProxy({
    token: TOKEN,
    upstreams: [
      { name: "github-mcp", base_url: upstream.base, inject: [{ header: "authorization", scheme: "bearer", value: VALUE }] },
      { name: "dead-mcp", base_url: "http://127.0.0.1:1/", inject: [] },
    ],
  });
});
afterAll(() => {
  proxy.stop();
  upstream.stop();
  rmSync(dir, { recursive: true, force: true });
});

const route = (over: Partial<EgressRoute> = {}): EgressRoute => ({ proxyUrl: proxy.url, upstream: "github-mcp", tokenFile, ...over });

/** One request through the engine's client; `answer` is the response as the proxy sent it (before the client read it). */
async function through(r: EgressRoute, path: string, init: RequestInit = {}) {
  let answer: { status: number; headers: Headers; body: unknown } | undefined;
  const recording = (async (input: Parameters<typeof fetch>[0], i?: RequestInit) => {
    const res = await fetch(input, i);
    const text = await res.clone().text();
    answer = { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    return res;
  }) as typeof fetch;
  const result = await egressFetch(r, recording)(egressUrl(r, path), init).then(
    (res) => ({ res, error: undefined }),
    (error: unknown) => ({ res: undefined, error }),
  );
  return { ...result, answer: answer! };
}

/** How each refusal fixture's case is produced against the fake. */
const REFUSAL_SCENARIOS: Record<string, () => { r: EgressRoute; path: string }> = {
  "proxy-401-token-invalid": () => ({ r: route({ tokenFile: badTokenFile }), path: "" }),
  "proxy-403-upstream-not-granted": () => ({ r: route({ upstream: "ghost-mcp" }), path: "" }),
  "proxy-502-upstream-unreachable": () => ({ r: route({ upstream: "dead-mcp" }), path: "" }),
};

function expectRefusal(f: EgressFixture, got: Awaited<ReturnType<typeof through>>, upstreamName: string) {
  expect(got.answer.status).toBe(f.status!);
  expect(got.answer.body).toEqual(f.body);
  expect(got.answer.headers.get("x-harness-egress")).toBe(f.headers!["x-harness-egress"]!);
  expect(got.answer.headers.get("content-type")).toStartWith(f.content_type!);
  const code = (f.body as { code: string }).code;
  expect(got.error).toBeInstanceOf(EgressRefusedError);
  const e = got.error as EgressRefusedError;
  expect({ code: e.code, status: e.status, message: e.message }).toEqual({ code, status: f.status!, message: `egress refused (${code}) for ${upstreamName}` });
}

const fixtures = egressFixtures();

describe("W4's egress proxy fixtures (mlpal-harness-stack d5d56a5)", () => {
  test("the set is the one the README pins: 26 files, ten proxy routes, the token claims", () => {
    expect(fixtures.length).toBe(26);
    expect(fixtures.filter((f) => f.name.startsWith("proxy-")).length).toBe(10);
    expect(fixtures.some((f) => f.name === "egress-token-claims")).toBe(true);
  });

  for (const f of fixtures) {
    if (f.name === "egress-token-claims") {
      test(`${f.name}: each upstream of the token is a route the engine reaches at the proxy`, () => {
        const ups = (f.body as { upstreams: Array<{ name: string; base_url: string; inject: Array<{ header: string; scheme: string; secret: string }> }> }).upstreams;
        expect(ups.length).toBeGreaterThan(0);
        for (const u of ups) {
          const r: EgressRoute = { proxyUrl: "http://egress-proxy.harness:7401", upstream: u.name, tokenFile };
          expect(egressMcpServer(r)).toEqual({ url: `http://egress-proxy.harness:7401/v1/u/${u.name}/`, egress: r });
          expect(u.inject.every((i) => i.secret.startsWith("vlt_"))).toBe(true); // a reference only: the engine never holds a value
        }
      });
      continue;
    }
    if (!f.name.startsWith("proxy-")) {
      test.skip(`${f.name}: vault-only route (${f.route}); the engine consumes the proxy routes only`, () => {});
      continue;
    }
    if (f.name === "proxy-200-injected") {
      test(`${f.name}: ${f.case}: the body passes back, the vault's credential reached the upstream, the engine's token did not`, async () => {
        const got = await through(route(), "tools/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(f.request!.body) });
        expect(got.error).toBeUndefined();
        expect(got.res!.status).toBe(f.status!);
        expect(got.res!.headers.get("content-type")).toStartWith(f.content_type!);
        expect(await got.res!.json()).toEqual(f.body);
        expect(got.res!.headers.get("x-harness-egress")).toBeNull();
        const saw = upstream.saw.at(-1)!;
        expect(saw.method).toBe(f.upstream_saw!.method!);
        expect(saw.pathAndQuery).toBe(f.upstream_saw!.path_and_query!);
        expect(saw.headers.authorization).toBe(f.upstream_saw!.authorization!.replace("<value of vlt_…>", VALUE));
        expect(saw.headers["x-harness-egress-token"] ?? null).toBe(f.upstream_saw!["x-harness-egress-token"]!);
      });
      continue;
    }
    if (f.name === "proxy-302-not-followed") {
      test(`${f.name}: ${f.case}: the client hands the 3xx back with its location, never following it`, async () => {
        const before = upstream.saw.length;
        const got = await through(route(), "moved");
        expect(got.error).toBeUndefined();
        expect(got.res!.status).toBe(f.status!);
        expect(got.res!.headers.get("location")).toBe(f.headers!.location!);
        expect(got.res!.headers.get("x-harness-egress")).toBeNull();
        expect(upstream.saw.length).toBe(before + 1); // the upstream's one answer; nothing went to the location
      });
      continue;
    }
    if (f.headers?.["x-harness-egress"] === "refused") {
      test(`${f.name}: ${f.case}: a typed refusal, its status, body and header as the fixture`, async () => {
        const scenario = REFUSAL_SCENARIOS[f.name]?.();
        if (!scenario) proxy.refuseNext((f.body as { code: string }).code);
        const { r, path } = scenario ?? { r: route(), path: "" };
        expectRefusal(f, await through(r, path), r.upstream);
      });
      continue;
    }
    test(`${f.name}: a proxy route this test has no scenario for`, () => {
      throw new Error(`add a scenario for ${f.name} (${f.case})`);
    });
  }
});
