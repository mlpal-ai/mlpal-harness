import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HookContext } from "../src/hooks/types";
import { LocalStore } from "../src/store/local";
import { agentVerifier, commandVerifier } from "../src/verifiers";

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

  test("passes on VERDICT: PASS", async () => {
    const h = agentVerifier(verifierReturning("all good.\nVERDICT: PASS"));
    expect(await h.run({ event: "Stop", numTurns: 1 }, ctx)).toEqual({});
  });

  test("fails open on PARTIAL and on an unparseable verdict", async () => {
    const partial = agentVerifier(verifierReturning("no framework.\nVERDICT: PARTIAL"));
    expect(await partial.run({ event: "Stop", numTurns: 1 }, ctx)).toEqual({});
    const garbage = agentVerifier(verifierReturning("I could not decide."));
    expect(await garbage.run({ event: "Stop", numTurns: 1 }, ctx)).toEqual({});
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
