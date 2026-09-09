import { describe, expect, test } from "bun:test";
import { sanitizeJsonSchema } from "../src/tools/types";

describe("sanitizeJsonSchema", () => {
  test("folds exclusive bounds into inclusive ones (Gemini rejects exclusiveMinimum/Maximum) and strips the usual", () => {
    const js = {
      $schema: "x",
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "integer", exclusiveMinimum: 0 },
        pct: { type: "number", minimum: 1, exclusiveMinimum: 0, exclusiveMaximum: 100 },
        list: { type: "array", items: { type: "object", properties: { n: { type: "number", exclusiveMaximum: 5 } } } },
      },
    } as Record<string, unknown>;
    sanitizeJsonSchema(js);
    const p = js.properties as Record<string, Record<string, unknown>>;
    expect(p.id).toEqual({ type: "integer", minimum: 0 });
    expect(p.pct).toEqual({ type: "number", minimum: 1, maximum: 100 }); // an explicit minimum is kept
    expect(((p.list!.items as Record<string, unknown>).properties as Record<string, unknown>).n).toEqual({ type: "number", maximum: 5 });
    expect(js.$schema).toBeUndefined();
    expect(js.additionalProperties).toBeUndefined();
  });
});
