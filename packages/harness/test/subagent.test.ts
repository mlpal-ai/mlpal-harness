import { describe, expect, test } from "bun:test";
import { createTaskTool } from "../src/subagent/task";

describe("Task tool", () => {
  test("delegates to the runner and returns its result", async () => {
    let received: { description: string; prompt: string } | undefined;
    const tool = createTaskTool(async (args) => {
      received = args;
      return { text: "child result: computed 391", sessionId: "child-1" };
    });
    expect(tool.name).toBe("Agent");
    const r = await tool.call(
      { description: "compute product", prompt: "multiply 17 by 23 and report it" },
      { cwd: "/tmp" },
    );
    expect(r.content).toContain("child result: computed 391");
    expect(received?.prompt).toBe("multiply 17 by 23 and report it");
  });

  test("empty sub-agent output yields a placeholder", async () => {
    const tool = createTaskTool(async () => ({ text: "", sessionId: "s" }));
    const r = await tool.call({ description: "x", prompt: "y" }, { cwd: "/tmp" });
    expect(r.content).toContain("no output");
  });
});
