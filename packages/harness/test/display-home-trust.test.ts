import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HomeBlock } from "@mlpal/harness-protocol";
import { HomeResolver } from "../src/display/home";
import { createHomeScriptRunner, type HomeScriptRunner } from "../src/display/home-script";
import { homeTrust } from "../src/display/home-trust";
import type { HopUi, HopUiBlock } from "../src/profile/ui";
import type { ExecPolicy } from "../src/tools/types";

/**
 * Controller ruling 2026-11-28: home scripts run only for a trusted HOP (builtin, vendored by the image, a --hop <dir>);
 * a kill switch turns them off; a run nobody waits for is killed. The spawn path is asserted on (ExecPolicy.wrap and
 * lease are the last calls before spawn), and a marker file proves no process ran.
 */

let dir: string;
let hop: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "home-trust-"));
  hop = join(dir, "hops", "x", "1.0.0");
  mkdirSync(join(hop, "ui", "home"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const PATHONLY = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
/** An ExecPolicy that records every command about to be spawned. */
function spyExec(): ExecPolicy & { spawned: string[][] } {
  const spawned: string[][] = [];
  return { spawned, wrap: (argv) => (spawned.push(argv), argv), env: () => PATHONLY };
}
function scriptBlock(id: string, body: string): HopUiBlock {
  const scriptPath = join(hop, "ui", "home", `${id}.sh`);
  writeFileSync(scriptPath, body);
  return { id, title: id, script: `ui/home/${id}.sh`, scriptPath, refresh: "15m", refreshMs: 900_000 };
}
const KPIS = JSON.stringify({ kind: "kpis", spec: { tiles: [{ id: "n", label: "N", value: 1, format: "integer" }] }, fallback: { text: "1 thing is counted here, and the count is one." } });

describe("homeTrust: what the loader and the filesystem say, never the HOP", () => {
  const ui = (): HopUi => ({ starters: [], home: { blocks: [scriptBlock("a", "true\n")] } });
  const root = (mode = 0o755) => () => ({ uid: 0, mode });

  test("builtin and a --hop <dir> are trusted; a workspace .yodex/hops HOP is not", () => {
    expect(homeTrust({ source: "builtin", dir: null })).toEqual({ trusted: true, why: "builtin" });
    expect(homeTrust({ source: "path", dir: hop, ui: ui() }, { pathNamedByPerson: true })).toEqual({ trusted: true, why: "local_dir" });
    expect(homeTrust({ source: "project", dir: hop, ui: ui() })).toMatchObject({ trusted: false, why: expect.stringContaining("cloned repository") });
  });

  test("R1: a path HOP is trusted only when this process's own command line named it", () => {
    expect(homeTrust({ source: "path", dir: hop, ui: ui() })).toMatchObject({ trusted: false, why: expect.stringContaining("command line did not name") });
    expect(homeTrust({ source: "path", dir: hop, ui: ui() }, { pathNamedByPerson: false }).trusted).toBe(false);
  });

  test("~/.yodex/hops: files this user owns (an install from the catalog) are not trusted", () => {
    expect(homeTrust({ source: "user", dir: hop, ui: ui() })).toMatchObject({ trusted: false, why: expect.stringContaining("the catalog") });
  });

  test("~/.yodex/hops: root's and read-only (the image's vendoring) is trusted, checked path by path", () => {
    const u = ui();
    const seen: string[] = [];
    writeFileSync(join(hop, "hop.yaml"), "spec: x\n");
    mkdirSync(join(hop, "lib"));
    writeFileSync(join(hop, "lib", "helper.py"), "X = 1\n");
    expect(homeTrust({ source: "user", dir: hop, ui: u }, { uid: 1000, stat: (p) => (seen.push(p), { uid: 0, mode: 0o755 }) })).toEqual({ trusted: true, why: "vendored" });
    // O7: the whole tree, not only the scripts: the HOP dir, its parent and everything under it
    const real = realpathSync(hop);
    expect(new Set(seen)).toEqual(new Set([dirname(real), real, ...["hop.yaml", "ui", "ui/home", "ui/home/a.sh", "lib", "lib/helper.py"].map((e) => join(real, e))]));
    // one file a script may import, this user's: not vendored
    expect(homeTrust({ source: "user", dir: hop, ui: u }, { uid: 1000, stat: (p) => ({ uid: p.endsWith("helper.py") ? 1000 : 0, mode: 0o755 }) }).trusted).toBe(false);
  });

  test("one group- or other-writable path, a path this user owns, root as the engine, a stat that fails: not trusted", () => {
    const u = ui();
    const script = realpathSync(u.home!.blocks[0]!.scriptPath);
    expect(homeTrust({ source: "user", dir: hop, ui: u }, { uid: 1000, stat: (p) => ({ uid: 0, mode: p === script ? 0o775 : 0o755 }) }).trusted).toBe(false);
    expect(homeTrust({ source: "user", dir: hop, ui: u }, { uid: 1000, stat: (p) => ({ uid: p === realpathSync(join(hop, "ui")) ? 1000 : 0, mode: 0o755 }) }).trusted).toBe(false);
    expect(homeTrust({ source: "user", dir: hop, ui: u }, { uid: 0, stat: root() })).toMatchObject({ trusted: false, why: expect.stringContaining("root") });
    expect(
      homeTrust({ source: "user", dir: hop, ui: u }, {
        uid: 1000,
        stat: () => {
          throw new Error("EACCES");
        },
      }).trusted,
    ).toBe(false);
  });
});

describe("HomeResolver: scripts not run", () => {
  for (const why of ["not_trusted", "off"] as const) {
    test(`${why}: the starters, blocks [], the reason; no script reaches spawn, on get or on a second get`, async () => {
      const marker = join(dir, "ran");
      const exec = spyExec();
      const run = createHomeScriptRunner({ exec, cwd: dir });
      const ui: HopUi = { starters: ["Hi"], home: { blocks: [scriptBlock("a", `touch '${marker}'\necho '${KPIS}'\n`)] } };
      const r = new HomeResolver({ scripts: why, hop: { name: "x", version: "1.0.0", ui }, run, cacheDir: join(dir, "cache") });
      let heard = 0;
      expect(r.get(() => heard++)).toEqual({ hop: "x@1.0.0", starters: ["Hi"], blocks: [], scripts: why });
      expect(r.get(() => heard++)).toEqual({ hop: "x@1.0.0", starters: ["Hi"], blocks: [], scripts: why });
      await Bun.sleep(100);
      expect(exec.spawned).toEqual([]);
      expect(heard).toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(dir, "cache"))).toBe(false);
    });
  }
});

describe("HomeResolver: a run no one waits for is killed", () => {
  const pidAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function pidOf(file: string): Promise<number> {
    for (let i = 0; i < 200 && !existsSync(file); i++) await Bun.sleep(10);
    return Number(readFileSync(file, "utf8").trim());
  }
  function slowHome(): { ui: HopUi; pidFile: string; marker: string } {
    const pidFile = join(dir, "pid");
    const marker = join(dir, "finished");
    return { pidFile, marker, ui: { starters: [], home: { blocks: [scriptBlock("slow", `echo $$ > '${pidFile}'\nsleep 3\ntouch '${marker}'\necho '${KPIS}'\n`)] } } };
  }

  test("the only connection closes: the script's group is killed, and the next request runs it again", async () => {
    const { ui, pidFile, marker } = slowHome();
    const exec = spyExec();
    const r = new HomeResolver({ scripts: "run", hop: { name: "x", version: "1.0.0", ui }, run: createHomeScriptRunner({ exec, cwd: dir }), cacheDir: join(dir, "cache") });
    const conn = new AbortController();
    r.get(undefined, conn.signal);
    const pid = await pidOf(pidFile);
    expect(pidAlive(pid)).toBe(true);
    conn.abort();
    for (let i = 0; i < 100 && pidAlive(pid); i++) await Bun.sleep(10);
    expect(pidAlive(pid)).toBe(false);
    await Bun.sleep(50);
    expect(r.view().blocks[0]).toEqual({ id: "slow", title: "slow", as_of: null, stale: false, display: null });
    // within the 60 s window, yet run again: the cancelled run taught nothing
    r.get(undefined, new AbortController().signal);
    await Bun.sleep(100);
    expect(exec.spawned).toHaveLength(2);
    r.close();
    expect(existsSync(marker)).toBe(false);
  });

  test("one of two connections closes: the shared run goes on for the other", async () => {
    const { ui, pidFile } = slowHome();
    const r = new HomeResolver({ scripts: "run", hop: { name: "x", version: "1.0.0", ui }, run: createHomeScriptRunner({ exec: spyExec(), cwd: dir }), cacheDir: join(dir, "cache") });
    const a = new AbortController();
    const b = new AbortController();
    const heard = Promise.withResolvers<HomeBlock>();
    r.get(undefined, a.signal);
    r.get(heard.resolve, b.signal);
    const pid = await pidOf(pidFile);
    a.abort();
    await Bun.sleep(100);
    expect(pidAlive(pid)).toBe(true);
    expect((await heard.promise).display?.level).toBe("block");
  }, 15_000);

  test("close kills what runs and starts nothing more", async () => {
    const { ui, pidFile } = slowHome();
    const exec = spyExec();
    const r = new HomeResolver({ scripts: "run", hop: { name: "x", version: "1.0.0", ui }, run: createHomeScriptRunner({ exec, cwd: dir }), cacheDir: join(dir, "cache") });
    r.get();
    const pid = await pidOf(pidFile);
    r.close();
    for (let i = 0; i < 100 && pidAlive(pid); i++) await Bun.sleep(10);
    expect(pidAlive(pid)).toBe(false);
    r.get();
    await Bun.sleep(50);
    expect(exec.spawned).toHaveLength(1);
  });

  test("a queued run whose callers left never spawns", async () => {
    const started: string[] = [];
    const gate = Promise.withResolvers<void>();
    const run: HomeScriptRunner = async (s) => {
      if (s.signal?.aborted) return { ok: false, error: "cancelled", detail: "", ms: 0, stderrBytes: 0, stderrTail: "" };
      started.push(s.block);
      await gate.promise;
      return { ok: true, stdout: KPIS, ms: 1, stderrBytes: 0, stderrTail: "" };
    };
    const blocks = ["a", "b", "c"].map((id) => scriptBlock(id, "true\n"));
    const r = new HomeResolver({ scripts: "run", hop: { name: "x", version: "1.0.0", ui: { starters: [], home: { blocks } } }, run, cacheDir: join(dir, "cache") });
    const conn = new AbortController();
    r.get(undefined, conn.signal);
    await Bun.sleep(10);
    expect(started).toEqual(["a", "b"]); // two at a time; c waits
    conn.abort();
    gate.resolve();
    await Bun.sleep(20);
    expect(started).toEqual(["a", "b"]);
  });
});
