import { describe, expect, test } from "bun:test";
import { ModelRouter, subtaskSpec } from "../src/routing/router";

describe("ModelRouter", () => {
  test("resolves roles with sensible fallbacks", () => {
    const r = new ModelRouter({ main: "M", summarize: "S", subagent: "A" });
    expect(r.resolve("main")).toBe("M");
    expect(r.resolve("summarize")).toBe("S");
    expect(r.resolve("subagent")).toBe("A");
    expect(r.resolve("classify")).toBe("S"); // classify → summarize → main
    expect(r.main).toBe("M");
  });

  test("falls back to main when a role is unset", () => {
    const r = new ModelRouter({ main: "M" });
    expect(r.resolve("summarize")).toBe("M");
    expect(r.resolve("subagent")).toBe("M");
    expect(r.resolve("classify")).toBe("M");
  });
});

describe("subtaskSpec — subtask routing default", () => {
  test("unpinned main model => cheap tier (save money)", () => {
    expect(subtaskSpec(undefined, false)).toBe("cheap");
  });
  test("pinned main model => inherit (use the model I asked for)", () => {
    expect(subtaskSpec(undefined, true)).toBe("inherit");
  });
  test("explicit config wins over both defaults", () => {
    expect(subtaskSpec("mid", false)).toBe("mid");
    expect(subtaskSpec("mid", true)).toBe("mid");
    expect(subtaskSpec("gpt-5.6-luna", true)).toBe("gpt-5.6-luna");
    expect(subtaskSpec("inherit", false)).toBe("inherit");
  });
});
