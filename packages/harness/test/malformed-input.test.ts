import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseJsonInput } from "../src/gateway/client";
import { MALFORMED_INPUT_KEY } from "../src/tools/json";
import { runTool } from "../src/tools/registry";
import { defaultRegistry, defineTool, ToolRegistry } from "../src/tools";

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

  test("the echo redacts secret-like values at any depth, keeping their keys", async () => {
    const reg = new ToolRegistry();
    reg.register(defineTool({
      name: "Hook",
      description: "test tool",
      readOnly: true,
      schema: z.object({ name: z.string().min(1), delivery: z.object({ webhook_secret: z.string() }).optional() }),
      call: async () => ({ content: "unreachable" }),
    }) as never);
    const value = "s3cret-value-1234567";
    const res = await runTool(reg, "Hook", { name: "", delivery: { webhook_secret: value }, auth: [{ apiKey: value, Password: value, access_token: value }], tokens: { a: value }, max_tokens: 5 }, { cwd: "/tmp" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("Invalid input for Hook");
    expect(res.content).toContain('"delivery":{"webhook_secret":"[redacted]"}');
    expect(res.content).toContain('"apiKey":"[redacted]","Password":"[redacted]","access_token":"[redacted]"');
    expect(res.content).toContain('"tokens":"[redacted]","max_tokens":5');
    expect(res.content).not.toContain(value);
  });
});

