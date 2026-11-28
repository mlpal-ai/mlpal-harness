import { describe, expect, test } from "bun:test";
import { CHART_OPTIONAL_MARKS, checkShowInput, parseDisplayCaps, validateBlock } from "../src/index";

/** Review-media R7 (a pie's slices are bounded from the data, never inferred) and the arc gate (only a client that
 *  names `arc` in run.display.marks gets one). */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ i, cat: `c${i}`, five: `g${i % 5}`, three: `h${i % 3}`, a: i + 1, b: n - i, "x.y": `k${i}`, t: `2026-${String((i % 12) + 1).padStart(2, "0")}-01` }));
const pie = (enc: Record<string, unknown>, extra: Record<string, unknown> = {}, n = 200) => ({ vl: { data: { values: rows(n) }, mark: { type: "arc", innerRadius: 40 }, encoding: { theta: { field: "a", type: "quantitative", aggregate: "sum" }, ...enc }, ...extra } });
const refusal = (spec: unknown) => {
  const r = validateBlock("chart", spec);
  return r.ok ? null : r.errors.map((e) => e.message).join(" | ");
};
const WINDOW = { transform: [{ window: [{ op: "row_number", as: "w" }] }] };

describe("R7: a pie's slices are counted on a field of the data, or bounded by its rows", () => {
  test("the review's input: a colour a window writes, over 200 and 5,000 rows, is refused", () => {
    expect(refusal(pie({ color: { field: "w", type: "nominal" } }, WINDOW))).toMatch(/up to 200 slices \(w is not a field of the data/);
    expect(refusal({ vl: { data: { values: rows(5000) }, ...WINDOW, mark: { type: "arc", innerRadius: 30 }, encoding: { theta: { field: "a", type: "quantitative" }, color: { field: "w", type: "nominal" } } } })).toMatch(/up to 5000 slices .*a pie draws at most 12/);
  });

  test("every candidate that would draw more than 12 slices is refused", () => {
    const over: Record<string, unknown> = {
      "colour on 200 distinct values": pie({ color: { field: "cat", type: "nominal" } }),
      "colour on an escaped-dot field": pie({ color: { field: "x\\.y", type: "nominal" } }),
      "colour on a field an aggregate writes": pie({ color: { field: "n", type: "nominal" } }, { transform: [{ aggregate: [{ op: "count", as: "n" }], groupby: ["cat"] }] }),
      "colour on a field a window overwrites": pie({ color: { field: "five", type: "nominal" } }, { transform: [{ window: [{ op: "row_number", as: "five" }] }] }),
      "colour on a binned field": pie({ color: { field: "b", type: "ordinal", bin: { maxbins: 100 } } }),
      "detail on 200 values, colour a constant": pie({ color: { value: "#888" }, detail: { field: "cat", type: "nominal" } }),
      "colour 3 by detail 5: 15 slices": pie({ color: { field: "three", type: "nominal" }, detail: { field: "five", type: "nominal" } }),
      "no colour, a slice per row": { vl: { data: { values: rows(200) }, mark: "arc", encoding: { theta: { field: "a", type: "quantitative" } } } },
      "a folded key over 4 fields": pie({ color: { field: "key", type: "nominal" }, theta: { field: "value", type: "quantitative" } }, { transform: [{ fold: ["a", "b", "i", "five"] }] }),
      "a layer's shared colour": { vl: { data: { values: rows(200) }, encoding: { color: { field: "cat", type: "nominal" } }, layer: [{ mark: "arc", encoding: { theta: { field: "a", type: "quantitative" } } }] } },
      "a layer's shared transform writes the colour": { vl: { data: { values: rows(40) }, ...WINDOW, layer: [{ mark: "arc", encoding: { theta: { field: "a", type: "quantitative" }, color: { field: "w", type: "nominal" } } }] } },
    };
    const passed = Object.entries(over).filter(([, spec]) => refusal(spec) === null).map(([name]) => name);
    expect(passed).toEqual([]);
  });

  test("a pie the data bounds within 12 is drawn", () => {
    expect(refusal(pie({ color: { field: "five", type: "nominal" } }))).toBeNull();
    expect(refusal(pie({ color: { field: "t", type: "ordinal", timeUnit: "yearmonthdate" } }))).toBeNull();
    expect(refusal(pie({ color: { field: "three", type: "nominal" }, detail: { field: "three", type: "nominal" } }))).toBeNull();
    // a written colour over few rows: the rows bound it
    expect(refusal(pie({ color: { field: "w", type: "nominal" } }, WINDOW, 10))).toBeNull();
    // a filter keeps the colour countable
    expect(refusal(pie({ color: { field: "five", type: "nominal" } }, { transform: [{ filter: { field: "a", gt: 3 } }] }))).toBeNull();
  });
});

describe("the arc mark is offered only to a client that names it", () => {
  const show = { block_id: "pie", kind: "chart", spec: pie({ color: { field: "five", type: "nominal" } }), fallback: { text: "Five groups share the total; g0 is the largest at about a fifth of it." } };
  test("Show refuses arc for a client whose declaration lacks it, admits it for one that names it, and for an envelope's own check", () => {
    const old = checkShowInput(show, { kinds: new Set(["chart"]), marks: new Set() });
    expect(old.ok ? null : [old.error.code, old.error.path]).toEqual(["KIND_NOT_ALLOWED", expect.stringContaining("mark")]);
    expect(checkShowInput(show, { kinds: new Set(["chart"]), marks: new Set(CHART_OPTIONAL_MARKS) }).ok).toBe(true);
    expect(checkShowInput(show).ok).toBe(true);
  });
  test("run.display.marks parses, and a malformed one is dropped, not fatal", () => {
    const caps = { v: 1, client: "web", levels: ["text", "block"], catalogs: ["harness.v1/1"], viewport: "desktop", theme: "light", locale: "en-US", timeZone: "UTC" };
    const named = parseDisplayCaps({ ...caps, marks: ["arc"] });
    const junk = parseDisplayCaps({ ...caps, marks: "arc" });
    expect([named.ok && named.value.marks, junk.ok && junk.value.marks]).toEqual([["arc"], undefined]);
  });
});
