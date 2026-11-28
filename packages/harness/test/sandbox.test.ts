import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { clearSecrets, redactResult, redactText, registerSecret } from "../src/obs/redact";
import { bwrapAppArmorInstall, bwrapAppArmorProfile, bwrapHint, bwrapTrust, createSandbox, DEFAULT_UNREADABLE, endpointDenied, hostAllowed, isSecretName, lookupPasswdHome, resolveSandboxSpec, sandboxRecord, scrubEnv, seatbeltProfile, startAllowlistProxy, unenforcedDeny } from "../src/sandbox";
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
    expect(spec.network).toEqual({ mode: "allowlist", allow: ["*.mlpal.ai"], hostPorts: [], deny: [] });
    expect(spec.required).toBe(true);
  });

  test("readOnly mode keeps only scratch writable; no policy = open network, not required", () => {
    const spec = resolveSandboxSpec({ filesystem: { mode: "readOnly" } }, { roots: ["/work/repo"], home: "/home/u" });
    expect(spec.filesystem.writable).not.toContain("/work/repo");
    expect(spec.filesystem.writable).toContain("/tmp");
    expect(spec.network.mode).toBe("all");
    expect(spec.required).toBe(false);
  });

  test("unchanged when $HOME is the real home: the defaults once each", () => {
    const spec = resolveSandboxSpec(undefined, { roots: ["/w"], home: "/home/u", realHome: "/home/u" });
    expect(spec.filesystem.unreadable).toEqual(DEFAULT_UNREADABLE.map((p) => `/home/u/${p.slice(2)}`));
  });
});

describe("sandbox spec under a throwaway $HOME (E-16)", () => {
  const opts = { roots: ["/w"], home: "/tmp/throwaway", realHome: "/home/op" };

  test("the credential defaults are denied under the real home as well as $HOME", () => {
    const { unreadable } = resolveSandboxSpec(undefined, opts).filesystem;
    for (const p of DEFAULT_UNREADABLE) {
      expect(unreadable).toContain(`/tmp/throwaway/${p.slice(2)}`);
      expect(unreadable).toContain(`/home/op/${p.slice(2)}`);
    }
    expect(unreadable).toHaveLength(2 * DEFAULT_UNREADABLE.length);
  });

  test("a ~-relative allowRead lifts the run's own path only; an absolute one names the real home's", () => {
    const tilde = resolveSandboxSpec({ filesystem: { allowRead: ["~/.kube"] } }, opts).filesystem.unreadable;
    expect(tilde).not.toContain("/tmp/throwaway/.kube");
    expect(tilde).toContain("/home/op/.kube");
    const absolute = resolveSandboxSpec({ filesystem: { allowRead: ["~/.kube", "/home/op/.kube"] } }, opts).filesystem.unreadable;
    expect(absolute).not.toContain("/home/op/.kube");
  });

  test("a ~-relative denyRead is denied under both homes; an absolute one once", () => {
    const { unreadable } = resolveSandboxSpec({ filesystem: { denyRead: ["~/secrets", "/srv/oracle"] } }, opts).filesystem;
    expect(unreadable).toContain("/tmp/throwaway/secrets");
    expect(unreadable).toContain("/home/op/secrets");
    expect(unreadable.filter((p) => p === "/srv/oracle")).toHaveLength(1);
  });

  test("writes stay under $HOME: the real home gains no writable cache", () => {
    const { writable } = resolveSandboxSpec(undefined, opts).filesystem;
    expect(writable).toContain("/tmp/throwaway/.cache");
    expect(writable.some((p) => p.startsWith("/home/op"))).toBe(false);
  });

  test("a real home must be absolute; null means none", () => {
    expect(() => resolveSandboxSpec(undefined, { ...opts, realHome: "home/op" })).toThrow(/absolute/);
    expect(resolveSandboxSpec(undefined, { ...opts, realHome: null }).filesystem.unreadable).toHaveLength(DEFAULT_UNREADABLE.length);
  });

  test("a failed password lookup fails closed to $HOME alone, logged, never thrown", () => {
    const warned: Array<[string, unknown]> = [];
    const logger = { warn: (msg: string, fields?: unknown) => void warned.push([msg, fields]) };
    const { unreadable } = resolveSandboxSpec(undefined, { roots: ["/w"], home: "/tmp/throwaway", passwd: () => ({ error: "no password entry for the uid" }), logger }).filesystem;
    expect(unreadable).toEqual(DEFAULT_UNREADABLE.map((p) => `/tmp/throwaway/${p.slice(2)}`));
    expect(warned).toEqual([["sandbox.real_home_unknown", { reason: "no password entry for the uid" }]]);
  });

  test("seatbelt denies reads of the real home's credentials", () => {
    const p = seatbeltProfile(resolveSandboxSpec(undefined, opts));
    expect(p).toContain('(deny file-read* (literal "/home/op/.aws") (subpath "/home/op/.aws"))');
    expect(p).toContain('(deny file-read* (literal "/home/op/.ssh/id_ed25519") (subpath "/home/op/.ssh/id_ed25519"))');
    expect(p).toContain('(deny file-read* (literal "/tmp/throwaway/.aws") (subpath "/tmp/throwaway/.aws"))');
  });

  test("bwrap shadows the real home's credential dirs and files", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-homes-"));
    const real = join(dir, "real");
    const throwaway = join(dir, "throwaway");
    mkdirSync(join(real, ".aws"), { recursive: true });
    mkdirSync(join(real, ".ssh"), { recursive: true });
    writeFileSync(join(real, ".ssh", "id_ed25519"), "k");
    mkdirSync(throwaway);
    try {
      const argv = bwrapArgv("/usr/bin/bwrap", resolveSandboxSpec(undefined, { roots: [throwaway], home: throwaway, realHome: real }), ["/bin/true"]).join(" ");
      expect(argv).toContain(`--tmpfs ${join(real, ".aws")}`);
      expect(argv).toContain(`--ro-bind /dev/null ${join(real, ".ssh", "id_ed25519")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lookupPasswdHome: the password database, with no environment input (E-16 review)", () => {
  const out = (line: string) => () => ({ code: 0, out: `${line}\n` });

  test("darwin reads `id -P <uid>`, Linux `getent passwd <uid>`, each by absolute path", () => {
    const argvs: string[][] = [];
    const run = (line: string) => (argv: string[]) => (argvs.push(argv), out(line)());
    expect(lookupPasswdHome(501, "darwin", { run: run("op:********:501:20::0:0:Op Erator:/Users/op:/bin/zsh") })).toEqual({ home: "/Users/op" });
    expect(lookupPasswdHome(1001, "linux", { run: run("ubuntu:x:1001:1001:,,,:/home/ubuntu:/bin/bash") })).toEqual({ home: "/home/ubuntu" });
    expect(argvs).toEqual([["/usr/bin/id", "-P", "501"], ["/usr/bin/getent", "passwd", "1001"]]);
  });

  test("Linux without getent reads /etc/passwd", () => {
    const passwd = "root:x:0:0:root:/root:/bin/bash\ne2e:x:1001:1001::/home/e2e:/bin/bash\n";
    expect(lookupPasswdHome(1001, "linux", { run: () => null, readPasswd: () => passwd })).toEqual({ home: "/home/e2e" });
  });

  test("every failure is an error value, never a throw and never $HOME", () => {
    const fail = (deps: Parameters<typeof lookupPasswdHome>[2], uid: number | undefined = 501, platform: NodeJS.Platform = "darwin") => "error" in lookupPasswdHome(uid, platform, deps);
    expect(fail({ run: () => ({ code: 1, out: "" }) })).toBe(true); // no such user
    expect(fail({ run: () => null })).toBe(true); // did not run
    expect(fail({ run: out("op:*:502:20::0:0::/Users/op:/bin/zsh") })).toBe(true); // another uid's entry
    expect(fail({ run: out("op:*:501:20::0:0::relative/home:/bin/zsh") })).toBe(true); // not absolute
    expect(fail({ run: () => null, readPasswd: () => { throw new Error("EACCES"); } }, 1001, "linux")).toBe(true);
    expect(fail({}, undefined, "win32")).toBe(true);
  });

  test("a child with HOME and USER pointed elsewhere still denies the real home's credentials", async () => {
    // the real home, read independently of the code under test
    const name = Bun.spawnSync(["/usr/bin/id", "-un"], { env: {} }).stdout.toString().trim();
    const expected =
      process.platform === "darwin"
        ? /NFSHomeDirectory:\s*(\S+)/.exec(Bun.spawnSync(["/usr/bin/dscl", ".", "-read", `/Users/${name}`, "NFSHomeDirectory"], { env: {} }).stdout.toString())?.[1]
        : Bun.spawnSync(["getent", "passwd", String(process.getuid!())]).stdout.toString().trim().split(":").at(-2);
    expect(expected).toMatch(/^\//);
    const dir = mkdtempSync(join(tmpdir(), "sb-child-"));
    const throwaway = join(dir, "home");
    mkdirSync(throwaway);
    const script = join(dir, "spec.ts");
    writeFileSync(script, `import { resolveSandboxSpec } from ${JSON.stringify(join(import.meta.dir, "..", "src", "sandbox", "spec.ts"))};\nprocess.stdout.write(JSON.stringify(resolveSandboxSpec(undefined, { roots: ["/w"] }).filesystem.unreadable));\n`);
    try {
      const r = await sh([process.execPath, script], { env: { PATH: process.env.PATH ?? "", HOME: throwaway, USER: "nobody", LOGNAME: "nobody" } });
      const unreadable = JSON.parse(r.out) as string[];
      expect(unreadable).toContain(join(expected!, ".aws"));
      expect(unreadable).toContain(join(expected!, ".ssh", "id_ed25519"));
      expect(unreadable).toContain(join(throwaway, ".aws"));
      expect(unreadable).toHaveLength(2 * DEFAULT_UNREADABLE.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("sandboxRecord (E-17): which sandbox confines a session's commands, for system/init and the run records", () => {
  const ro = resolveSandboxSpec({ filesystem: { mode: "readOnly" }, network: { mode: "none" } }, { roots: ["/w"], home: "/h", hasSafetyBlock: true });
  const ws = resolveSandboxSpec({ network: { mode: "allowlist", allow: ["*.mlpal.ai"] } }, { roots: ["/w"], home: "/h" });
  const bwrapOk = { platform: "linux" as const, bwrapPath: "/usr/bin/bwrap", bwrapProbe: () => ({ ok: true }), baseEnv: {} };

  test("a local OS sandbox: its platform and the spec's modes", () => {
    const sb = createSandbox(ro, bwrapOk);
    expect(sandboxRecord(sb, null)).toEqual({ platform: "bwrap", filesystem: "readOnly", network: "none", required: true });
    sb.close();
    const mac = createSandbox(ws, { platform: "darwin", baseEnv: {} });
    if (mac.available) expect(sandboxRecord(mac, null)).toEqual({ platform: "seatbelt", filesystem: "workspace", network: "allowlist", required: false });
    mac.close();
  });

  test("a sandbox that cannot start here and is not required: none, a reason code (never the text), no modes claimed", () => {
    const none = (opts: Parameters<typeof createSandbox>[1]) => {
      const sb = createSandbox(ws, { baseEnv: {}, ...opts });
      const r = sandboxRecord(sb, null);
      sb.close();
      return r;
    };
    expect(none({ platform: "linux", bwrapPath: null })).toEqual({ platform: "none", filesystem: null, network: null, required: false, reason: "missing" });
    expect(none({ platform: "linux", bwrapPath: "/usr/bin/bwrap", bwrapProbe: () => ({ ok: false, detail: "bwrap: setting up uid map: Permission denied" }) }).reason).toBe("cannot_confine");
    expect(none({ platform: "win32" }).reason).toBe("unsupported");
  });

  test("remote hands run the commands: remote, with the template, the HOP's requirement kept", () => {
    const sb = createSandbox(ro, bwrapOk);
    expect(sandboxRecord(sb, { template: "hands" })).toEqual({ platform: "remote", filesystem: null, network: null, required: true, template: "hands" });
    sb.close();
    expect(sandboxRecord(undefined, { template: "mlpal" })).toEqual({ platform: "remote", filesystem: null, network: null, required: false, template: "mlpal" });
  });

  test("no sandbox at all (off by settings or --no-sandbox): none, reason off", () => {
    expect(sandboxRecord(undefined, null)).toEqual({ platform: "none", filesystem: null, network: null, required: false, reason: "off" });
  });
});

describe("bwrap blocked by the kernel's user-namespace restriction (E-15): the hint scopes the fix to bwrap", () => {
  const denied = "bwrap: setting up uid map: Permission denied";

  test("the profile lets the named bwrap alone create user namespaces (the workbox's bwrap-e2e profile, renamed)", () => {
    expect(bwrapAppArmorProfile("/usr/bin/bwrap")).toBe(
      ["abi <abi/4.0>,", "include <tunables/global>", "", "profile yodex-bwrap /usr/bin/bwrap flags=(unconfined) {", "  userns,", "  include if exists <local/yodex-bwrap>", "}", ""].join("\n"),
    );
    expect(bwrapAppArmorProfile("/opt/my tools/bwrap")).toContain('profile yodex-bwrap "/opt/my tools/bwrap" flags=(unconfined) {');
    // AppArmor globs in a path are escaped, so the profile attaches to that one file
    expect(bwrapAppArmorProfile("/opt/b[1]/bw*rap")).toContain("profile yodex-bwrap /opt/b\\[1\\]/bw\\*rap flags=(unconfined) {");
    expect(bwrapAppArmorProfile("/opt/{a,b} x/?")).toContain('profile yodex-bwrap "/opt/\\{a,b\\} x/\\?" flags=(unconfined) {');
  });

  test("the install line writes exactly that profile and loads it", async () => {
    const install = bwrapAppArmorInstall("/usr/local/bin/bwrap");
    expect(install.endsWith("| sudo tee /etc/apparmor.d/yodex-bwrap >/dev/null && sudo apparmor_parser -r /etc/apparmor.d/yodex-bwrap")).toBe(true);
    const printf = install.slice(0, install.indexOf(" | sudo tee"));
    expect((await sh(["/bin/sh", "-c", printf])).out).toBe(bwrapAppArmorProfile("/usr/local/bin/bwrap"));
  });

  const trusted = (real: string) => () => ({ trusted: true as const, real });

  test("the hint names the cause and the scoped profile for the real bwrap, never the global sysctl", () => {
    const hint = bwrapHint(denied, "/usr/local/bin/bwrap", trusted("/usr/bin/bwrap"));
    expect(hint).toContain("kernel.apparmor_restrict_unprivileged_userns=1");
    expect(hint).toContain(bwrapAppArmorInstall("/usr/bin/bwrap"));
    expect(hint).not.toContain("sysctl");
    expect(hint).not.toContain("=0");
    expect(bwrapHint("bwrap: execvp true: No such file", "/usr/bin/bwrap")).toBe("");
  });

  test("no profile is offered for a bwrap the user could replace: the grant would be theirs", () => {
    const hint = bwrapHint(denied, "/home/u/bin/bwrap", () => ({ trusted: false, why: "/home/u/bin/bwrap is not owned by root" }));
    expect(hint).toContain("no AppArmor profile is offered for this bwrap, since /home/u/bin/bwrap is not owned by root");
    expect(hint).not.toContain("apparmor_parser");
  });

  test("bwrapTrust: a file this user owns is not trusted; a root-owned system binary is, by its real path", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-trust-"));
    const mine = join(dir, "bwrap");
    writeFileSync(mine, "#!/bin/sh\n");
    try {
      expect(bwrapTrust(mine).trusted).toBe(false);
      expect(bwrapTrust(join(dir, "absent"))).toMatchObject({ trusted: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (process.getuid?.() !== 0) expect(bwrapTrust("/bin/sh")).toEqual({ trusted: true, real: realpathSync("/bin/sh") });
  });

  test("a sandbox refused by the probe carries the hint for the bwrap it found", () => {
    const sb = createSandbox(resolveSandboxSpec(undefined, { roots: ["/w"], home: "/h" }), { platform: "linux", bwrapPath: "/usr/local/bin/bwrap", bwrapProbe: () => ({ ok: false, detail: denied }), bwrapTrust: trusted("/usr/local/bin/bwrap"), baseEnv: {} });
    expect(sb.reason).toContain("profile yodex-bwrap /usr/local/bin/bwrap");
    expect(sb.describe()).toContain("NOT confined");
    sb.close();
  });
});

describe("sandbox network matching", () => {
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

  test("the mlpal CLI's credential helper settings stay; mlpal secrets still go", () => {
    const { env, scrubbed } = scrubEnv({
      PATH: "/bin",
      MLPAL_CREDENTIAL_HELPER: "/run/helper.sock",
      MLPAL_CREDENTIAL_HELPER_UID: "1001",
      MLPAL_API_KEY: "k",
      MLPAL_TOKEN: "t",
      MLPAL_ACCESS_TOKEN: "a",
      MLPAL_CREDENTIALS: "c",
    });
    expect(env.MLPAL_CREDENTIAL_HELPER).toBe("/run/helper.sock");
    expect(env.MLPAL_CREDENTIAL_HELPER_UID).toBe("1001");
    expect(scrubbed).toEqual(["MLPAL_ACCESS_TOKEN", "MLPAL_API_KEY", "MLPAL_CREDENTIALS", "MLPAL_TOKEN"]);
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

describe("host network (D-55 governed kube): the proxy port reachable, the real cluster endpoint refused", () => {
  test("the spec carries the host's ports and denied endpoints; loopback aliases match a loopback endpoint", () => {
    const spec = resolveSandboxSpec(undefined, { roots: ["/w"], home: "/h", hostNetwork: { hostPorts: [40001], deny: ["127.0.0.1:6443", "ABC.eks.amazonaws.com:443"] } });
    expect(spec.network).toEqual({ mode: "all", allow: [], hostPorts: [40001], deny: ["127.0.0.1:6443", "abc.eks.amazonaws.com:443"] });
    expect(endpointDenied("localhost", 6443, spec.network.deny)).toBe(true);
    expect(endpointDenied("[::1]", 6443, spec.network.deny)).toBe(true);
    expect(endpointDenied("127.0.0.1", 6444, spec.network.deny)).toBe(false);
    expect(endpointDenied("abc.eks.amazonaws.com.", 443, spec.network.deny)).toBe(true);
    expect(endpointDenied("other.eks.amazonaws.com", 443, spec.network.deny)).toBe(false);
  });

  test("seatbelt refuses a loopback endpoint by port in every mode and keeps the host ports open under none", () => {
    for (const mode of ["all", "allowlist", "none"] as const) {
      const p = seatbeltProfile(resolveSandboxSpec({ network: { mode } }, { roots: ["/w"], home: "/h", hostNetwork: { hostPorts: [40001], deny: ["127.0.0.1:6443"] } }));
      // the deny is the profile's last network rule, so no allow above it wins
      expect(p.trimEnd().split("\n").at(-1)).toBe('(deny network-outbound (remote ip "localhost:6443"))');
      if (mode === "none") expect(p).toContain('(allow network-outbound (remote ip "localhost:40001"))');
    }
  });

  test("what the platform cannot refuse is reported, never silent", () => {
    const at = (mode: "all" | "allowlist" | "none") => resolveSandboxSpec({ network: { mode } }, { roots: ["/w"], home: "/h", hostNetwork: { deny: ["127.0.0.1:6443", "abc.eks.amazonaws.com:443"] } });
    expect(unenforcedDeny(at("all"), "seatbelt")).toEqual(["abc.eks.amazonaws.com:443"]);
    expect(unenforcedDeny(at("allowlist"), "seatbelt")).toEqual([]);
    expect(unenforcedDeny(at("all"), "bwrap")).toEqual(["127.0.0.1:6443", "abc.eks.amazonaws.com:443"]);
    expect(unenforcedDeny(at("none"), "bwrap")).toEqual([]);
    const sb = createSandbox(at("all"), { platform: "linux", bwrapPath: "/usr/bin/bwrap", bwrapProbe: () => ({ ok: true }), baseEnv: {} });
    expect(sb.describe()).toContain("2 governed endpoint(s) refused (NOT enforced here: 127.0.0.1:6443, abc.eks.amazonaws.com:443)");
  });

  test("the allowlist proxy refuses a denied endpoint even when its host is allowlisted", async () => {
    const cluster = Bun.serve({ port: 0, fetch: () => new Response("cluster") });
    const other = Bun.serve({ port: 0, fetch: () => new Response("other") });
    const proxy = startAllowlistProxy(["127.0.0.1", "localhost"], { deny: [`127.0.0.1:${cluster.port}`] });
    try {
      expect((await curl("-x", proxy.url, `http://127.0.0.1:${other.port}/`)).out).toBe("other");
      const refused = await curl("-x", proxy.url, `http://127.0.0.1:${cluster.port}/`);
      expect(refused.out).toContain("is a governed cluster endpoint");
      // CONNECT to a loopback alias of the endpoint
      const tunnel = await curl("-p", "-x", proxy.url, `http://localhost:${cluster.port}/`);
      expect(tunnel.out).toContain("CONNECT tunnel failed, response 403");
      expect(proxy.denied).toEqual(["127.0.0.1", "localhost"]);
    } finally {
      proxy.close();
      cluster.stop(true);
      other.stop(true);
    }
  }, 15_000);
});

describe("bwrap argv", () => {
  test("binds writable roots that exist, shadows credential dirs and files, unshares net for none", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-"));
    mkdirSync(join(dir, "aws"));
    writeFileSync(join(dir, "netrc"), "x");
    const argv = bwrapArgv("/usr/bin/bwrap", {
      filesystem: { mode: "workspace", writable: [dir, "/nonexistent-root"], unreadable: [join(dir, "aws"), join(dir, "netrc"), "/nonexistent-cred"], protected: [], gitDirs: [] },
      network: { mode: "none", allow: [], hostPorts: [], deny: [] },
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

  test("governed kube: the real cluster endpoint on loopback is refused by the kernel (any mode); the proxy port is reachable", async () => {
    const cluster = Bun.serve({ port: 0, fetch: () => new Response("cluster") });
    const kubeProxy = Bun.serve({ port: 0, fetch: () => new Response("proxy") });
    try {
      for (const mode of ["all", "allowlist", "none"] as const) {
        const spec = resolveSandboxSpec({ network: { mode, allow: ["127.0.0.1"] } }, { roots: [work], home, hostNetwork: { hostPorts: [kubeProxy.port!], deny: [`127.0.0.1:${cluster.port}`] } });
        const sb = createSandbox(spec, { baseEnv: { PATH: process.env.PATH ?? "", HOME: home } });
        try {
          expect((await run(sb, `curl -sS -m 5 --noproxy '*' http://127.0.0.1:${kubeProxy.port}/`)).out.trim()).toBe("proxy");
          for (const host of ["127.0.0.1", "localhost"]) {
            const direct = await run(sb, `curl -sS -m 5 --noproxy '*' http://${host}:${cluster.port}/`);
            expect(direct.code).not.toBe(0);
            expect(direct.out).not.toContain("cluster");
          }
        } finally {
          sb.close();
        }
      }
    } finally {
      cluster.stop(true);
      kubeProxy.stop(true);
    }
  }, 30_000);

  test("profile text names every writable root and unreadable path", () => {
    const spec = resolveSandboxSpec(undefined, { roots: ["/work/a b"], home: "/home/u" });
    const p = seatbeltProfile(spec);
    expect(p).toContain('(allow file-write* (subpath "/work/a b"))');
    expect(p).toContain('(deny file-read* (literal "/home/u/.aws") (subpath "/home/u/.aws"))');
    expect(p.startsWith("(version 1)\n(allow default)\n")).toBe(true);
    expect(readFileSync("/usr/bin/sandbox-exec").length).toBeGreaterThan(0);
  });
});
