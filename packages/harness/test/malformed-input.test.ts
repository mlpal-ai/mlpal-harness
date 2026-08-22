import { describe, expect, test } from "bun:test";
import { parseJsonInput } from "../src/gateway/client";
import { MALFORMED_INPUT_KEY } from "../src/tools/json";
import { runTool } from "../src/tools/registry";
import { defaultRegistry } from "../src/tools";

describe("gateway tool-input parsing (parseJsonInput)", () => {
  test("strict JSON parses; empty input is {}", () => {
    expect(parseJsonInput('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonInput("  ")).toEqual({});
  });

  test("repairable malformations are repaired in place (trailing comma, single quotes)", () => {
    expect(parseJsonInput("{'command': 'ls',}")).toEqual({ command: "ls" });
  });

  test("unrecoverable input plants the marker instead of silently becoming {}", () => {
    const out = parseJsonInput('{"command": "echo hi', ); // truncated mid-stream
    expect(out[MALFORMED_INPUT_KEY]).toContain('{"command": "echo hi');
    expect(Object.keys(out)).toEqual([MALFORMED_INPUT_KEY]);
  });
});

describe("registry error surfaces (the un-debuggable-from-a-screenshot fix)", () => {
  test("marker input → a precise 'not valid JSON' error carrying what was sent", async () => {
    const res = await runTool(
      defaultRegistry(),
      "Bash",
      { [MALFORMED_INPUT_KEY]: '{"command": "echo' },
      { cwd: "/tmp" },
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("was not valid JSON");
    expect(res.content).toContain('{"command": "echo'); // the payload, so the retry is a correction
  });

  test("zod validation failure echoes the received input", async () => {
    const res = await runTool(defaultRegistry(), "Bash", { commnad: "typo-field" }, { cwd: "/tmp" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Invalid input for Bash");
    expect(res.content).toContain("Received (truncated):");
    expect(res.content).toContain("typo-field");
  });
});

