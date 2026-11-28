import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { displayEnvelopeSchema, type HomeBlock } from "@mlpal/harness-protocol";
import { checkHomeOutput, HomeResolver } from "../src/display/home";
import { createHomeScriptRunner, type HomeScriptRunner, type ScriptOutcome } from "../src/display/home-script";
import type { Logger, LogFields } from "../src/obs/logger";
import { MemoryMetrics } from "../src/obs/metrics";
import type { HopUi, HopUiBlock } from "../src/profile/ui";
import type { ExecPolicy } from "../src/tools/types";

/**
 * W3-1: the home resolver (WAVE-3-HOP-SHAPED-HOME §3, §6 W3-1's tests): a script that times out, prints junk, prints
 * too much or prints a block the Show checks refuse keeps the last good block, stale; two concurrent requests share one
 * run; the disk cache survives a restart; nothing calls a model.
 */

const OUTPUTS = join(import.meta.dir, "fixtures", "home", "outputs");
const output = (name: string): string => readFileSync(join(OUTPUTS, `${name}.json`), "utf8");
const T0 = Date.parse("2026-11-28T09:00:30Z");

let dir: string;
let cache: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "home-"));
  cache = join(dir, "cache");
  clock = T0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function block(id: string, refresh = 15): HopUiBlock {
  return { id, title: `Title of ${id}`, script: `ui/home/${id}.py`, scriptPath: `/hop/ui/home/${id}.py`, refresh: `${refresh}m`, refreshMs: refresh * 60_000 };
}
const UI: HopUi = { starters: ["Publish my HOP", "What did my agents do today?"], home: { blocks: ["spend", "agents", "sites", "hops"].map((id) => block(id)) } };
const HOP = { name: "mlpal", version: "0.3.0", ui: UI };

const ok = (stdout: string): ScriptOutcome => ({ ok: true, stdout, ms: 5, stderrBytes: 0, stderrTail: "" });
const failed = (error: Extract<ScriptOutcome, { ok: false }>["error"]): ScriptOutcome => ({ ok: false, error, detail: error, ms: 5, stderrBytes: 0, stderrTail: "" });

/** A runner answering from a table by block id; `calls` counts runs per block. */
function tableRunner(table: Record<string, () => ScriptOutcome | Promise<ScriptOutcome>>): HomeScriptRunner & { calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const run = (async (s) => {
    calls.set(s.block, (calls.get(s.block) ?? 0) + 1);
    return table[s.block]!();
  }) as HomeScriptRunner & { calls: Map<string, number> };
  run.calls = calls;
  return run;
}
const goodRunner = () => tableRunner(Object.fromEntries(["spend", "agents", "sites", "hops"].map((id) => [id, () => ok(output(id))])));

/** Collect `n` updates. */
function updates(n: number): { list: HomeBlock[]; done: Promise<HomeBlock[]>; push: (b: HomeBlock) => void } {
  const list: HomeBlock[] = [];
  const d = Promise.withResolvers<HomeBlock[]>();
  return {
    list,
    done: d.promise,
    push: (b) => {
      list.push(b);
      if (list.length === n) d.resolve(list);
    },
  };
}

class CapturingLogger implements Logger {
  readonly lines: Array<{ level: string; msg: string; fields?: LogFields }> = [];
  child(): Logger {
    return this;
  }
  log(level: string, msg: string, fields?: LogFields): void {
    this.lines.push({ level, msg, ...(fields ? { fields } : {}) });
  }
  debug(m: string, f?: LogFields) {
    this.log("debug", m, f);
  }
  info(m: string, f?: LogFields) {
    this.log("info", m, f);
  }
  warn(m: string, f?: LogFields) {
    this.log("warn", m, f);
  }
  error(m: string, f?: LogFields) {
    this.log("error", m, f);
  }
}

describe("checkHomeOutput: a script's output is checked as a Show", () => {
  test("the four MLPal-shaped outputs are valid blocks; the chart's fallback gets its table, neutralised", () => {
    for (const id of ["spend", "agents", "sites", "hops"]) expect(checkHomeOutput(block(id), output(id)).ok).toBe(true);
    const r = checkHomeOutput(block("spend"), output("spend"));
    expect(r.ok && r.fallback).toContain("| 2026-11-26 | 90.5 |");
  });

  test("junk, a JSON non-object, unknown fields, a missing fallback, a chart over the cost budget, an expression", () => {
    expect(checkHomeOutput(block("a"), "hello")).toMatchObject({ ok: false, error: "not_json" });
    expect(checkHomeOutput(block("a"), "[1,2]")).toMatchObject({ ok: false, error: "not_json" });
    expect(checkHomeOutput(block("a"), '{"a":1}\n{"b":2}')).toMatchObject({ ok: false, error: "not_json" });
    expect(checkHomeOutput(block("a"), JSON.stringify({ ...JSON.parse(output("hops")), block_id: "x", caption: "c" }))).toMatchObject({ ok: false, error: "invalid_block", detail: expect.stringContaining('"block_id", "caption"') });
    expect(checkHomeOutput(block("a"), JSON.stringify({ kind: "kpis", spec: JSON.parse(output("hops")).spec }))).toMatchObject({ ok: false, error: "invalid_block", detail: expect.stringContaining("FALLBACK_MISSING") });
    const costly = { kind: "chart", spec: { vl: { data: { values: Array.from({ length: 5000 }, (_, i) => ({ i, v: (i * 7919) % 1000 })) }, mark: "bar", encoding: { x: { field: "i", type: "ordinal" }, y: { field: "v", type: "quantitative" } } } }, fallback: { text: "5,000 bars, one per row, which no one can read at once." } };
    const r = checkHomeOutput(block("a"), JSON.stringify(costly));
    expect(r).toMatchObject({ ok: false, error: "invalid_block", detail: expect.stringContaining("TOO_COSTLY at spec.vl") });
    // the fallback passed on its own, so a block that never resolved can show it
    expect(!r.ok && r.fallback).toContain("5,000 bars");
    const expr = { kind: "chart", spec: { vl: { data: { values: [{ a: 1 }] }, transform: [{ calculate: "datum.a * 2", as: "b" }], mark: "bar", encoding: { x: { field: "a", type: "ordinal" }, y: { field: "b", type: "quantitative" } } } }, fallback: { text: "One bar of value 2, computed from a in the chart itself." } };
    expect(checkHomeOutput(block("a"), JSON.stringify(expr))).toMatchObject({ ok: false, error: "invalid_block", detail: expect.stringContaining("EXPRESSION_NOT_ALLOWED") });
  });

  test("the block's id and its declared title are the HOP's, never the script's", () => {
    const r = checkHomeOutput(block("hops"), JSON.stringify({ ...JSON.parse(output("hops")), title: "Hijacked" }));
    expect(r).toMatchObject({ ok: false, error: "invalid_block" });
  });
});

describe("HomeResolver", () => {
  test("first get: the view at once (nothing known yet), then one update per block, each a host-drawn block envelope", async () => {
    const run = goodRunner();
    const r = new HomeResolver({ hop: HOP, run, cacheDir: cache, now });
    const u = updates(4);
    const view = r.get(u.push);
    expect(view).toEqual({
      hop: "mlpal@0.3.0",
      starters: ["Publish my HOP", "What did my agents do today?"],
      blocks: ["spend", "agents", "sites", "hops"].map((id) => ({ id, title: `Title of ${id}`, as_of: null, stale: false, display: null })),
    });
    const got = await u.done;
    expect(got.map((b) => b.id).sort()).toEqual(["agents", "hops", "sites", "spend"]);
    for (const b of got) {
      expect(b).toMatchObject({ stale: false, as_of: "2026-11-28T09:00:00Z" });
      expect(b.error).toBeUndefined();
      expect(displayEnvelopeSchema.safeParse(b.display).success).toBe(true);
      expect(b.display).toMatchObject({ level: "block", block_id: b.id, title: `Title of ${b.id}`, revision: 1, source: { by: "host", origin: "home" }, status: "ok" });
    }
    expect(r.view().blocks.every((b) => b.display?.level === "block")).toBe(true);
  });

  test("a script's own as_of is kept; without one, as_of is when it ran", async () => {
    const { as_of: _drop, ...rest } = JSON.parse(output("hops"));
    const run = tableRunner({ hops: () => ok(JSON.stringify(rest)) });
    const r = new HomeResolver({ hop: { ...HOP, ui: { starters: [], home: { blocks: [block("hops")] } } }, run, cacheDir: cache, now });
    const u = updates(1);
    r.get(u.push);
    expect((await u.done)[0]!.as_of).toBe(new Date(T0).toISOString());
  });

  for (const [why, outcome, error] of [
    ["times out", () => failed("timeout"), "timeout"],
    ["exits non-zero", () => failed("exit_nonzero"), "exit_nonzero"],
    ["prints over 256 KiB", () => failed("output_too_large"), "output_too_large"],
    ["prints junk", () => ok("Traceback (most recent call last): ..."), "not_json"],
    ["prints a block that fails validation", () => ok(JSON.stringify({ kind: "grid", spec: { columns: [{ key: "a", label: "A", type: "num" }], rows: [{ a: "not a number" }], row_key: "a" }, fallback: { text: "One row whose a is 1, shown as a grid." } })), "invalid_block"],
    ["is refused by the HOP's rules", () => failed("denied"), "denied"],
  ] as const) {
    test(`a block whose script ${why} keeps its last good block and time, marked stale with the reason`, async () => {
      let next: () => ScriptOutcome = () => ok(output("agents"));
      const run = tableRunner({ agents: () => next() });
      const r = new HomeResolver({ hop: { ...HOP, ui: { starters: [], home: { blocks: [block("agents")] } } }, run, cacheDir: cache, now });
      const first = updates(1);
      r.get(first.push);
      const good = (await first.done)[0]!;
      next = outcome;
      clock += 61_000;
      const second = updates(1);
      r.get(second.push);
      const after = (await second.done)[0]!;
      expect(after).toEqual({ ...good, stale: true, error });
      expect(r.view().blocks[0]).toEqual(after);
    });
  }

  test("a block that never resolved and whose block fails, but whose fallback passes, shows the fallback alone", async () => {
    const bad = { kind: "chart", spec: { vl: { data: { url: "https://example.com/data.json" }, mark: "bar" } }, fallback: { text: "Spend was 365 compute units over the last 7 days." } };
    const run = tableRunner({ spend: () => ok(JSON.stringify(bad)) });
    const r = new HomeResolver({ hop: { ...HOP, ui: { starters: [], home: { blocks: [block("spend")] } } }, run, cacheDir: cache, now });
    const u = updates(1);
    r.get(u.push);
    const b = (await u.done)[0]!;
    expect(b).toMatchObject({ stale: false, error: "invalid_block", display: { level: "text", status: "fallback_only", source: { by: "host", origin: "home" }, fallback: { text: "Spend was 365 compute units over the last 7 days." } } });
    expect(displayEnvelopeSchema.safeParse(b.display).success).toBe(true);
    // nothing to show at all: display null, with the reason
    const r2 = new HomeResolver({ hop: { ...HOP, ui: { starters: [], home: { blocks: [block("spend")] } } }, run: tableRunner({ spend: () => failed("timeout") }), cacheDir: join(dir, "c2"), now });
    const u2 = updates(1);
    r2.get(u2.push);
    expect((await u2.done)[0]).toEqual({ id: "spend", title: "Title of spend", as_of: null, stale: false, display: null, error: "timeout" });
  });

  test("a runner that throws is a failure of that block alone, never of get", async () => {
    const run = tableRunner({ spend: () => Promise.reject(new Error("boom")), agents: () => ok(output("agents")) });
    const log = new CapturingLogger();
    const r = new HomeResolver({ hop: { ...HOP, ui: { starters: [], home: { blocks: [block("spend"), block("agents")] } } }, run, cacheDir: cache, now, logger: log });
    const u = updates(2);
    expect(() => r.get(u.push)).not.toThrow();
    const got = await u.done;
    expect(got.find((b) => b.id === "spend")).toMatchObject({ display: null, error: "not_started" });
    expect(got.find((b) => b.id === "agents")?.display?.level).toBe("block");
    expect(log.lines.some((l) => l.msg === "home.block.internal" && l.fields?.error === "Error")).toBe(true);
  });

  test("two concurrent get_home share one run per block, and both hear every block", async () => {
    const gate = Promise.withResolvers<void>();
    const run = tableRunner(Object.fromEntries(["spend", "agents", "sites", "hops"].map((id) => [id, async () => (await gate.promise, ok(output(id)))])));
    const r = new HomeResolver({ hop: HOP, run, cacheDir: cache, now });
    const a = updates(4);
    const b = updates(4);
    r.get(a.push);
    clock += 61_000; // even past the rerun window, a block already running is joined, not run again
    r.get(b.push);
    gate.resolve();
    const [ga, gb] = await Promise.all([a.done, b.done]);
    expect([...run.calls.values()]).toEqual([1, 1, 1, 1]);
    expect(ga.map((x) => x.id).sort()).toEqual(gb.map((x) => x.id).sort());
  });

  test("at most two scripts run at once", async () => {
    let live = 0;
    let peak = 0;
    const slow = (id: string) => async () => {
      live++;
      peak = Math.max(peak, live);
      await Bun.sleep(20);
      live--;
      return ok(output(id));
    };
    const r = new HomeResolver({ hop: HOP, run: tableRunner(Object.fromEntries(["spend", "agents", "sites", "hops"].map((id) => [id, slow(id)]))), cacheDir: cache, now });
    const u = updates(4);
    r.get(u.push);
    await u.done;
    expect(peak).toBe(2);
  });

  test("a block attempted under 60 s ago is not run again; after 60 s it is", async () => {
    const run = goodRunner();
    const r = new HomeResolver({ hop: HOP, run, cacheDir: cache, now });
    const u = updates(4);
    r.get(u.push);
    await u.done;
    clock += 59_000;
    let heard = 0;
    r.get(() => heard++);
    await Bun.sleep(10);
    expect(heard).toBe(0);
    expect([...run.calls.values()]).toEqual([1, 1, 1, 1]);
    clock += 1_000;
    const again = updates(4);
    r.get(again.push);
    await again.done;
    expect([...run.calls.values()]).toEqual([2, 2, 2, 2]);
    expect(again.list.every((b) => b.display?.revision === 2)).toBe(true);
  });

  test("a block older than its refresh is stale until a refresh lands", async () => {
    let fail = false;
    const r = new HomeResolver({ hop: { ...HOP, ui: { starters: [], home: { blocks: [block("hops", 5)] } } }, run: tableRunner({ hops: () => (fail ? new Promise<ScriptOutcome>(() => {}) : ok(output("hops"))) }), cacheDir: cache, now });
    const u = updates(1);
    r.get(u.push);
    await u.done;
    clock += 5 * 60_000 + 1;
    fail = true; // the next refresh hangs: the view is served stale meanwhile
    expect(r.get().blocks[0]).toMatchObject({ stale: true, display: { level: "block" } });
    expect(r.view().blocks[0]!.error).toBeUndefined();
  });

  test("the disk cache survives a restart: a new resolver shows the last good block at once, fresh within its refresh", async () => {
    const first = new HomeResolver({ hop: HOP, run: goodRunner(), cacheDir: cache, now });
    const u = updates(4);
    first.get(u.push);
    const good = await u.done;
    expect(existsSync(join(cache, "mlpal@0.3.0", "spend.json"))).toBe(true);
    clock += 60_000;
    // the restarted engine's scripts all fail: the cached blocks are served, and stay, now stale with the reason
    const run = tableRunner(Object.fromEntries(["spend", "agents", "sites", "hops"].map((id) => [id, () => failed("timeout")])));
    const second = new HomeResolver({ hop: HOP, run, cacheDir: cache, now });
    const view = second.view();
    expect(view.blocks.map((b) => [b.id, b.stale, b.display?.revision])).toEqual([
      ["spend", false, 1],
      ["agents", false, 1],
      ["sites", false, 1],
      ["hops", false, 1],
    ]);
    for (const b of view.blocks) expect(b).toEqual(good.find((g) => g.id === b.id)!);
    const after = updates(4);
    second.get(after.push);
    for (const b of await after.done) expect(b).toMatchObject({ stale: true, error: "timeout", display: { level: "block", revision: 1 } });
  });

  test("a cache file that is corrupt, of another block, or not host-drawn is skipped; another version starts empty", async () => {
    const first = new HomeResolver({ hop: HOP, run: goodRunner(), cacheDir: cache, now });
    const u = updates(4);
    first.get(u.push);
    await u.done;
    const at = (id: string) => join(cache, "mlpal@0.3.0", `${id}.json`);
    writeFileSync(at("spend"), "{not json");
    writeFileSync(at("agents"), readFileSync(at("sites"), "utf8"));
    const hops = JSON.parse(readFileSync(at("hops"), "utf8"));
    hops.display.source = { by: "model" };
    writeFileSync(at("hops"), JSON.stringify(hops));
    const log = new CapturingLogger();
    const view = new HomeResolver({ hop: HOP, run: goodRunner(), cacheDir: cache, now, logger: log }).view();
    expect(view.blocks.map((b) => b.display === null)).toEqual([true, true, false, true]);
    expect(log.lines.filter((l) => l.msg === "home.cache.unreadable").map((l) => l.fields?.block)).toEqual(["spend", "agents", "hops"]);
    expect(new HomeResolver({ hop: { ...HOP, version: "0.4.0" }, run: goodRunner(), cacheDir: cache, now }).view().blocks.every((b) => b.display === null)).toBe(true);
  });

  test("an unwritable cache is logged and the home still resolves", async () => {
    writeFileSync(join(dir, "file"), "x");
    const log = new CapturingLogger();
    const r = new HomeResolver({ hop: HOP, run: goodRunner(), cacheDir: join(dir, "file", "cache"), now, logger: log });
    const u = updates(4);
    r.get(u.push);
    expect((await u.done).every((b) => b.display?.level === "block")).toBe(true);
    expect(log.lines.filter((l) => l.msg === "home.cache.write_failed")).toHaveLength(4);
  });

  test("a HOP without ui answers empty starters and blocks, running nothing", () => {
    const run = goodRunner();
    expect(new HomeResolver({ hop: { name: "coding", version: "1.1.0" }, run, cacheDir: cache, now }).get()).toEqual({ hop: "coding@1.1.0", starters: [], blocks: [] });
    expect(new HomeResolver({ hop: { name: "x", version: "1.0.0", ui: { starters: ["Hi"] } }, run, cacheDir: cache, now }).get()).toEqual({ hop: "x@1.0.0", starters: ["Hi"], blocks: [] });
    expect(run.calls.size).toBe(0);
  });

  test("counters by outcome; logs carry ids, codes and sizes, never what a script printed", async () => {
    const SECRET = "sk-live-do-not-log-4242";
    const run = tableRunner({ spend: () => ok(`junk ${SECRET}`), agents: () => ({ ...failed("exit_nonzero"), stderrTail: SECRET, stderrBytes: SECRET.length, exitCode: 3 }), sites: () => ok(output("sites")), hops: () => ok(JSON.stringify({ kind: "kpis", spec: { tiles: [] }, fallback: { text: `${SECRET} is in the fallback, with 1 number.` } })) });
    const log = new CapturingLogger();
    const metrics = new MemoryMetrics();
    const r = new HomeResolver({ hop: HOP, run, cacheDir: cache, now, logger: log, metrics });
    const u = updates(4);
    r.get(u.push);
    await u.done;
    expect(JSON.stringify(log.lines)).not.toContain(SECRET);
    expect(log.lines.find((l) => l.fields?.block === "agents")?.fields).toMatchObject({ error: "exit_nonzero", exit_code: 3, stderr_bytes: SECRET.length });
    expect(metrics.counters.get("home.refresh{outcome=ok}")).toBe(1);
    expect(metrics.counters.get("home.refresh{outcome=not_json}")).toBe(1);
    expect(metrics.counters.get("home.refresh{outcome=exit_nonzero}")).toBe(1);
    expect(metrics.counters.get("home.refresh{outcome=invalid_block}")).toBe(1);
  });
});

describe("createHomeScriptRunner: real scripts, through the ExecPolicy", () => {
  let hop: string;
  /** An ExecPolicy as a session's: nothing confines, and the environment is exactly what env() gives. */
  const exec = (env: Record<string, string>, seen: string[][] = []): ExecPolicy => ({
    wrap: (argv) => (seen.push(argv), argv),
    env: () => env,
  });
  const PATHONLY = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  const script = (name: string, body: string, exe = false): string => {
    const p = join(hop, name);
    writeFileSync(p, body);
    if (exe) chmodSync(p, 0o755);
    return p;
  };
  beforeEach(() => {
    hop = join(dir, "hop");
    mkdirSync(hop, { recursive: true });
  });

  test("a script that runs past the timeout is killed, with its children", async () => {
    const marker = join(dir, "survived");
    const p = script("slow.sh", `(sleep 1; touch '${marker}') &\nsleep 30\n`);
    const run = createHomeScriptRunner({ exec: { ...exec(PATHONLY), ownGroup: true }, cwd: dir, timeoutMs: 300 });
    const started = Date.now();
    expect(await run({ block: "slow", scriptPath: p })).toMatchObject({ ok: false, error: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    await Bun.sleep(1_300);
    expect(existsSync(marker)).toBe(false);
  });

  test("a script that prints over 256 KiB is stopped", async () => {
    const p = script("big.py", "import sys\nsys.stdout.write('x' * (300 * 1024))\n");
    expect(await createHomeScriptRunner({ exec: exec(PATHONLY), cwd: dir })({ block: "big", scriptPath: p })).toMatchObject({ ok: false, error: "output_too_large" });
    const fits = script("fits.py", "import sys\nsys.stdout.write('x' * (256 * 1024))\n");
    const r = await createHomeScriptRunner({ exec: exec(PATHONLY), cwd: dir })({ block: "fits", scriptPath: fits });
    expect(r.ok && r.stdout.length).toBe(256 * 1024);
  });

  test("exit codes, stderr kept apart (its tail for lint, its size for the log), and a file that cannot start", async () => {
    const p = script("fail.sh", "echo partial\necho 'why it broke' >&2\nexit 3\n");
    expect(await createHomeScriptRunner({ exec: exec(PATHONLY), cwd: dir })({ block: "f", scriptPath: p })).toMatchObject({ ok: false, error: "exit_nonzero", exitCode: 3, stderrTail: "why it broke\n", stderrBytes: 13 });
    const gone = await createHomeScriptRunner({ exec: exec(PATHONLY), cwd: dir })({ block: "g", scriptPath: join(hop, "gone.sh") });
    expect(gone).toMatchObject({ ok: false, error: "exit_nonzero", exitCode: 127 });
  });

  test("the command goes through exec.wrap as /bin/bash -c, and sees only exec's environment", async () => {
    process.env.HOME_TEST_LEAK_TOKEN = "leaked";
    try {
      const p = script("env.py", 'import json, os\nprint(json.dumps(sorted(k for k in os.environ if k in ("HOME_TEST_LEAK_TOKEN", "KEPT"))))\n');
      const seen: string[][] = [];
      const r = await createHomeScriptRunner({ exec: exec({ ...PATHONLY, KEPT: "1" }, seen), cwd: dir })({ block: "e", scriptPath: p });
      expect(r.ok && JSON.parse(r.stdout)).toEqual(["KEPT"]);
      expect(seen).toEqual([["/bin/bash", "-c", `python3 '${p}'`]]);
    } finally {
      delete process.env.HOME_TEST_LEAK_TOKEN;
    }
  });

  test("the HOP's deny rules and the hard denials judge the command before anything runs", async () => {
    const marker = join(dir, "ran");
    const p = script("home.py", `open('${marker}', 'w').write('x')\nprint('{}')\n`);
    const denied = await createHomeScriptRunner({ exec: exec(PATHONLY), cwd: dir, deny: ["Bash(python3 *)"] })({ block: "h", scriptPath: p });
    expect(denied).toMatchObject({ ok: false, error: "denied", detail: expect.stringContaining('denied by rule "Bash(python3 *)"') });
    expect(existsSync(marker)).toBe(false);
    const allowed = await createHomeScriptRunner({ exec: exec(PATHONLY), cwd: dir, deny: ["Bash(rm *)"] })({ block: "h", scriptPath: p });
    expect(allowed.ok).toBe(true);
  });

  test("a lease's release that removed something fails the script (the sandbox's R22d)", async () => {
    const p = script("ok.sh", "echo '{}'\n");
    const reverting: ExecPolicy = { ...exec(PATHONLY), lease: () => ({ env: PATHONLY, release: () => [".git/hooks/pre-commit"] }) };
    expect(await createHomeScriptRunner({ exec: reverting, cwd: dir })({ block: "s", scriptPath: p })).toMatchObject({ ok: false, error: "sandbox" });
  });

  test("an executable without an interpreter extension runs itself", async () => {
    const p = script("bin", "#!/bin/sh\necho '{\"x\":1}'\n", true);
    const r = await createHomeScriptRunner({ exec: exec(PATHONLY), cwd: dir })({ block: "b", scriptPath: p });
    expect(r.ok && r.stdout.trim()).toBe('{"x":1}');
  });

  test("no model is called: a fake gateway in the scripts' environment hears nothing while a home of real scripts resolves", async () => {
    let hits = 0;
    const gw = Bun.serve({ port: 0, fetch: () => (hits++, new Response("{}")) });
    try {
      const ui: HopUi = { starters: [], home: { blocks: ["spend", "agents", "sites", "hops"].map((id) => ({ ...block(id), scriptPath: script(`${id}.py`, `import sys\nsys.stdout.write(open(${JSON.stringify(join(OUTPUTS, `${id}.json`))}).read())\n`) })) } };
      const run = createHomeScriptRunner({ exec: exec({ ...PATHONLY, YODEX_GATEWAY_URL: `http://127.0.0.1:${gw.port}` }), cwd: dir });
      const r = new HomeResolver({ hop: { name: "mlpal", version: "0.3.0", ui }, run, cacheDir: cache });
      const u = updates(4);
      r.get(u.push);
      expect((await u.done).every((b) => b.display?.level === "block" && !b.error)).toBe(true);
      expect(hits).toBe(0);
    } finally {
      gw.stop(true);
    }
  });
});
