import { describe, expect, test } from "bun:test";
import type { DisplayCaps } from "@mlpal/harness-protocol";
import { createShowTool, displayInstructions, foldDisplayHistory, resolveDisplay } from "../src/display";
import { SHOW_JSON_SCHEMA } from "../src/display/schema";
import { JsonLogger } from "../src/obs/logger";
import { MemoryMetrics } from "../src/obs/metrics";

/** Review-media integration: a UI pinned at protocol 0.27.1 refuses arc, so the arc mark is offered, and admitted by
 *  Show, only to a client that names it in run.display.marks; any other gets the text fallback of a bar chart. */
const caps = (marks?: string[]): DisplayCaps => ({ v: 1, client: "web", levels: ["text", "block"], catalogs: ["harness.v1/1"], ...(marks ? { marks } : {}), viewport: "desktop", theme: "light", locale: "en-US", timeZone: "UTC" });
const PIE = {
  block_id: "pie",
  kind: "chart",
  spec: { vl: { data: { values: [{ g: "a", v: 3 }, { g: "b", v: 1 }] }, mark: "arc", encoding: { theta: { field: "v", type: "quantitative" }, color: { field: "g", type: "nominal" } } } },
  fallback: { text: "Group a holds 75% of the total (3 of 4) and group b the other 25%." },
};

describe("the arc mark is gated by run.display.marks", () => {
  test("resolveDisplay keeps the marks a client names, and only the optional ones it knows", () => {
    expect([...resolveDisplay(caps())!.marks]).toEqual([]);
    expect([...resolveDisplay(caps(["arc", "sunburst"]))!.marks]).toEqual(["arc"]);
  });

  test("the system section and the tool schema name arc only for a client that named it", () => {
    expect(displayInstructions(resolveDisplay(caps())!)).not.toMatch(/\barc\b|pie/);
    expect(displayInstructions(resolveDisplay(caps(["arc"]))!)).toMatch(/chart mark arc, for a pie/);
    expect(JSON.stringify(SHOW_JSON_SCHEMA)).not.toMatch(/"arc"/);
  });

  test("Show refuses a pie for a client that did not name arc, and draws it for one that did", async () => {
    const run = async (marks?: string[]) => {
      const show = createShowTool({ policy: resolveDisplay(caps(marks))!, history: async (id) => foldDisplayHistory([], id), logger: new JsonLogger({ level: "error", sink: () => {} }), metrics: new MemoryMetrics() });
      return show.call(PIE as never, { cwd: "/tmp", toolUseId: "toolu_pie" });
    };
    const old = await run();
    expect([old.isError, JSON.stringify(old.content)]).toEqual([true, expect.stringContaining("KIND_NOT_ALLOWED")]);
    const named = await run(["arc"]);
    expect([named.isError ?? false, (named.meta?.display?.[0] as { kind?: string } | undefined)?.kind]).toEqual([false, "chart"]);
  });
});
