import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { displayEnvelopeSchema, type ClientMessage, type HomeBlock, type HomeView, type ServerMessage } from "@mlpal/harness-protocol";
import { HomeResolver } from "../src/display/home";
import type { HomeScriptRunner, ScriptOutcome } from "../src/display/home-script";
import type { HopUiBlock } from "../src/profile/ui";

/**
 * W3-1: the wire fixtures the home UI (W3-3) builds against, one per case, produced by the real resolver from the
 * outputs in fixtures/home/outputs: the frames are what an engine sends, not hand-written. `UPDATE_HOME_FIXTURES=1`
 * rewrites them; otherwise each must equal what the resolver produces now.
 */

const HOME = join(import.meta.dir, "fixtures", "home");
const output = (name: string): string => readFileSync(join(HOME, "outputs", `${name}.json`), "utf8");
const T0 = Date.parse("2026-11-28T09:00:30Z");
const TITLES: Record<string, string> = { spend: "Gateway spend, last 7 days", agents: "Your agents", sites: "Your sites", hops: "Your published HOPs" };
const block = (id: string): HopUiBlock => ({ id, title: TITLES[id]!, script: `ui/home/${id}.py`, scriptPath: `/hop/ui/home/${id}.py`, refresh: "15m", refreshMs: 900_000 });
const STARTERS = ["Publish my HOP", "What did my agents do today?", "Make a site for my side project"];
const ok = (stdout: string): ScriptOutcome => ({ ok: true, stdout, ms: 5, stderrBytes: 0, stderrTail: "" });
const timeout: ScriptOutcome = { ok: false, error: "timeout", detail: "timeout", ms: 10_000, stderrBytes: 0, stderrTail: "" };

async function resolveAll(r: HomeResolver, n: number): Promise<HomeBlock[]> {
  const got: HomeBlock[] = [];
  const done = Promise.withResolvers<void>();
  r.get((b) => {
    got.push(b);
    if (got.length === n) done.resolve();
  });
  await done.promise;
  return got;
}

async function frames(): Promise<Record<string, ClientMessage | ServerMessage>> {
  const cache = mkdtempSync(join(tmpdir(), "home-fx-"));
  try {
    let clock = T0;
    const now = () => clock;
    const blocks = ["spend", "agents", "sites", "hops"].map(block);
    const hop = { name: "mlpal", version: "0.3.0", ui: { starters: STARTERS, home: { blocks } } };
    let table: Record<string, () => ScriptOutcome> = Object.fromEntries(blocks.map((b) => [b.id, () => ok(output(b.id))]));
    const run: HomeScriptRunner = async (s) => table[s.block]!();
    const r = new HomeResolver({ hop, run, cacheDir: cache, now });
    const home = (requestId: string, view: HomeView): ServerMessage => ({ type: "home", requestId, ...view });
    const first = home("h1", r.view());
    const updates = await resolveAll(r, 4);
    const spendUpdate: ServerMessage = { type: "home_update", hop: "mlpal@0.3.0", block: updates.find((b) => b.id === "spend")! };
    const four = home("h2", r.view());
    clock += 61_000;
    table = { ...table, agents: () => timeout };
    await resolveAll(r, 4);
    const stale = home("h3", r.view());
    // a new HOP version: nothing cached; one script never ran yet, one failed, one printed a refused block whose
    // fallback passed
    const hold = new Promise<ScriptOutcome>(() => {});
    const bad = { kind: "chart", spec: { vl: { data: { url: "https://example.com/spend.json" }, mark: "bar" } }, fallback: { text: "Gateway spend was 365 compute units over the last 7 days." } };
    const table2: Record<string, () => ScriptOutcome | Promise<ScriptOutcome>> = { spend: () => ok(JSON.stringify(bad)), agents: () => timeout, sites: () => hold, hops: () => ok(output("hops")) };
    const r2 = new HomeResolver({ hop: { ...hop, version: "0.4.0" }, run: async (s) => table2[s.block]!(), cacheDir: cache, now });
    const seen: HomeBlock[] = [];
    r2.get((b) => seen.push(b));
    while (seen.length < 3) await Bun.sleep(1);
    const never = home("h4", r2.view());
    const empty = home("h5", new HomeResolver({ hop: { name: "coding", version: "1.1.0" }, run, cacheDir: cache, now }).view());
    return {
      "get-home": { type: "get_home", requestId: "h1" },
      "get-home-named": { type: "get_home", requestId: "h1", hop: "mlpal@0.3.0" },
      "home-first": first,
      "home-update": spendUpdate,
      "home-four": four,
      "home-stale": stale,
      "home-never-failed-fallback": never,
      "home-empty": empty,
    };
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

describe("home wire fixtures", () => {
  test("each fixture is what the resolver sends now, and every display in it is a valid envelope", async () => {
    const got = await frames();
    const dir = join(HOME, "frames");
    if (process.env.UPDATE_HOME_FIXTURES === "1") {
      mkdirSync(dir, { recursive: true });
      for (const [name, f] of Object.entries(got)) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(f, null, 2)}\n`);
    }
    for (const [name, f] of Object.entries(got)) {
      expect([name, JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"))]).toEqual([name, JSON.parse(JSON.stringify(f))]);
      const blocks = f.type === "home" ? f.blocks : f.type === "home_update" ? [f.block] : [];
      for (const b of blocks) if (b.display) expect(displayEnvelopeSchema.safeParse(b.display).success).toBe(true);
    }
    const never = got["home-never-failed-fallback"] as Extract<ServerMessage, { type: "home" }>;
    expect(never.blocks.map((b) => [b.id, b.display?.level ?? null, b.error ?? null, b.stale])).toEqual([
      ["spend", "text", "invalid_block", false],
      ["agents", null, "timeout", false],
      ["sites", null, null, false],
      ["hops", "block", null, false],
    ]);
    const stale = got["home-stale"] as Extract<ServerMessage, { type: "home" }>;
    expect(stale.blocks.filter((b) => b.stale).map((b) => [b.id, b.error])).toEqual([["agents", "timeout"]]);
  });
});
