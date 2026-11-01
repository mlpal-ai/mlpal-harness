import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HookContext } from "../src/hooks/types";
import { LocalStore } from "../src/store/local";
import { HUMAN, SYSTEM, emptyUsage } from "@mlpal/harness-protocol";
import { agentVerifier, commandVerifier, turnRequest } from "../src/verifiers";

let dir: string;
let ctx: HookContext;
beforeEach(async () => {
  dir = join(tmpdir(), `yodex-verify-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  ctx = { sessionId: "s", agentId: "a", cwd: dir };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("commandVerifier", () => {
  test("passes on exit 0", async () => {
    const h = commandVerifier({ command: "exit 0" });
    expect(await h.run({ event: "Stop", numTurns: 1 }, ctx)).toEqual({});
  });

  test("blocks on failure and surfaces the output", async () => {
    const h = commandVerifier({ command: 'echo "tests failed" >&2; exit 1' });
    const r = await h.run({ event: "Stop", numTurns: 1 }, ctx);
    expect(r.block).toBe(true);
    expect(r.reason).toContain("tests failed");
    expect(r.reason).toContain("exit 1");
  });
});

describe("agentVerifier (adversarial)", () => {
  const verifierReturning = (out: string) => ({
    store: new LocalStore(dir),
    runVerifier: async () => out,
  });

  test("blocks on VERDICT: FAIL and surfaces the findings", async () => {
    const h = agentVerifier(
      verifierReturning("### Check: repro\nCommand run: pytest -k x\nExpected pass, got fail.\nVERDICT: FAIL"),
    );
    const r = await h.run({ event: "Stop", numTurns: 1 }, ctx);
    expect(r.block).toBe(true);
    expect(r.reason).toContain("Expected pass, got fail");
    expect(r.reason).toContain("verification FAILED");
  });

  test("passes on VERDICT: PASS — allows completion, surfaces the verdict for telemetry", async () => {
    const h = agentVerifier(verifierReturning("all good.\nVERDICT: PASS"));
    // No `block` => completion allowed; `verdict` is stamped so the loop can record checks.agent.
    expect(await h.run({ event: "Stop", numTurns: 1 }, ctx)).toEqual({ verdict: "PASS" });
  });

  test("fails open on PARTIAL and on an unparseable verdict", async () => {
    const partial = agentVerifier(verifierReturning("no framework.\nVERDICT: PARTIAL"));
    // Fails open (no block), but the parsed verdict is still surfaced.
    expect(await partial.run({ event: "Stop", numTurns: 1 }, ctx)).toEqual({ verdict: "PARTIAL" });
    const garbage = agentVerifier(verifierReturning("I could not decide."));
    // Unparseable => no verdict to surface, still allowed.
    expect(await garbage.run({ event: "Stop", numTurns: 1 }, ctx)).toEqual({});
  });

  test("runVerifier is told whose finish it gates: the session and its run (E-W2 E6)", async () => {
    const seen: unknown[] = [];
    const h = agentVerifier({
      store: new LocalStore(dir),
      runVerifier: async (_prompt, caller) => {
        seen.push(caller);
        return "VERDICT: PASS";
      },
    });
    await h.run({ event: "Stop", numTurns: 1 }, { ...ctx, runId: "run-7" });
    await h.run({ event: "Stop", numTurns: 1 }, ctx);
    expect(seen).toEqual([{ sessionId: ctx.sessionId, runId: "run-7" }, { sessionId: ctx.sessionId }]);
  });

  test("recursion guard: inert while a verifier is already running", async () => {
    let spawned = 0;
    const h = agentVerifier({
      store: new LocalStore(dir),
      isVerifying: () => true,
      runVerifier: async () => {
        spawned++;
        return "VERDICT: FAIL";
      },
    });
    expect(await h.run({ event: "Stop", numTurns: 1 }, ctx)).toEqual({});
    expect(spawned).toBe(0);
  });
});

describe("D-54: the verifier judges each turn against that turn's own request", () => {
  const user = (text: string, author = HUMAN) => ({ type: "user" as const, message: { role: "user" as const, content: text }, author, ts: "t" });
  const result = { type: "result" as const, subtype: "success" as const, numTurns: 1, usage: emptyUsage(), ts: "t" };
  async function session(store: LocalStore, payloads: unknown[]): Promise<void> {
    let parent: string | null = null;
    for (const p of payloads) parent = (await store.conversation.append("s", p as never, parent)).uuid;
  }

  test("a later turn's request is the task, the opening message only context; the loop's own notes are not requests", async () => {
    const store = new LocalStore(dir);
    await session(store, [
      user("what's running in hop-sandbox?"),
      result,
      user("web is on the wrong image: set it to nginx:1.27-alpine and confirm it rolled out"),
      user("[Verification] Not done yet — keep going.", SYSTEM),
    ]);
    const t = await turnRequest(store, "s");
    expect(t.request).toBe("web is on the wrong image: set it to nginx:1.27-alpine and confirm it rolled out");
    expect(t.context).toBe("what's running in hop-sandbox?");
    // what the verifier is handed: the turn's request first, the opening message marked as context
    let prompt = "";
    const h = agentVerifier({ store, runVerifier: async (p) => ((prompt = p), "VERDICT: PASS"), taskFraming: (task) => `Task: ${task}` });
    await h.run({ event: "Stop", numTurns: 1 }, ctx);
    expect(prompt).toStartWith("Task: web is on the wrong image");
    expect(prompt).toContain("Context only, from earlier in this session; not the request this turn answers: what's running in hop-sandbox?");
  });

  test("a steer within the turn joins its request; a run resuming a parked approval keeps the request that parked", async () => {
    const store = new LocalStore(dir);
    await session(store, [user("status?"), result, user("scale web to 3"), user("and to 4 instead"), { ...result, subtype: "needs_approval" }]);
    expect((await turnRequest(store, "s")).request).toBe("scale web to 3\n\nand to 4 instead");
  });

  test("a single-turn session: the opening message is the request, with no separate context", async () => {
    const store = new LocalStore(dir);
    await session(store, [user("fix the crashloop in web")]);
    expect(await turnRequest(store, "s")).toEqual({ request: "fix the crashloop in web", context: "" });
  });
});
