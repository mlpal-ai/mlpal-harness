import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "../src/sandbox";
import { bwrapArgv } from "../src/sandbox/bwrap";
import { seatbeltProfile } from "../src/sandbox/seatbelt";
import { PROTECTED_IN_ROOT, resolveSandboxSpec } from "../src/sandbox/spec";
import { editTool, writeTool } from "../src/tools/builtin/files";

// Ruling R22 (harness-e2e): a confined run cannot write the files the harness or git later loads or runs with
// authority (`.git/config`, `.git/hooks`, `.git/info/attributes`, `.gitattributes`, `.yodex`, `.claude`,
// `.mcp.json`), so nothing it plants is run by a later, unconfined session or by the person's own git. Ordinary git
// use keeps working. The repo lives under the home: the temp dir is writable scratch in every mode.

const DENIED = [".git/config", ".git/hooks/pre-commit", ".git/info/attributes", ".gitattributes", ".yodex/settings.json", ".yodex/workflows/x.ts", ".claude/settings.json", ".mcp.json", "bunfig.toml"];
let root: string;
const sh = (argv: string[], cwd = root) => {
  const r = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GIT_CONFIG_NOSYSTEM: "1" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

beforeAll(() => {
  root = join(homedir(), `.yodex-r22-test-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  root = realpathSync(root);
  expect(sh(["git", "init", "-q"]).code).toBe(0);
  for (const d of [".yodex/workflows", ".claude"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, ".mcp.json"), "{}\n");
  writeFileSync(join(root, ".gitattributes"), "# none\n");
  writeFileSync(join(root, ".yodex", "settings.json"), "{}\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the spec (R22)", () => {
  test("a workspace sandbox protects the harness's and git's own files under every root; a read-only one has nothing writable to protect", () => {
    const spec = resolveSandboxSpec(undefined, { roots: [root, "/srv/other"] });
    expect(spec.filesystem.protected).toEqual([...PROTECTED_IN_ROOT.map((p) => join(root, p)), ...PROTECTED_IN_ROOT.map((p) => join("/srv/other", p))]);
    expect(PROTECTED_IN_ROOT).toEqual([".git/config", ".git/hooks", ".git/info/attributes", ".gitattributes", ".yodex", ".claude", ".mcp.json", "bunfig.toml"]);
    expect(resolveSandboxSpec({ filesystem: { mode: "readOnly" } }, { roots: [root] }).filesystem.protected).toEqual([]);
  });

  test("seatbelt: each protected path is denied after every allow, and its parents inside the root cannot be moved aside", () => {
    const profile = seatbeltProfile(resolveSandboxSpec(undefined, { roots: [root] }));
    const lines = profile.trim().split("\n");
    const lastAllow = lines.findLastIndex((l) => l.startsWith("(allow file-write*"));
    for (const p of PROTECTED_IN_ROOT) {
      const at = lines.indexOf(`(deny file-write* (literal "${join(root, p)}") (subpath "${join(root, p)}"))`);
      expect([p, at > lastAllow]).toEqual([p, true]);
    }
    expect(profile).toContain(`(deny file-write* (literal "${join(root, ".git")}"))`);
    expect(profile).toContain(`(deny file-write* (literal "${join(root, ".git", "info")}"))`);
    expect(seatbeltProfile(resolveSandboxSpec({ filesystem: { mode: "readOnly" } }, { roots: [root] }))).not.toContain(".git/config");
  });

  test("bwrap: a protected path that exists is bound read-only over the writable root, its parents pinned as mounts; one that does not exist is left alone", () => {
    const spec = resolveSandboxSpec(undefined, { roots: [root] });
    const args = bwrapArgv("/usr/bin/bwrap", spec, ["true"]);
    const after = (flag: string, a: string, b: string) => args.findIndex((x, i) => x === flag && args[i + 1] === a && args[i + 2] === b);
    const rootBind = after("--bind", root, root);
    expect(rootBind).toBeGreaterThan(0);
    const git = join(root, ".git");
    expect(after("--bind", git, git)).toBeGreaterThan(rootBind);
    for (const p of [".git/config", ".git/hooks", ".gitattributes", ".yodex", ".claude", ".mcp.json"]) {
      expect([p, after("--ro-bind", join(root, p), join(root, p)) > after("--bind", git, git)]).toEqual([p, true]);
    }
    // .git/info/attributes does not exist in a fresh repo: nothing is created on the host to mount over
    expect(args).not.toContain(join(root, ".git", "info", "attributes"));
    expect(existsSync(join(root, ".git", "info", "attributes"))).toBe(false);
  });
});

describe.skipIf(process.platform !== "darwin")("under the real sandbox (seatbelt)", () => {
  const confined = (command: string) => {
    const sandbox = createSandbox(resolveSandboxSpec(undefined, { roots: [root] }));
    try {
      return sh(sandbox.wrap(["/bin/bash", "-c", command]));
    } finally {
      sandbox.close();
    }
  };

  test("a confined command cannot write any protected path, by name, through a symlink, or by moving its parent aside", () => {
    for (const p of DENIED) {
      const r = confined(`mkdir -p "$(dirname ${p})" 2>/dev/null; echo planted >> ${p}`);
      expect([p, r.code !== 0, r.out.includes("Operation not permitted")]).toEqual([p, true, true]);
      expect([p, existsSync(join(root, p)) && readFileSync(join(root, p), "utf8").includes("planted")]).toEqual([p, false]);
    }
    expect(confined("ln -s .git/config c && echo planted >> c").code).not.toBe(0);
    expect(confined("mv .git g").code).not.toBe(0);
    expect(confined("mv .yodex y").code).not.toBe(0);
    expect(confined("rm -rf .git/hooks").code).not.toBe(0);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).not.toContain("planted");
    expect(existsSync(join(root, ".git", "hooks"))).toBe(true);
  });

  test("ordinary work goes on: files, and git add, commit, branch and log", () => {
    const r = confined(
      'echo hello > a.txt && git add a.txt && git -c user.name=t -c user.email=t@example.com commit -q -m first && git branch side && git log --oneline | wc -l',
    );
    expect(r.out.trim()).toBe("1");
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "a.txt"))).toBe(true);
  });

  test("unconfined, the same writes succeed as they always did", () => {
    expect(sh(["/bin/bash", "-c", "echo '# x' >> .git/config && echo x >> .gitattributes && echo x > .yodex/workflows/x.ts"]).code).toBe(0);
  });
});

describe("the file tools (the agent's Write and Edit run in the engine, outside the OS sandbox)", () => {
  const ctxFor = (sandboxed: boolean) => {
    const sandbox = createSandbox(resolveSandboxSpec(undefined, { roots: [root] }));
    sandbox.close();
    return { cwd: root, roots: [root], ...(sandboxed ? { exec: sandbox } : {}) } as never;
  };

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")("in a confined run Write and Edit refuse each protected path, also through a symlink; other paths are written", async () => {
    const ctx = ctxFor(true);
    if (!(ctx as { exec: { available: boolean } }).exec.available) return; // no sandbox here: the run is not confined
    for (const p of DENIED) {
      const r = await writeTool.call({ path: p, content: "planted" }, ctx);
      expect([p, r.isError, String(r.content)]).toEqual([p, true, expect.stringContaining("this sandboxed session cannot write")]);
    }
    expect((await editTool.call({ path: ".mcp.json", old_string: "{}", new_string: "{\"x\":1}" }, ctx)).isError).toBe(true);
    Bun.spawnSync(["ln", "-sf", ".yodex", "alias"], { cwd: root });
    expect((await writeTool.call({ path: "alias/settings.json", content: "planted" }, ctx)).isError).toBe(true);
    expect((await writeTool.call({ path: "src/ok.txt", content: "fine" }, ctx)).isError).toBeFalsy();
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe("{}\n");
  });

  test("with no sandbox they write as before", async () => {
    expect((await writeTool.call({ path: ".yodex/notes.md", content: "mine" }, ctxFor(false))).isError).toBeFalsy();
    expect(readFileSync(join(root, ".yodex", "notes.md"), "utf8")).toBe("mine");
  });
});
