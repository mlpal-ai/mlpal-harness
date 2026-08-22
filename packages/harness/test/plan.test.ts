import { describe, expect, test } from "bun:test";
import { exitPlanModeTool } from "../src/tools/builtin/plan";

describe("ExitPlanMode tool", () => {
  test("is read-only and echoes the plan for approval", async () => {
    expect(exitPlanModeTool.readOnly).toBe(true);
    const r = await exitPlanModeTool.call({ plan: "1. add farewell()\n2. add a test" }, { cwd: "/" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("add farewell()");
    expect(r.content).toContain("plan ready for approval");
  });
  test("is in the default registry", async () => {
    const { defaultRegistry } = await import("../src/tools");
    expect(defaultRegistry().get("ExitPlanMode")).toBeTruthy();
  });
});
