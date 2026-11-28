import { describe, expect, test } from "bun:test";
import { personOnlyAsk } from "../src/loop/agent";
import { createPolicy, defaultForMode, type PermissionMode, type PermissionRequest } from "../src/permission/engine";

/** Review R1: "always ask" is a property of the call that no mode, grant, judge, hook or default may lower. */
const req: PermissionRequest = { toolName: "GenerateImage", input: { prompt: "x", n: 4, quality: "hd" }, readOnly: false, isEdit: true, principal: { type: "human" } as never, alwaysAsk: "GenerateImage: 4 images, hd quality" };
const MODES: PermissionMode[] = ["manual", "cruise", "autopilot"];

describe("always ask holds on every path", () => {
  test("createPolicy asks in every mode but recon, whatever the allow rules", () => {
    for (const mode of MODES) expect([mode, (createPolicy({ mode, allow: ["GenerateImage"] })(req) as { behavior: string }).behavior]).toEqual([mode, "ask"]);
    expect((createPolicy({ mode: "recon" })(req) as { behavior: string }).behavior).toBe("deny");
  });

  test("defaultForMode, which a host re-runs with the live mode (answerBeforePrompt, Shift+Tab), asks too", () => {
    for (const mode of MODES) expect([mode, defaultForMode(mode, req).behavior]).toEqual([mode, "ask"]);
    expect(defaultForMode("recon", req).behavior).toBe("deny");
    // the same call below its threshold is the mode's
    const { alwaysAsk: _a, ...cheap } = req;
    expect([defaultForMode("cruise", cheap).behavior, defaultForMode("autopilot", cheap).behavior]).toEqual(["allow", "allow"]);
  });

  test("the ask is the person's alone: no judge, grant or mode cycle answers it", () => {
    expect(personOnlyAsk({ alwaysAsk: req.alwaysAsk })).toBe(true);
    expect(personOnlyAsk({ reason: "an ordinary ask" })).toBe(false);
  });
});
