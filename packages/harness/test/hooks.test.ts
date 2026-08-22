import { describe, expect, test } from "bun:test";
import { CommandHook, FunctionHook, HookEngine } from "../src/hooks/engine";
import type { HookContext } from "../src/hooks/types";

const ctx: HookContext = { sessionId: "s1", agentId: "a1", cwd: process.cwd() };

describe("HookEngine + FunctionHook", () => {
  test("runs only hooks registered for the event, in order", async () => {
    const engine = new HookEngine();
    const calls: string[] = [];
    engine.register(
      new FunctionHook("h1", ["PreToolUse"], () => {
        calls.push("h1");
        return {};
      }),
    );
    engine.register(
      new FunctionHook("h2", ["Stop"], () => {
        calls.push("h2");
        return {};
      }),
    );
    engine.register(
      new FunctionHook("h3", ["PreToolUse"], () => {
        calls.push("h3");
        return {};
      }),
    );
    await engine.run({ event: "PreToolUse", toolName: "Bash", input: {} }, ctx);
    expect(calls).toEqual(["h1", "h3"]);
    expect(engine.has("Stop")).toBe(true);
    expect(engine.has("PostToolUse")).toBe(false);
  });

  test("a block decision is returned", async () => {
    const engine = new HookEngine();
    engine.register(
      new FunctionHook("guard", ["PreToolUse"], (input) => {
        if (input.event === "PreToolUse" && input.toolName === "Bash") {
          return { block: true, reason: "no bash" };
        }
        return {};
      }),
    );
    const results = await engine.run({ event: "PreToolUse", toolName: "Bash", input: {} }, ctx);
    expect(results[0]?.block).toBe(true);
    expect(results[0]?.reason).toBe("no bash");
  });

  test("a throwing hook is isolated, not fatal", async () => {
    const engine = new HookEngine();
    engine.register(
      new FunctionHook("bad", ["Stop"], () => {
        throw new Error("boom");
      }),
    );
    engine.register(new FunctionHook("good", ["Stop"], () => ({ injectContext: "ok" })));
    const results = await engine.run({ event: "Stop", numTurns: 1 }, ctx);
    expect(results).toHaveLength(1); // bad isolated, good ran
    expect(results[0]?.injectContext).toBe("ok");
  });
});

describe("CommandHook", () => {
  test("exit code 2 blocks with stderr as the reason", async () => {
    const hook = new CommandHook("block", ["PreToolUse"], 'echo "denied" >&2; exit 2');
    const r = await hook.run({ event: "PreToolUse", toolName: "Bash", input: {} }, ctx);
    expect(r.block).toBe(true);
    expect(r.reason).toContain("denied");
  });

  test("JSON stdout is parsed as a HookResult", async () => {
    const hook = new CommandHook("mutate", ["PreToolUse"], `echo '{"updatedInput":{"command":"ls -la"}}'`);
    const r = await hook.run({ event: "PreToolUse", toolName: "Bash", input: {} }, ctx);
    expect(r.updatedInput).toEqual({ command: "ls -la" });
  });

  test("non-JSON stdout becomes injected context", async () => {
    const hook = new CommandHook("note", ["PostToolUse"], 'echo "a plain note"');
    const r = await hook.run(
      { event: "PostToolUse", toolName: "Read", input: {}, result: "x", isError: false },
      ctx,
    );
    expect(r.injectContext).toBe("a plain note");
  });

  test("receives the event payload on stdin", async () => {
    const hook = new CommandHook(
      "echo-input",
      ["PreToolUse"],
      `cat | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps({'injectContext': d['toolName']}))"`,
    );
    const r = await hook.run({ event: "PreToolUse", toolName: "Grep", input: {} }, ctx);
    expect(r.injectContext).toBe("Grep");
  });
});
