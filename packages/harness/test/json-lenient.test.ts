import { describe, expect, test } from "bun:test";
import { parseJsonLenient } from "../src/tools/json";

const ok = (raw: string): unknown => {
  const r = parseJsonLenient(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
};

describe("parseJsonLenient — LLM malformation classes", () => {
  test("strict JSON passes through untouched (the fast path)", () => {
    expect(ok('[{"a": 1, "b": [true, null]}]')).toEqual([{ a: 1, b: [true, null] }]);
  });

  test("single-quoted strings and keys", () => {
    expect(ok("[{'question': 'Which one?', 'options': []}]")).toEqual([{ question: "Which one?", options: [] }]);
  });

  test("unquoted keys", () => {
    expect(ok('[{question: "Which?", multiSelect: false}]')).toEqual([{ question: "Which?", multiSelect: false }]);
  });

  test("trailing commas in objects and arrays", () => {
    expect(ok('[{"a": 1,}, ]')).toEqual([{ a: 1 }]);
  });

  test("markdown fences around the payload", () => {
    expect(ok('```json\n[{"a": 1}]\n```')).toEqual([{ a: 1 }]);
  });

  test("leading prose before the value", () => {
    expect(ok('Here are the questions: [{"a": 1}]')).toEqual([{ a: 1 }]);
  });

  test("literal newlines and tabs inside strings (strict JSON forbids them)", () => {
    expect(ok('[{"preview": "line one\nline two\tend"}]')).toEqual([{ preview: "line one\nline two\tend" }]);
  });

  test("Python literals: True / False / None", () => {
    expect(ok('[{"multiSelect": True, "x": False, "y": None}]')).toEqual([{ multiSelect: true, x: false, y: null }]);
  });

  test("smart quotes from prose-trained models", () => {
    expect(ok("[{“question”: “Which db?”}]")).toEqual([{ question: "Which db?" }]);
  });

  test("unescaped interior double quotes inside prose values", () => {
    expect(ok('[{"label": "the "big" rewrite"}]')).toEqual([{ label: 'the "big" rewrite' }]);
  });

  test("apostrophes inside single-quoted strings close only at structure", () => {
    expect(ok("[{'label': 'it's fine'}]")).toEqual([{ label: "it's fine" }]);
  });

  test("comments are skipped", () => {
    expect(ok('[/* pick */ {"a": 1} // done\n]')).toEqual([{ a: 1 }]);
  });

  test("escape sequences still work (\\n, \\\", \\u)", () => {
    expect(ok('[{"a": "x\\ny \\"q\\" \\u0041"}]')).toEqual([{ a: 'x\ny "q" A' }]);
  });

  test("the real-world case: a stringified questions array with mixed damage", () => {
    const raw =
      "[{'question': 'What do you want to work on right now?', header: 'Today', options: [\n" +
      "  {label: 'An MLPal repo change', description: 'Feature, bug fix, or refactor',},\n" +
      "  {label: 'The pizza-voice demo', description: 'Keep building the Slice app'},\n" +
      "],}]";
    const v = ok(raw) as Array<{ question: string; options: Array<{ label: string }> }>;
    expect(v[0]!.question).toContain("work on right now");
    expect(v[0]!.options.length).toBe(2);
    expect(v[0]!.options[1]!.label).toBe("The pizza-voice demo");
  });
});

describe("parseJsonLenient — fail-safe on the unrecoverable", () => {
  test("no JSON value at all", () => {
    expect(parseJsonLenient("just a sentence, no structure").ok).toBe(false);
  });

  test("hopelessly truncated structure", () => {
    expect(parseJsonLenient('[{"a": [1, 2').ok).toBe(false);
  });

  test("ambiguous inner quote that would mis-parse fails instead of guessing", () => {
    // The early-close lands on ':' → structural mismatch → throw → ok:false. Never a wrong value.
    const r = parseJsonLenient('[{"a": "deploy "prod": yes"}]');
    if (r.ok) {
      // If a future refinement recovers this, it must recover it CORRECTLY.
      expect((r.value as Array<{ a: string }>)[0]!.a).toBe('deploy "prod": yes');
    } else {
      expect(r.ok).toBe(false);
    }
  });
});
