import { describe, expect, test } from "bun:test";

/**
 * E-27 on this line: a key in the environment is not consent. The live gateway tests are run in a child `bun test`
 * whose environment holds only a stand-in key and a gateway URL pointing at a local listener, so the child can reach
 * nothing but this test. Without YODEX_LIVE_TESTS=1 the listener must see no request; with it, the same child does
 * call (which shows the probe would catch a call).
 */
async function liveRun(optIn: boolean): Promise<{ requests: number; output: string }> {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return new Response("refused by the probe", { status: 401 });
    },
  });
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      YODEX_API_KEY: "stand-in-not-a-key",
      YODEX_GATEWAY_URL: `http://127.0.0.1:${server.port}`,
      ...(optIn ? { YODEX_LIVE_TESTS: "1" } : {}),
    };
    const child = Bun.spawn([process.execPath, "test", "test/gateway.test.ts", "test/registry.test.ts", "-t", "live"], {
      cwd: new URL("..", import.meta.url).pathname,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    return { requests, output: out + err };
  } finally {
    server.stop(true);
  }
}

describe("live gateway tests need the opt-in, whatever keys are set (E-27)", () => {
  test("a key without YODEX_LIVE_TESTS=1: both live tests skip and no request is made", async () => {
    const r = await liveRun(false);
    expect(r.requests).toBe(0);
    expect(r.output).toMatch(/\b2 skip\b/);
  }, 60_000);

  test("with YODEX_LIVE_TESTS=1 the same run does call (the probe sees it)", async () => {
    const r = await liveRun(true);
    expect(r.requests).toBeGreaterThan(0);
  }, 60_000);
});
