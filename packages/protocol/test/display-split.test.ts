import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

/**
 * The wire half of the display protocol must not reach the chart grammar or the cost walker: a client that only reads
 * envelopes bundles per module, so one value import from the light side would put them in its first page. Type-only
 * imports are erased and do not count.
 */
const dir = new URL("../src/display/", import.meta.url);
const VALUE_IMPORT = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"\.\/([\w-]+)\.js"/gm;

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(new URL(`${file}.ts`, dir), "utf8");
    for (const m of source.matchAll(VALUE_IMPORT)) {
      // an import list made only of `type` names is erased too
      const names = /\{([^}]*)\}/.exec(m[0])?.[1];
      if (names && names.split(",").every((n) => n.trim() === "" || n.trim().startsWith("type "))) continue;
      stack.push(m[1]!);
    }
  }
  return seen;
}

describe("the light wire module never reaches the heavy validation modules", () => {
  test("from wire.ts, chart.ts, cost.ts and blocks.ts are unreachable", () => {
    const light = reachable("wire");
    for (const heavy of ["chart", "cost", "blocks", "show", "fallback", "validate"]) expect([heavy, light.has(heavy)]).toEqual([heavy, false]);
    expect([...light].sort()).toEqual(["block-schemas", "caps", "catalog", "envelope", "errors", "fields", "settle", "shape", "wire"]);
  });

  test("validate.ts reaches them, and the package exports it as ./validate", () => {
    const heavy = reachable("validate");
    expect(["chart", "cost", "blocks"].every((f) => heavy.has(f))).toBe(true);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./validate"].bun).toBe("./src/display/validate.ts");
  });

  test("the subpath and the root give the same functions", async () => {
    const root = await import("../src/index");
    const sub = await import("../src/display/validate");
    expect([sub.validateBlock, sub.chartCost, sub.checkShowInput]).toEqual([root.validateBlock, root.chartCost, root.checkShowInput]);
  });
});
