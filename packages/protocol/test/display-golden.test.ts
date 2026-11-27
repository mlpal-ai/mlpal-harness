import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { checkShowInput, displayEnvelopeSchema, validateBlock } from "../src/index";

/** One golden per first-wave block, shared with the engine, the web UI and the CLI: the Show input, the envelope the
 *  engine emits for it (the engine's test checks that it does), and the complete fallback as a markdown snapshot. */
const dir = new URL("./fixtures/display/golden/", import.meta.url);
const goldens = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

describe("display goldens", () => {
  test("one per first-wave kind", () => {
    const kinds = goldens.map((g) => JSON.parse(readFileSync(new URL(`${g}.json`, dir), "utf8")).show.kind).sort();
    expect(kinds).toEqual(["chart", "grid", "kpis"]);
  });

  for (const name of goldens) {
    test(`${name}: valid, drawn as written, and its fallback matches the snapshot`, () => {
      const { show } = JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));
      const r = checkShowInput(show);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      expect(validateBlock(show.kind, show.spec)).toEqual({ ok: true, value: show.spec });
      expect(r.show.spec).toEqual(show.spec);
      expect(r.show.fallback + "\n").toBe(readFileSync(new URL(`${name}.fallback.md`, dir), "utf8"));
    });

    test(`${name}: its envelope is a valid block envelope carrying that spec and that fallback`, () => {
      const { show, envelope } = JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8"));
      expect(displayEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect([envelope.level, envelope.kind, envelope.spec]).toEqual(["block", show.kind, show.spec]);
      expect(envelope.fallback.text + "\n").toBe(readFileSync(new URL(`${name}.fallback.md`, dir), "utf8"));
    });
  }
});
