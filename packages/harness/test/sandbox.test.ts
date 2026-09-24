import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { clearSecrets, redactResult, redactText, registerSecret } from "../src/obs/redact";
import { createSandbox, hostAllowed, isSecretName, resolveSandboxSpec, scrubEnv, seatbeltProfile, startAllowlistProxy } from "../src/sandbox";
import { bwrapArgv } from "../src/sandbox/bwrap";

/** Async on purpose: the allowlist proxy runs on this process's event loop, and a synchronous
 *  spawn would starve it — in production the child is always spawned asynchronously. */
async function sh(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe" });
  const [out, errText, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out: out + errText };
}

const curl = (...args: string[]) => sh(["curl", "-sS", ...args]);

describe("sandbox spec", () => {
  test("workspace mode: roots + scratch + caches writable, credential paths unreadable, allowRead lifts a default", () => {
    const spec = resolveSandboxSpec(
      { filesystem: { allowRead: ["~/.kube"], allowWrite: ["~/deploy-logs"] }, network: { mode: "allowlist", allow: ["*.mlpal.ai"] } },
      { roots: ["/work/repo"], home: "/home/u", hasSafetyBlock: true },
    );
    expect(spec.filesystem.mode).toBe("workspace");
    expect(spec.filesystem.writable).toContain("/work/repo");
    expect(spec.filesystem.writable).toContain("/tmp");
    expect(spec.filesystem.writable).toContain("/home/u/.npm");
    expect(spec.filesystem.writable).toContain("/home/u/deploy-logs");
    expect(spec.filesystem.unreadable).toContain("/home/u/.aws");
    expect(spec.filesystem.unreadable).not.toContain("/home/u/.kube");
    expect(spec.filesystem.unreadable).toContain("/home/u/.ssh/id_ed25519");
    expect(spec.network).toEqual({ mode: "allowlist", allow: ["*.mlpal.ai"] });
    expect(spec.required).toBe(true);
  });

  test("readOnly mode keeps only scratch writable; no policy = open network, not required", () => {
    const spec = resolveSandboxSpec({ filesystem: { mode: "readOnly" } }, { roots: ["/work/repo"], home: "/home/u" });
    expect(spec.filesystem.writable).not.toContain("/work/repo");
    expect(spec.filesystem.writable).toContain("/tmp");
    expect(spec.network.mode).toBe("all");
    expect(spec.required).toBe(false);
  });

  test("host allowlist: exact and suffix wildcard", () => {
    expect(hostAllowed("api.github.com", ["api.github.com"])).toBe(true);
    expect(hostAllowed("github.com", ["api.github.com"])).toBe(false);
    expect(hostAllowed("gw.mlpal.ai", ["*.mlpal.ai"])).toBe(true);
    expect(hostAllowed("mlpal.ai", ["*.mlpal.ai"])).toBe(true);
    expect(hostAllowed("evilmlpal.ai", ["*.mlpal.ai"])).toBe(false);
  });
});

describe("env scrub", () => {
  test("secret-looking names go, ordinary names stay, keep wins", () => {
    const { env, scrubbed, removed } = scrubEnv(
      { PATH: "/bin", HOME: "/h", YODEX_API_KEY: "k1", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1", GITHUB_TOKEN: "t", SSH_AUTH_SOCK: "/s", DB_PASSWORD: "p" },
      ["GITHUB_TOKEN"],
    );
    expect(Object.keys(env).sort()).toEqual(["AWS_REGION", "GITHUB_TOKEN", "HOME", "PATH", "SSH_AUTH_SOCK"]);
    expect(scrubbed).toEqual(["AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "YODEX_API_KEY"]);
    expect(removed.YODEX_API_KEY).toBe("k1");
    expect(isSecretName("ANTHROPIC_API_KEY")).toBe(true);
    expect(isSecretName("TERM")).toBe(false);
  });
});

describe("redaction", () => {
  beforeAll(() => clearSecrets());
  afterAll(() => clearSecrets());
  test("registered values are masked in strings, blocks and diffs; short values are never registered", () => {
    registerSecret("gateway key", "mlpal_sk_0123456789abcdef");
    registerSecret("short", "abc");
    expect(redactText("key=mlpal_sk_0123456789abcdef; abc")).toBe("key=[redacted:gateway key]; abc");
    const res = redactResult({
      content: [{ type: "text", text: "x mlpal_sk_0123456789abcdef" }],
      meta: { diff: "+mlpal_sk_0123456789abcdef" },
    });
    expect((res.content as { text: string }[])[0]!.text).toBe("x [redacted:gateway key]");
    expect(res.meta?.diff).toBe("+[redacted:gateway key]");
  });
});

describe("allowlist proxy", () => {
  test("tunnels to an allowed host and refuses the rest with a recorded denial", async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response("hello from upstream") });
    const proxy = startAllowlistProxy(["127.0.0.1"]);
    try {
      const ok = await curl("-x", proxy.url, `http://127.0.0.1:${upstream.port}/`);
      expect(ok.out).toBe("hello from upstream");
      const denied = await curl("-o", "/dev/null", "-w", "%{http_code}", "-x", proxy.url, "http://example.com/");
      expect(denied.out).toBe("403");
      const tls = await curl("-o", "/dev/null", "-w", "%{http_code}", "-x", proxy.url, "https://example.com/");
      expect(tls.code).not.toBe(0); // CONNECT refused
      expect(proxy.denied).toEqual(["example.com", "example.com"]);
    } finally {
      proxy.close();
      upstream.stop(true);
    }
  }, 15_000);
});

describe("bwrap argv", () => {
  test("binds writable roots that exist, shadows credential dirs and files, unshares net for none", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    mkdirSync(join(dir, "aws"));
    writeFileSync(join(dir, "netrc"), "x");
    const argv = bwrapArgv("/usr/bin/bwrap", {
      filesystem: { mode: "workspace", writable: [dir, "/nonexistent-root"], unreadable: [join(dir, "aws"), join(dir, "netrc"), "/nonexistent-cred"] },
      network: { mode: "none", allow: [] },
      env: { keep: [] },
      required: false,
    }, ["/bin/sh", "-c", "id"]);
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/bwrap", "--ro-bind", "/"]);
    expect(argv).toContain("--bind");
    expect(argv).not.toContain("/nonexistent-root");
    expect(argv.join(" ")).toContain(`--tmpfs ${join(dir, "aws")}`);
    expect(argv.join(" ")).toContain(`--ro-bind /dev/null ${join(dir, "netrc")}`);
    expect(argv).toContain("--unshare-net");
    expect(argv.slice(-4)).toEqual(["--", "/bin/sh", "-c", "id"]);
    rmSync(dir, { recursive: true, force: true });
  });
});

const darwin = process.platform === "darwin";
describe.if(darwin)("seatbelt (real, macOS)", () => {
  // Under the real home, not the temp tree: /var/folders is scratch and therefore writable by
  // design, so an "escape" into it would prove nothing.
  const base = join(homedir(), `.yodex-sandbox-test-${process.pid}`);
  const home = join(base, "home");
  const work = join(base, "work");
  const outside = join(base, "outside");
  beforeAll(() => {
    for (const d of [home, work, outside]) mkdirSync(d, { recursive: true });
    mkdirSync(join(home, ".aws"));
    writeFileSync(join(home, ".aws", "credentials"), "[default]\naws_secret_access_key = SECRET\n");
    writeFileSync(join(home, "readme.txt"), "public\n");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const run = (sb: ReturnType<typeof createSandbox>, cmd: string) => sh(sb.wrap(["/bin/bash", "-c", cmd]), { cwd: work, env: sb.env() });

  test("workspace mode: writes inside roots succeed, outside are refused by the OS, credential reads are refused", async () => {
    const spec = resolveSandboxSpec(undefined, { roots: [work], home });
    const sb = createSandbox(spec, { baseEnv: { PATH: process.env.PATH ?? "", HOME: home, YODEX_API_KEY: "mlpal_sk_secretsecret" } });
    try {
      expect(sb.available).toBe(true);
      expect(sb.platform).toBe("seatbelt");
      expect((await run(sb, "echo ok > inside.txt && cat inside.txt")).out.trim()).toBe("ok");
      const esc = await run(sb, `echo pwned > ${outside}/escape.txt`);
      expect(esc.code).not.toBe(0);
      expect(esc.out).toContain("Operation not permitted");
      const cred = await run(sb, `cat ${home}/.aws/credentials`);
      expect(cred.code).not.toBe(0);
      expect(cred.out).not.toContain("SECRET");
      expect((await run(sb, `cat ${home}/readme.txt`)).out.trim()).toBe("public");
      // env scrub: the key is gone from the child's environment
      expect((await run(sb, "env")).out).not.toContain("YODEX_API_KEY");
      expect(sb.scrubbed).toEqual(["YODEX_API_KEY"]);
      expect(sb.describe()).toContain("seatbelt");
    } finally {
      sb.close();
    }
  });

  test("readOnly mode: even the workspace is unwritable, /tmp still is", async () => {
    const spec = resolveSandboxSpec({ filesystem: { mode: "readOnly" } }, { roots: [work], home });
    const sb = createSandbox(spec, { baseEnv: { PATH: process.env.PATH ?? "", HOME: home } });
    try {
      expect((await run(sb, "echo x > ro.txt")).code).not.toBe(0);
      expect((await run(sb, "echo x > /tmp/sb-ro-probe && rm /tmp/sb-ro-probe")).code).toBe(0);
    } finally {
      sb.close();
    }
  });

  test("network none: outbound is refused by the kernel", async () => {
    const spec = resolveSandboxSpec({ network: { mode: "none" } }, { roots: [work], home });
    const sb = createSandbox(spec, { baseEnv: { PATH: process.env.PATH ?? "", HOME: home } });
    try {
      const r = await run(sb, "curl -sS -m 5 https://example.com -o /dev/null");
      expect(r.code).not.toBe(0);
    } finally {
      sb.close();
    }
  });

  test("network allowlist: only the proxy is reachable; allowed host works through it, others are 403", async () => {
    const upstream = Bun.serve({ port: 0, fetch: () => new Response("allowed") });
    const spec = resolveSandboxSpec({ network: { mode: "allowlist", allow: ["127.0.0.1"] } }, { roots: [work], home });
    const sb = createSandbox(spec, { baseEnv: { PATH: process.env.PATH ?? "", HOME: home } });
    try {
      expect(sb.env().HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // NO_PROXY keeps loopback direct, so reach the local upstream explicitly through the proxy
      expect((await run(sb, `curl -sS -x "$HTTP_PROXY" http://127.0.0.1:${upstream.port}/`)).out.trim()).toBe("allowed");
      const denied = await run(sb, 'curl -sS -o /dev/null -w "%{http_code}" http://example.com/');
      expect(denied.out.trim()).toBe("403");
      expect(sb.deniedHosts).toEqual(["example.com"]);
      // bypassing the proxy variables does not help: the kernel only allows loopback
      const direct = await run(sb, "curl -sS -m 5 --noproxy '*' https://example.com -o /dev/null");
      expect(direct.code).not.toBe(0);
    } finally {
      sb.close();
      upstream.stop(true);
    }
  }, 20_000);

  test("profile text names every writable root and unreadable path", () => {
    const spec = resolveSandboxSpec(undefined, { roots: ["/work/a b"], home: "/home/u" });
    const p = seatbeltProfile(spec);
    expect(p).toContain('(allow file-write* (subpath "/work/a b"))');
    expect(p).toContain('(deny file-read* (literal "/home/u/.aws") (subpath "/home/u/.aws"))');
    expect(p.startsWith("(version 1)\n(allow default)\n")).toBe(true);
    expect(readFileSync("/usr/bin/sandbox-exec").length).toBeGreaterThan(0);
  });
});
