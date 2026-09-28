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


  test("model param is passed through to the runner (multi-model delegation)", async () => {
    let received: { model?: string } | undefined;
    const tool = createTaskTool(async (args) => {
      received = args;
      return { text: "ok", sessionId: "c" };
    });
    await tool.call(
      { description: "second opinion", prompt: "review this", model: "gpt-5.6-sol" },
      { cwd: "/tmp" },
    );
    expect(received?.model).toBe("gpt-5.6-sol");
    // schema advertises it
    expect(JSON.stringify(tool.jsonSchema)).toContain("model");
  });

  test("isolation: worktree is passed through on both paths and changes the background wording", async () => {
    const seen: { isolation?: string; background?: boolean }[] = [];
    const tool = createTaskTool(async (args) => {
      seen.push({ isolation: args.isolation, background: args.background });
      return { text: "ok", sessionId: "c" };
    });
    await tool.call({ description: "edit", prompt: "change x", isolation: "worktree" }, { cwd: "/tmp" });
    const bg = await tool.call({ description: "edit bg", prompt: "change y", run_in_background: true, isolation: "worktree" }, { cwd: "/tmp" });
    expect(bg.content).toContain("in its own worktree and may edit there");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([{ isolation: "worktree", background: undefined }, { isolation: "worktree", background: true }]);
    expect(JSON.stringify(tool.jsonSchema)).toContain("worktree");
  });

  test("empty sub-agent output yields a placeholder", async () => {
    const tool = createTaskTool(async () => ({ text: "", sessionId: "s" }));
    const r = await tool.call({ description: "x", prompt: "y" }, { cwd: "/tmp" });
    expect(r.content).toContain("no output");
  });
});
