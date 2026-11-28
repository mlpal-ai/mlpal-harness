import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { McpManager } from "../src/mcp/manager";
import { parseSecretRefValue, resolveSecretRefsIn, SecretRefUnavailableError, secretRefsIn, secretRefValue } from "../src/mcp/secret-refs";
import { startWebLogin, WebLoginStateError } from "../src/mcp/web-login";
import { ToolRegistry } from "../src/tools/registry";
import { fakeOAuthMcp } from "./fake-oauth-mcp";

const stops: Array<() => void> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const authDir = () => {
  const d = join(tmpdir(), `yodex-weblogin-${crypto.randomUUID()}`);
  dirs.push(d);
  return d;
};

describe("secret references (tools-admin T-1)", () => {
  test("a reference is written, parsed and found", () => {
    expect(secretRefValue("ELEVEN_KEY")).toBe("${MLPAL_SECRET_ELEVEN_KEY}");
    expect(secretRefValue("ELEVEN_KEY", "bearer")).toBe("Bearer ${MLPAL_SECRET_ELEVEN_KEY}");
    expect(parseSecretRefValue("Bearer ${MLPAL_SECRET_ELEVEN_KEY}")).toEqual({ name: "ELEVEN_KEY", scheme: "bearer" });
    expect(parseSecretRefValue("${MLPAL_SECRET_x}")).toEqual({ name: "x" });
    for (const literal of ["sk_live_123", "Bearer sk_live", "${HOME}", "x${MLPAL_SECRET_A}", "${MLPAL_SECRET_a-b}"]) expect(parseSecretRefValue(literal)).toBeNull();
    expect(secretRefsIn("a ${MLPAL_SECRET_A} b ${MLPAL_SECRET_B} ${MLPAL_SECRET_A}")).toEqual(["A", "B"]);
  });

  test("resolution replaces each reference and names only the missing ones", async () => {
    const vault: Record<string, string> = { A: "va" };
    const resolve = async (n: string) => vault[n];
    expect(await resolveSecretRefsIn("Bearer ${MLPAL_SECRET_A}", resolve)).toBe("Bearer va");
    const err = await resolveSecretRefsIn("${MLPAL_SECRET_A}${MLPAL_SECRET_B}", resolve).catch((e) => e);
    expect(err).toBeInstanceOf(SecretRefUnavailableError);
    expect(err.secrets).toEqual(["B"]);
    expect(String(err.message)).not.toContain("va");
    expect(await resolveSecretRefsIn("${MLPAL_SECRET_A}", undefined).catch((e) => e.message)).toContain("no secrets source");
  });

  test("the manager sends the resolved value; a value that is a secret is not env-expanded", async () => {
    const srv = fakeOAuthMcp();
    stops.push(srv.stop);
    process.env.TOOLS_ADMIN_TEST_VAR = "from-env";
    const mcp = new McpManager();
    mcp.setSecretResolver(async (n) => (n === "KEY" ? "s3cr${TOOLS_ADMIN_TEST_VAR}et" : undefined));
    const { connected } = await mcp.connectAll({ eleven: { url: srv.url, headers: { "xi-api-key": "${MLPAL_SECRET_KEY}", "x-env": "${TOOLS_ADMIN_TEST_VAR}" } } }, new ToolRegistry());
    delete process.env.TOOLS_ADMIN_TEST_VAR;
    expect(connected).toBe(1);
    expect(srv.seen[0]!["xi-api-key"]).toBe("s3cr${TOOLS_ADMIN_TEST_VAR}et");
    expect(srv.seen[0]!["x-env"]).toBe("from-env");
    // R51: the value went into that server's request only; nothing put it in the engine's environment, which every
    // command, hook, sub-agent and stdio server's environment is built from.
    expect(JSON.stringify(process.env)).not.toContain("s3cr");
  });

  test("an unresolvable reference fails that server's connect with the secret's name, nothing sent", async () => {
    const srv = fakeOAuthMcp();
    stops.push(srv.stop);
    const mcp = new McpManager();
    const { connected } = await mcp.connectAll({ eleven: { url: srv.url, headers: { "xi-api-key": "${MLPAL_SECRET_GONE}" } } }, new ToolRegistry());
    expect(connected).toBe(0);
    expect(mcp.status()[0]?.error).toContain("MLPal secret GONE");
    expect(srv.seen).toHaveLength(0);
  });
});

describe("web OAuth sign-in (tools-admin T-1)", () => {
  const redirectUrl = "https://workspace.example/w/1/tools/oauth-callback";

  test("plan → authorize → finish saves a token the manager then connects with", async () => {
    const srv = fakeOAuthMcp({ oauth: true });
    stops.push(srv.stop);
    const dir = authDir();
    const start = await startWebLogin({ server: "linear", config: { url: srv.url, oauth: {} }, authDir: dir, redirectUrl, state: "st-1" });
    expect(start.kind).toBe("redirect");
    if (start.kind !== "redirect") return;
    const back = await srv.authorize(start.url);
    expect(back.redirect.origin + back.redirect.pathname).toBe(redirectUrl);
    expect(back.state).toBe("st-1");
    expect(await start.finish(back.code!, back.state!)).toEqual({ tools: 2 });
    const mcp = new McpManager(undefined, dir);
    expect((await mcp.connectAll({ linear: { url: srv.url, oauth: {} } }, new ToolRegistry())).connected).toBe(1);
    // A second sign-in with a saved token answers at once.
    expect(await startWebLogin({ server: "linear", config: { url: srv.url, oauth: {} }, authDir: dir, redirectUrl, state: "st-2" })).toEqual({ kind: "authorized", tools: 2 });
  });

  test("a code that comes back with another state is refused and nothing is redeemed", async () => {
    const srv = fakeOAuthMcp({ oauth: true });
    stops.push(srv.stop);
    const start = await startWebLogin({ server: "linear", config: { url: srv.url, oauth: {} }, authDir: authDir(), redirectUrl, state: "mine" });
    if (start.kind !== "redirect") throw new Error("expected a redirect");
    const back = await srv.authorize(start.url);
    await expect(start.finish(back.code!, "theirs")).rejects.toBeInstanceOf(WebLoginStateError);
    expect(srv.issued.tokens).toBe(0);
    start.close();
  });

  test("a registration made for a terminal login's loopback redirect is not reused for the web redirect", async () => {
    const srv = fakeOAuthMcp({ oauth: true });
    stops.push(srv.stop);
    const dir = authDir();
    const cli = await startWebLogin({ server: "linear", config: { url: srv.url, oauth: {} }, authDir: dir, redirectUrl: "http://localhost:4567/callback", state: "a" });
    if (cli.kind !== "redirect") throw new Error("expected a redirect");
    cli.close();
    const web = await startWebLogin({ server: "linear", config: { url: srv.url, oauth: {} }, authDir: dir, redirectUrl, state: "b" });
    if (web.kind !== "redirect") throw new Error("expected a redirect");
    const back = await srv.authorize(web.url);
    expect(back.redirect.origin).toBe("https://workspace.example");
    expect((await web.finish(back.code!, "b")).tools).toBe(2);
  });
});
