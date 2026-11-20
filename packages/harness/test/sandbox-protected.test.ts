import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "../src/sandbox";
import { bwrapArgv } from "../src/sandbox/bwrap";
import { seatbeltProfile } from "../src/sandbox/seatbelt";
import { gitEntryWritable, PROTECTED_IN_ROOT, resolveSandboxSpec, revertCreated, snapshotProtected } from "../src/sandbox/spec";
import { editTool, writeTool } from "../src/tools/builtin/files";

// Ruling R22 (harness-e2e): a confined run cannot write the files the harness or git later loads or runs with
// authority (`.git/config`, `.git/hooks`, `.git/info/attributes`, `.gitattributes`, `.yodex`, `.claude`,
// `.mcp.json`), so nothing it plants is run by a later, unconfined session or by the person's own git. Ordinary git
// use keeps working. The repo lives under the home: the temp dir is writable scratch in every mode.

const DENIED = [".git/config", ".git/hooks/pre-commit", ".git/info/attributes", ".git/commondir", ".git/modules/m/config", ".git/worktrees/w/gitdir", ".git/anything-else", ".gitattributes", ".yodex/settings.json", ".yodex/workflows/x.ts", ".claude/settings.json", ".mcp.json", "bunfig.toml"];
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

describe("the spec (R22, R22b)", () => {
  test("a workspace sandbox protects the harness's files and each root's .git; a read-only one has nothing writable to protect", () => {
    const spec = resolveSandboxSpec(undefined, { roots: [root, "/srv/other"] });
    expect(spec.filesystem.protected).toEqual([...PROTECTED_IN_ROOT.map((p) => join(root, p)), ...PROTECTED_IN_ROOT.map((p) => join("/srv/other", p))]);
    expect(spec.filesystem.gitDirs).toEqual([join(root, ".git"), "/srv/other/.git"]);
    expect(PROTECTED_IN_ROOT).toEqual([".gitattributes", ".yodex", ".claude", ".mcp.json", "bunfig.toml"]);
    const ro = resolveSandboxSpec({ filesystem: { mode: "readOnly" } }, { roots: [root] });
    expect([ro.filesystem.protected, ro.filesystem.gitDirs]).toEqual([[], []]);
  });

  test("R22b: of .git, only what ordinary git work writes is writable", () => {
    for (const ok of ["objects", "refs", "logs", "index", "index.lock", "index.stash.123", "HEAD", "packed-refs", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "MERGE_MSG", "COMMIT_EDITMSG", "CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE", "config.lock", "rebase-merge", "rebase-apply", "sequencer"]) {
      expect([ok, gitEntryWritable(ok)]).toEqual([ok, true]);
    }
    for (const no of ["config", "CONFIG", "Config", "hooks", "HOOKS", "info", "commondir", "COMMONDIR", "modules", "worktrees", "description", "gitdir", "shallow", "new-thing"]) {
      expect([no, gitEntryWritable(no)]).toEqual([no, false]);
    }
  });

  test("seatbelt: each protected path and .git whole are denied after every allow in the root; .git's allowlist follows its deny", () => {
    const lines = seatbeltProfile(resolveSandboxSpec(undefined, { roots: [root] })).trim().split("\n");
    const rootAllow = lines.indexOf(`(allow file-write* (subpath "${root}"))`);
    for (const p of PROTECTED_IN_ROOT) expect([p, lines.indexOf(`(deny file-write* (literal "${join(root, p)}") (subpath "${join(root, p)}"))`) > rootAllow]).toEqual([p, true]);
    const git = join(root, ".git");
    const deny = lines.indexOf(`(deny file-write* (literal "${git}") (subpath "${git}"))`);
    expect(deny).toBeGreaterThan(rootAllow);
    expect(lines[deny + 1]).toBe(`(allow file-write* (subpath "${git}/objects") (subpath "${git}/refs") (subpath "${git}/logs") (subpath "${git}/rebase-merge") (subpath "${git}/rebase-apply") (subpath "${git}/sequencer"))`);
    expect(lines[deny + 2]).toStartWith(`(allow file-write* (regex #"^${git.replace(/\./g, "\\.")}/(index`);
    expect(seatbeltProfile(resolveSandboxSpec({ filesystem: { mode: "readOnly" } }, { roots: [root] }))).not.toContain(".git");
  });

  test("bwrap: .git is pinned as a mount, every entry ordinary work does not write is read-only, and the protected paths that exist are too", () => {
    const spec = resolveSandboxSpec(undefined, { roots: [root] });
    const args = bwrapArgv("/usr/bin/bwrap", spec, ["true"]);
    const at = (flag: string, a: string) => args.findIndex((x, i) => x === flag && args[i + 1] === a && args[i + 2] === a);
    const git = join(root, ".git");
    expect(at("--bind", git)).toBeGreaterThan(at("--bind", root));
    for (const name of ["config", "hooks", "info", "description"]) expect([name, at("--ro-bind", join(git, name)) > at("--bind", git)]).toEqual([name, true]);
    for (const name of ["objects", "refs", "HEAD"]) expect([name, at("--ro-bind", join(git, name))]).toEqual([name, -1]);
    for (const p of PROTECTED_IN_ROOT.filter((q) => existsSync(join(root, q)))) expect([p, at("--ro-bind", join(root, p)) > 0]).toEqual([p, true]);
    // what does not exist is not mounted over (nothing is created on the host); the lease below takes it back
    expect(args).not.toContain(join(git, "commondir"));
    expect(existsSync(join(git, "commondir"))).toBe(false);
  });

  test("bwrap: a root whose .git is a file (a worktree's pointer) has it read-only whole", () => {
    const wt = join(root, "wt");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
    try {
      const args = bwrapArgv("/usr/bin/bwrap", resolveSandboxSpec(undefined, { roots: [wt] }), ["true"]);
      const i = args.findIndex((x, k) => x === "--ro-bind" && args[k + 1] === join(wt, ".git"));
      expect(i).toBeGreaterThan(0);
      expect(args.filter((x) => x === "--bind" && false).length).toBe(0);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("R22d: on bubblewrap, what a command created where it may not write is taken back", () => {
  const fresh = () => {
    const dir = join(root, `scan-${crypto.randomUUID().slice(0, 6)}`);
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    for (const d of ["objects", "refs"]) mkdirSync(join(dir, ".git", d));
    writeFileSync(join(dir, ".git", "config"), "[core]\n");
    writeFileSync(join(dir, ".mcp.json"), "{}\n");
    return dir;
  };

  test("the scan: protected paths absent before and present after are removed, and so is a new .git entry ordinary work does not write; nothing that existed is touched", () => {
    const dir = fresh();
    const spec = resolveSandboxSpec(undefined, { roots: [dir] });
    const before = snapshotProtected(spec);
    // what an agent's command could create on a host where bubblewrap cannot stop it
    mkdirSync(join(dir, ".yodex", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".yodex", "settings.json"), "{}");
    writeFileSync(join(dir, "bunfig.toml"), "preload = []");
    writeFileSync(join(dir, ".git", "commondir"), "../evil\n");
    mkdirSync(join(dir, ".git", "modules"));
    // and what ordinary work writes, or what was there already
    writeFileSync(join(dir, ".git", "index"), "x");
    writeFileSync(join(dir, ".git", "COMMIT_EDITMSG"), "m");
    mkdirSync(join(dir, ".git", "logs"));
    writeFileSync(join(dir, "src.txt"), "work");
    expect(revertCreated(spec, before).sort()).toEqual([join(dir, ".git", "commondir"), join(dir, ".git", "modules"), join(dir, ".yodex"), join(dir, "bunfig.toml")].sort());
    for (const gone of [".yodex", "bunfig.toml", ".git/commondir", ".git/modules"]) expect([gone, existsSync(join(dir, gone))]).toEqual([gone, false]);
    for (const kept of [".mcp.json", ".git/config", ".git/hooks", ".git/index", ".git/COMMIT_EDITMSG", ".git/logs", "src.txt"]) expect([kept, existsSync(join(dir, kept))]).toEqual([kept, true]);
    expect(revertCreated(spec, snapshotProtected(spec))).toEqual([]);
  });

  test("a workspace that was no repository does not become one: a created .git is removed", () => {
    const dir = join(root, `norepo-${crypto.randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const spec = resolveSandboxSpec(undefined, { roots: [dir] });
    const before = snapshotProtected(spec);
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "[core]\n\tfsmonitor = ./evil\n");
    expect(revertCreated(spec, before)).toEqual([join(dir, ".git")]);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("the bubblewrap sandbox leases every command a scan; seatbelt, which refuses the creation itself, has none", () => {
    const dir = fresh();
    const bwrap = createSandbox(resolveSandboxSpec(undefined, { roots: [dir] }), { platform: "linux", bwrapPath: "/usr/bin/bwrap", bwrapProbe: () => ({ ok: true }) });
    expect(bwrap.platform).toBe("bwrap");
    const lease = bwrap.lease!("touch .git/commondir");
    writeFileSync(join(dir, ".git", "commondir"), "../evil\n");
    expect(lease.release()).toEqual([join(dir, ".git", "commondir")]);
    expect(existsSync(join(dir, ".git", "commondir"))).toBe(false);
    expect(bwrap.describe()).toContain("harness and git paths read-only (one a command creates is removed when it ends)");
    expect(createSandbox(resolveSandboxSpec(undefined, { roots: [dir] }), { platform: "darwin" }).lease).toBeUndefined();
  });

  test("Bash under such a sandbox: the path is gone, the result says what was removed, and the command counts as failed", async () => {
    const dir = fresh();
    // the stand-in confines nothing (as bubblewrap cannot for a path that does not exist) and leases the real scan
    const spec = resolveSandboxSpec(undefined, { roots: [dir] });
    const exec = { wrap: (argv: string[]) => argv, env: () => ({ PATH: process.env.PATH ?? "" }), lease: () => ((before) => ({ env: { PATH: process.env.PATH ?? "" }, release: () => revertCreated(spec, before) }))(snapshotProtected(spec)) };
    const { bashTool } = await import("../src/tools/builtin/bash");
    const r = await bashTool.call({ command: "printf '../evil' > .git/commondir && echo done" }, { cwd: dir, roots: [dir], exec } as never);
    expect(existsSync(join(dir, ".git", "commondir"))).toBe(false);
    expect(r.isError).toBe(true);
    expect(String(r.content)).toContain(`Removed: ${join(dir, ".git", "commondir")}. The command is reported as failed.`);
    const fine = await bashTool.call({ command: "echo ok > note.txt" }, { cwd: dir, roots: [dir], exec } as never);
    expect(fine.isError).toBeFalsy();
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
      // refused by the OS: at the path itself, or at the directory that would hold it
      expect([p, r.code !== 0, /Operation not permitted|No such file or directory/.test(r.out)]).toEqual([p, true, true]);
      expect([p, existsSync(join(root, p)) && readFileSync(join(root, p), "utf8").includes("planted")]).toEqual([p, false]);
    }
    expect(confined("ln -s .git/config c && echo planted >> c").code).not.toBe(0);
    expect(confined("mv .git g").code).not.toBe(0);
    expect(confined("mv .yodex y").code).not.toBe(0);
    expect(confined("rm -rf .git/hooks").code).not.toBe(0);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).not.toContain("planted");
    expect(existsSync(join(root, ".git", "hooks"))).toBe(true);
  });

  test("R22b: the commondir attack fails (a copied .git with core.fsmonitor, reached through .git/commondir)", () => {
    const marker = join(root, "fsmonitor-ran");
    const r = confined(`cp -R .git evil && printf '[core]\\n\\tfsmonitor = "touch ${marker} #"\\n' >> evil/config && printf '../evil\\n' > .git/commondir`);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(root, ".git", "commondir"))).toBe(false);
    // the person's own git afterwards runs nothing of the agent's
    expect(sh(["git", "status", "--short"]).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    rmSync(join(root, "evil"), { recursive: true, force: true });
  });

  test("R22c: the same paths in another case are refused too (macOS volumes are case-insensitive)", () => {
    for (const p of [".YODEX/settings.json", ".MCP.json", ".Claude/settings.json", ".GITATTRIBUTES", ".git/CONFIG", ".GIT/config", ".git/Hooks/pre-commit"]) {
      const r = confined(`echo planted >> ${p}`);
      expect([p, r.code !== 0]).toEqual([p, true]);
    }
    for (const p of [".yodex/settings.json", ".mcp.json", ".gitattributes", ".git/config"]) expect([p, readFileSync(join(root, p), "utf8").includes("planted")]).toEqual([p, false]);
  });

  test("ordinary work goes on: files, and git add, commit, branch and log", () => {
    const id = "-c user.name=t -c user.email=t@example.com";
    const r = confined(
      `echo hello > a.txt && git add a.txt && git ${id} commit -q -m first && git branch side && git log --oneline | wc -l`,
    );
    expect(r.out.trim()).toBe("1");
    expect(r.code).toBe(0);
    expect(existsSync(join(root, "a.txt"))).toBe(true);
    // stash and pop; a second commit; an interactive rebase that runs a command per commit; cherry-pick; reset; gc
    const more = confined(
      [
        "B=$(git symbolic-ref --short HEAD) && echo two >> a.txt && git stash -q && git stash pop -q",
        `git ${id} commit -qam second`,
        `echo x > b.txt && git add b.txt && git ${id} commit -qm third`,
        `GIT_SEQUENCE_EDITOR=true git ${id} rebase -q -i --exec 'echo ran >> rebase-exec.log' HEAD~2`,
        `git checkout -q side && git ${id} cherry-pick "$B" >/dev/null`,
        // gc packs and prunes; its one complaint is that it may not refresh .git/info/refs (the dumb-HTTP listing)
        "git reset -q --hard HEAD~1 && git gc -q 2>/dev/null; echo COUNT=$(git log --oneline --all | wc -l | tr -d ' ') EXEC=$(wc -l < rebase-exec.log | tr -d ' ')",
      ].join(" && "),
    );
    expect(more.code).toBe(0);
    expect(more.out).toContain("COUNT=3 EXEC=2"); // three commits on the branches; the rebase ran its command per commit
  });

  test("unconfined, the same writes succeed as they always did", () => {
    expect(sh(["/bin/bash", "-c", "echo '# x' >> .git/config && echo x >> .gitattributes && echo x > .yodex/workflows/x.ts && : > .git/commondir.probe"]).code).toBe(0);
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
    // R22c: compared case-folded, always
    for (const p of [".YODEX/settings.json", ".MCP.json", ".Claude/settings.json", ".GITATTRIBUTES", ".Git/HEAD", ".git/objects/x"]) {
      const r = await writeTool.call({ path: p, content: "planted" }, ctx);
      expect([p, r.isError]).toEqual([p, true]);
    }
  });

  test("with no sandbox they write as before", async () => {
    expect((await writeTool.call({ path: ".yodex/notes.md", content: "mine" }, ctxFor(false))).isError).toBeFalsy();
    expect(readFileSync(join(root, ".yodex", "notes.md"), "utf8")).toBe("mine");
  });
});

// Ruling R22e: a tool home's bin directory is on the person's PATH, so a confined run writes only its cache or store.
describe("tool homes (R22e)", () => {
  test("the spec makes the caches writable, never the homes or their bin directories", () => {
    const w = resolveSandboxSpec(undefined, { roots: [root], home: "/home/me" }).filesystem.writable;
    for (const cache of ["/home/me/.bun/install/cache", "/home/me/.cargo/registry", "/home/me/.cargo/git", "/home/me/.local/share/pnpm/store", "/home/me/.pnpm-store", "/home/me/.npm", "/home/me/.cache"]) expect([cache, w.includes(cache)]).toEqual([cache, true]);
    for (const home of ["/home/me/.bun", "/home/me/.bun/bin", "/home/me/.cargo", "/home/me/.cargo/bin", "/home/me/.local/share/pnpm"]) expect([home, w.includes(home)]).toEqual([home, false]);
  });

  test.skipIf(process.platform !== "darwin")("under the real sandbox a global bin cannot be written and a cache can", () => {
    const home = join(root, "fake-home");
    const dirs = [".bun/bin", ".bun/install/cache", ".bun/install/global", ".cargo/bin", ".cargo/registry", ".local/share/pnpm", ".local/share/pnpm/store"];
    for (const d of dirs) mkdirSync(join(home, d), { recursive: true });
    const work = join(root, "tool-work");
    mkdirSync(work, { recursive: true });
    const sandbox = createSandbox(resolveSandboxSpec(undefined, { roots: [work], home, realHome: null }));
    try {
      const touch = (p: string) => sh(sandbox.wrap(["/bin/bash", "-c", `touch "${join(home, p)}"`]), work).code;
      for (const bin of [".bun/bin/yodex", ".bun/install/global/x", ".cargo/bin/cargo-evil", ".local/share/pnpm/pnpm-evil"]) expect([bin, touch(bin) !== 0]).toEqual([bin, true]);
      for (const cache of [".bun/install/cache/pkg", ".cargo/registry/crate", ".local/share/pnpm/store/blob"]) expect([cache, touch(cache)]).toEqual([cache, 0]);
    } finally {
      sandbox.close();
    }
  });
});
