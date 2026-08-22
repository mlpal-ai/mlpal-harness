import { describe, expect, test } from "bun:test";
import { HUMAN } from "@mlpal/harness-protocol";
import {
  createPolicy,
  defaultForMode,
  type PermissionRequest,
} from "../src/permission/engine";

function req(
  toolName: string,
  input: Record<string, unknown>,
  readOnly: boolean,
  isEdit = false,
): PermissionRequest {
  return { toolName, input, readOnly, isEdit, principal: HUMAN };
}

// The interactive gate re-evaluates against the live mode via defaultForMode when the user raises
// autonomy mid-run. These lock in the per-mode decision the gate depends on to clear a pending prompt.
describe("defaultForMode (live re-check for a mid-run mode raise)", () => {
  const bash = req("Bash", { command: "ls" }, false);
  const edit = req("Write", { path: "a" }, false, true);
  const read = req("Read", { path: "a" }, true);
  test("autopilot allows anything — raising to it clears a pending prompt", () => {
    expect(defaultForMode("autopilot", bash).behavior).toBe("allow");
    expect(defaultForMode("autopilot", edit).behavior).toBe("allow");
  });
  test("cruise still asks for a command (so the prompt stays), allows edits/reads", () => {
    expect(defaultForMode("cruise", bash).behavior).toBe("ask");
    expect(defaultForMode("cruise", edit).behavior).toBe("allow");
    expect(defaultForMode("cruise", read).behavior).toBe("allow");
  });
  test("recon denies a change (never auto-resolved mid-cycle) and allows reads", () => {
    expect(defaultForMode("recon", bash).behavior).toBe("deny");
    expect(defaultForMode("recon", read).behavior).toBe("allow");
  });
  test("manual asks for a command", () => {
    expect(defaultForMode("manual", bash).behavior).toBe("ask");
  });
});

describe("manual mode", () => {
  const can = createPolicy({ mode: "manual" });
  test("allows read-only tools", async () => {
    expect((await can(req("Read", { path: "a" }, true))).behavior).toBe("allow");
  });
  test("asks for mutating tools", async () => {
    expect((await can(req("Bash", { command: "ls" }, false))).behavior).toBe("ask");
  });
});

describe("cruise mode (accept-edits)", () => {
  const can = createPolicy({ mode: "cruise" });
  test("auto-approves file edits and reads", async () => {
    expect((await can(req("Write", { path: "a" }, false, true))).behavior).toBe("allow");
    expect((await can(req("Edit", { path: "a" }, false, true))).behavior).toBe("allow");
    expect((await can(req("Read", { path: "a" }, true))).behavior).toBe("allow");
  });
  test("still asks for command execution and other tools", async () => {
    expect((await can(req("Bash", { command: "npm test" }, false))).behavior).toBe("ask");
    expect((await can(req("mcp__x__y", {}, false))).behavior).toBe("ask");
  });
});

describe("autopilot mode (bypass)", () => {
  const can = createPolicy({ mode: "autopilot" });
  test("allows everything, including commands", async () => {
    expect((await can(req("Bash", { command: "rm -rf x" }, false))).behavior).toBe("allow");
    expect((await can(req("Write", { path: "a" }, false, true))).behavior).toBe("allow");
  });
});

describe("recon mode", () => {
  const can = createPolicy({ mode: "recon" });
  test("allows reads, denies mutations", async () => {
    expect((await can(req("Grep", { pattern: "x" }, true))).behavior).toBe("allow");
    expect((await can(req("Write", { path: "a" }, false))).behavior).toBe("deny");
  });
});

describe("rules", () => {
  test("deny rule wins even in autopilot mode", async () => {
    const can = createPolicy({ mode: "autopilot", deny: ["Bash(rm*)"] });
    const d = await can(req("Bash", { command: "rm -rf /" }, false));
    expect(d.behavior).toBe("deny");
    // unrelated bash still allowed
    expect((await can(req("Bash", { command: "ls" }, false))).behavior).toBe("allow");
  });

  test("allow rule overrides default ask", async () => {
    const can = createPolicy({ mode: "manual", allow: ["Bash(git*)"] });
    expect((await can(req("Bash", { command: "git status" }, false))).behavior).toBe("allow");
    expect((await can(req("Bash", { command: "npm i" }, false))).behavior).toBe("ask");
  });
});
