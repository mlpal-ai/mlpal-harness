import { describe, expect, test } from "bun:test";
import { chartCost, validateBlock } from "../src/index";

/**
 * chartCost against the real renderer (review 6): random charts from the grammar, kept when validateBlock accepts
 * them, are drawn with Vega and Vega-Lite (compile, parse, run, toSVG), and the measured time must stay within a fixed
 * multiple of the estimate. Vega is not a dependency of this repo, so the test runs only when
 * DISPLAY_COST_VEGA_DIR names a node_modules that holds vega and vega-lite (the web UI's: Vega 6.4.0, Vega-Lite
 * 6.5.0); otherwise it is skipped. The sample is small and seeded, so a run is short and repeatable;
 * DISPLAY_COST_VEGA_SAMPLE and DISPLAY_COST_VEGA_SEED widen it for a longer local search.
 */
const VEGA_DIR = process.env.DISPLAY_COST_VEGA_DIR;
const SAMPLE = Number(process.env.DISPLAY_COST_VEGA_SAMPLE ?? 24);
const SEED = Number(process.env.DISPLAY_COST_VEGA_SEED ?? 20261128);
/** Measured time may be at most this many times the estimate (and the estimate is floored at 50 ms, a chart's base). */
const MULTIPLE = 3;

type Obj = Record<string, unknown>;

/** A seeded generator (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generator(seed: number) {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const q = (field: string) => ({ field, type: "quantitative" });
  const op = () => pick(["sum", "mean", "count", "rank", "median", "distinct", "ci0", "min", "max", "q1"]);
  const frameFor = (o: string) => (["median", "distinct", "ci0", "q1"].includes(o) ? [null, null] : pick([[null, 0], [-2, 2], [-50, 50], [null, null]]));
  const layer = (): Obj => {
    const kind = pick(["raw", "window", "aggregate", "channel", "fold", "bin", "composite", "paths", "shared"]);
    const mark = pick(["line", "point", "bar", "area", "tick", "text", "rule"]);
    switch (kind) {
      case "raw":
        return { mark, encoding: { x: q(pick(["i", "a"])), y: q(pick(["a", "b"])), ...(r() < 0.5 ? { color: { field: "c", type: "nominal" } } : {}), ...(mark === "text" ? { text: q("a") } : {}) } };
      case "window": {
        const o = op();
        return { transform: [{ window: [{ op: o, field: "a", as: "w" }], frame: frameFor(o), sort: [{ field: "i" }] }], mark, encoding: { x: q("i"), y: q("w"), ...(mark === "text" ? { text: q("w") } : {}) } };
      }
      case "aggregate": {
        const g = pick(["c", "i"]);
        return { transform: [{ aggregate: [{ op: pick(["sum", "mean", "median", "ci0", "ci1", "distinct"]), field: "a", as: "s" }], groupby: [g] }], mark, encoding: { x: { field: g, type: "ordinal" }, y: q("s"), ...(mark === "text" ? { text: q("s") } : {}) } };
      }
      case "channel":
        return { mark, encoding: { x: { field: pick(["c", "i"]), type: "ordinal" }, y: { field: "a", aggregate: pick(["sum", "mean", "median", "ci0", "max"]), type: "quantitative" }, ...(mark === "text" ? { text: q("a") } : {}) } };
      case "fold":
        return { transform: [{ fold: ["a", "b"] }], mark: pick([mark, "area"]), encoding: { x: q("i"), y: q("value"), color: { field: "key", type: "nominal" }, ...(mark === "text" ? { text: q("value") } : {}) } };
      case "paths": // a line or area split by a field a window wrote (Vega-Lite makes a path per value)
        return { transform: [{ window: [{ op: "row_number", as: "w" }] }], mark: pick(["line", "area"]), encoding: { x: q("i"), y: q("a"), [pick(["color", "detail", "strokeDash"])]: { field: pick(["w", "c"]), type: "nominal" } } };
      case "shared": // channels a layer shares with its views
        return { encoding: { x: { field: pick(["c", "i"]), type: "ordinal" }, y: { field: "a", aggregate: pick(["mean", "ci0", "median"]), type: "quantitative" } }, layer: [{ mark: "line" }, { mark: pick(["point", "bar"]) }] };
      case "bin":
        return { mark: "bar", encoding: { x: { field: "a", bin: { maxbins: pick([10, 40, 100]) }, type: "quantitative" }, y: { aggregate: "count", type: "quantitative" } } };
      default:
        return { mark: pick([{ type: "errorband", extent: pick(["ci", "stderr"]) }, "boxplot", { type: "errorbar", extent: "ci" }]), encoding: { x: { field: pick(["c", "i"]), type: "ordinal" }, y: q("a") } };
    }
  };
  return (): Obj => {
    const n = pick([200, 1_000, 2_500, 5_000]);
    const values = Array.from({ length: n }, (_, i) => ({ i, a: (i * 7919) % 1000, b: n - i, c: `c${i % 7}` }));
    const layers = Array.from({ length: 1 + Math.floor(r() * 4) }, layer);
    const vl = r() < 0.25 ? { data: { values }, vconcat: [{ layer: layers }, { layer: layers.slice(0, 2) }] } : { data: { values }, layer: layers };
    return { vl };
  };
}

const maybe = VEGA_DIR ? describe : describe.skip;
maybe("chartCost against Vega: measured time within a fixed multiple of the estimate", () => {
  test(`a seeded sample of ${SAMPLE} accepted random charts`, async () => {
    const vega = await import(`${VEGA_DIR}/vega/build/vega.module.js`);
    const vl = await import(`${VEGA_DIR}/vega-lite/build/index.js`);
    // A spec Vega itself cannot draw (a few generated nestings) still counts: the time until it fails is held to
    // the same bound, and the failures are reported.
    let undrawable = 0;
    const draw = async (spec: unknown): Promise<number> => {
      const t = performance.now();
      try {
        const view = new vega.View(vega.parse(vl.compile(spec as never).spec, undefined, { ast: true }), { renderer: "none", expr: vega.expressionInterpreter });
        await view.toSVG();
        view.finalize();
      } catch {
        undrawable++;
      }
      return performance.now() - t;
    };
    await draw({ data: { values: [{ i: 1 }] }, mark: "point", encoding: { x: { field: "i", type: "quantitative" } } });
    const next = generator(SEED);
    const results: Array<{ estimate: number; ms: number }> = [];
    for (let tries = 0; results.length < SAMPLE && tries < SAMPLE * 100; tries++) {
      const spec = next();
      if (!validateBlock("chart", spec).ok) continue;
      const cost = chartCost(spec);
      if (!cost.ok) continue;
      results.push({ estimate: cost.estimateMs, ms: await draw((spec as { vl: unknown }).vl) });
    }
    expect(results.length).toBe(SAMPLE);
    const worst = results.reduce((w, x) => (x.ms / Math.max(x.estimate, 50) > w.ms / Math.max(w.estimate, 50) ? x : w));
    console.log(`chartCost vs Vega: worst measured ${Math.round(worst.ms)} ms for an estimate of ${worst.estimate} (x${(worst.ms / Math.max(worst.estimate, 50)).toFixed(2)}); ${undrawable} Vega could not draw; slowest ${Math.round(Math.max(...results.map((x) => x.ms)))} ms`);
    for (const x of results) expect(x.ms).toBeLessThanOrEqual(MULTIPLE * Math.max(x.estimate, 50));
  }, 120_000 + SAMPLE * 10_000);
});
