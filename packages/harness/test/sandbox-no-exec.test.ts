import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { createSandbox, lookupPasswdHome, resolveSandboxSpec } from "../src/sandbox";
import { LocalStore } from "../src/store/local";
import { defaultRegistry } from "../src/tools";

/**
 * Hosted mode's invariant (yodex pod-paths-spy): the engine execs nothing of its own for a session. The real-home
 * lookup behind the sandbox's `~` denials (E-16) runs a command (`id -P`, `getent passwd`), so it runs only when a
 * local sandbox first confines a command, never at engine init or when a sandbox is merely configured.
 */
const PASSWD_COMMANDS = new Set(["/usr/bin/id", "/usr/bin/getent", "/bin/getent"]);

let spawned: string[][] = [];
const real = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
beforeEach(() => {
  spawned = [];
  const record = (args: unknown[]) => {
    const first = args[0] as string[] | { cmd: string[] };
    spawned.push(Array.isArray(first) ? first : first.cmd);
  };
  Bun.spawn = ((...a: unknown[]) => (record(a), (real.spawn as (...x: unknown[]) => unknown)(...a))) as typeof Bun.spawn;
  Bun.spawnSync = ((...a: unknown[]) => (record(a), (real.spawnSync as (...x: unknown[]) => unknown)(...a))) as typeof Bun.spawnSync;
});
afterEach(() => {
  Bun.spawn = real.spawn;
  Bun.spawnSync = real.spawnSync;
});

class Scripted implements ModelClient {
  private i = 0;
  constructor(private readonly scripts: ModelResult[]) {}
  async *stream(_req: ModelRequest): AsyncGenerator<never, ModelResult, void> {
    const r = this.scripts[this.i++];
    if (!r) throw new GatewayError("script exhausted", 500);
    return r;
  }
}
const done: ModelResult = { model: "test", message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" };

describe("no exec without a local sandbox (yodex hosted invariant)", () => {
  let root: string;
  beforeEach(async () => (root = await mkdtemp(join(tmpdir(), "no-exec-"))));
  afterEach(async () => rm(root, { recursive: true, force: true }));

  test("an engine with no local sandbox spawns nothing of its own at init or in a turn", async () => {
    const s = new AgentSession({ agentId: "a", sessionId: "s1", workspace: "w", cwd: root, model: "test", systemPrompt: "t", tools: defaultRegistry(), store: new LocalStore(root), model_client: new Scripted([done]), canUseTool: createPolicy({ mode: "manual" }) });
    for await (const _ of s.run({ text: "hi" })) void _;
    // the one spawn is LocalStore's lock probe (`ps -o lstart=`, next/ws), which a hosted store does not use
    expect(spawned.filter((a) => !(a[0] === "ps" && a[2] === "lstart="))).toEqual([]);
  });

  test("a configured sandbox runs no password lookup until a command needs its denials", () => {
    const spec = resolveSandboxSpec(undefined, { roots: [root], home: join(root, "throwaway") });
    createSandbox(spec, { bwrapPath: null });
    expect(spawned.filter((a) => PASSWD_COMMANDS.has(a[0]!))).toEqual([]);
  });

  test("where the denials are read, the home is still the password database's, whatever $HOME says", () => {
    const passwd = lookupPasswdHome();
    if (!("home" in passwd)) return; // a host with no password entry for this uid (logged and fail-closed elsewhere)
    const spec = resolveSandboxSpec(undefined, { roots: [root], home: join(root, "throwaway") });
    expect(spec.filesystem.unreadable).toContain(join(passwd.home, ".aws"));
    expect(spec.filesystem.unreadable).toContain(join(root, "throwaway", ".aws"));
  });
});
