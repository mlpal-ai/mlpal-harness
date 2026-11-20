import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CommandHook } from "../src/hooks/engine";
import { LspManager } from "../src/lsp/manager";
import { McpManager } from "../src/mcp/manager";
import { localProcessHost } from "../src/mcp/process-host";
import { createSandbox } from "../src/sandbox";
import { resolveSandboxSpec } from "../src/sandbox/spec";
import { ToolRegistry } from "../src/tools/registry";
import type { ExecPolicy } from "../src/tools/types";
import { commandVerifier } from "../src/verifiers/command";

// Ruling R21 (harness-e2e E-54, E-55): in a confined run every process the engine starts on the agent's behalf runs
// under the run's sandbox and its scrubbed environment: a language server, a command verifier, a local command hook,
// a stdio MCP server. Each takes the run's ExecPolicy (what Bash spawns through); without one it spawns as before.

const LSP_SERVER = join(import.meta.dir, "fixtures", "fake-lsp-server.mjs");
const MCP_SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.mjs");
const ctx = { sessionId: "s", agentId: "a", cwd: tmpdir() };
let root: string;

beforeAll(() => {
  root = join(tmpdir(), `yodex-r21-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "package.json"), "{}");
  writeFileSync(join(root, "pkg", "thing.ts"), "class Thing {}\n");
  process.env.R21_SECRET = "the-engine-key";
});
afterAll(() => {
  delete process.env.R21_SECRET;
  rmSync(root, { recursive: true, force: true });
});

/** A stand-in for the run's sandbox: its wrap records the environment the child was given, then runs the command;
 *  its env is the scrubbed one (no R21_SECRET). */
function recordingExec(): { exec: ExecPolicy; seen: () => Record<string, string> | null; wraps: string[][] } {
  const file = join(root, `env-${crypto.randomUUID().slice(0, 8)}`);
  const wraps: string[][] = [];
  return {
    wraps,
    exec: {
      wrap: (argv) => (wraps.push(argv), ["/bin/sh", "-c", `env > "${file}"; exec "$@"`, "wrap", ...argv]),
      env: () => ({ PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", R21_SCRUBBED: "1" }),
    },
    seen: () => (existsSync(file) ? Object.fromEntries(readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) : null),
  };
}

describe("R21: a language server (E-54)", () => {
  test("with the run's exec it is spawned through the wrap, with the scrubbed environment", async () => {
    const r = recordingExec();
    const lsp = new LspManager({ servers: { typescript: { command: "node", args: [LSP_SERVER] } }, which: () => true, exec: r.exec });
    const res = await lsp.clientFor(join(root, "pkg", "thing.ts"), root);
    expect(res.ok).toBe(true);
    expect(r.wraps).toEqual([["node", LSP_SERVER]]);
    expect(r.seen()).toMatchObject({ R21_SCRUBBED: "1" });
    expect(r.seen()).not.toHaveProperty("R21_SECRET");
    await lsp.closeAll();
  });

  test("without one (an unconfined run) it is spawned as before", async () => {
    const lsp = new LspManager({ servers: { typescript: { command: "node", args: [LSP_SERVER] } }, which: () => true });
    expect((await lsp.clientFor(join(root, "pkg", "thing.ts"), root)).ok).toBe(true);
    await lsp.closeAll();
  });
});

describe("R21: a command verifier and a local command hook (E-55)", () => {
  const sees = 'test "$R21_SCRUBBED" = 1 && test -z "$R21_SECRET"';

  test("the verifier runs through the wrap with the scrubbed environment; without an exec, as before", async () => {
    const r = recordingExec();
    expect(await commandVerifier({ command: sees, exec: r.exec }).run({ event: "Stop" } as never, ctx)).toEqual({});
    expect(r.wraps).toEqual([["/bin/bash", "-c", sees]]);
    expect(await commandVerifier({ command: 'test "$R21_SECRET" = the-engine-key' }).run({ event: "Stop" } as never, ctx)).toEqual({});
  });

  test("the hook runs through the wrap with the scrubbed environment, its stdin and exit code intact; without an exec, as before", async () => {
    const r = recordingExec();
    const hook = new CommandHook("h", ["PreToolUse"], `${sees} || exit 2; cat >/dev/null; echo '{"updatedInput":{"command":"seen"}}'`, { exec: r.exec });
    expect(await hook.run({ event: "PreToolUse" } as never, ctx)).toEqual({ updatedInput: { command: "seen" } });
    expect(r.wraps.length).toBe(1);
    const blocked = new CommandHook("h", ["PreToolUse"], "echo no >&2; exit 2", { exec: r.exec });
    expect(await blocked.run({ event: "PreToolUse" } as never, ctx)).toMatchObject({ block: true, reason: "no" });
    const plain = new CommandHook("h", ["PreToolUse"], 'test "$R21_SECRET" = the-engine-key || exit 2');
    expect(await plain.run({ event: "PreToolUse" } as never, ctx)).toEqual({});
  });

  test.skipIf(process.platform !== "darwin")("under the real sandbox the OS stops what the policy forbids (a read-only run's verifier cannot write)", async () => {
    const dir = join(homedir(), `.yodex-r21-test-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    const sandbox = createSandbox(resolveSandboxSpec({ filesystem: { mode: "readOnly" } }, { roots: [dir] }));
    try {
      const command = `touch "${join(dir, "planted")}"`;
      const confined = await commandVerifier({ command, exec: sandbox }).run({ event: "Stop" } as never, { ...ctx, cwd: dir });
      expect(confined).toMatchObject({ block: true, reason: expect.stringContaining("Operation not permitted") });
      expect(existsSync(join(dir, "planted"))).toBe(false);
      expect(await new CommandHook("h", ["Stop"], `${command} || exit 2`, { exec: sandbox }).run({ event: "Stop" } as never, { ...ctx, cwd: dir })).toMatchObject({ block: true });
      expect(existsSync(join(dir, "planted"))).toBe(false);
      expect(await commandVerifier({ command }).run({ event: "Stop" } as never, { ...ctx, cwd: dir })).toEqual({});
      expect(existsSync(join(dir, "planted"))).toBe(true);
    } finally {
      sandbox.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R21: a stdio MCP server", () => {
  test("localProcessHost spawns through the wrap, with the SDK's safe variables from the scrubbed environment plus the server's declared ones", async () => {
    const r = recordingExec();
    const handle = await localProcessHost(r.exec, root).spawn({ argv: ["cat"], env: { DECLARED: "yes" } });
    const out: string[] = [];
    handle.onStdout((c) => out.push(Buffer.from(c).toString()));
    const exited = new Promise<{ code: number | null }>((resolve) => handle.onExit(resolve));
    await handle.write(new TextEncoder().encode("ping\n"));
    await handle.closeStdin();
    expect((await exited).code).toBe(0);
    expect(out.join("")).toBe("ping\n");
    expect(r.wraps).toEqual([["cat"]]);
    const env = r.seen()!;
    expect(env).toMatchObject({ DECLARED: "yes", PATH: process.env.PATH });
    expect(env).not.toHaveProperty("R21_SECRET");
    expect(env).not.toHaveProperty("R21_SCRUBBED"); // only the safe set crosses, as with the SDK's own spawn
  });

  test("R21a: only a server the host says is defined in the workspace starts through the stdio host; the person's own starts as before", async () => {
    const r = recordingExec();
    const mcp = new McpManager();
    mcp.setStdioHost(localProcessHost(r.exec, root), (server) => server === "project");
    try {
      // the person's server (user-level config): the SDK's plain child, never the sandbox
      expect(await mcp.connectAll({ mine: { command: "node", args: [MCP_SERVER] } }, new ToolRegistry())).toMatchObject({ connected: 1, tools: 1 });
      expect(r.wraps).toEqual([]);
      // a server the workspace defines: through the sandbox
      expect(await mcp.connectAll({ project: { command: "node", args: [MCP_SERVER] } }, new ToolRegistry())).toMatchObject({ connected: 2 });
      expect(r.wraps).toEqual([["node", MCP_SERVER]]);
    } finally {
      await mcp.close();
    }
    const plain = new McpManager();
    try {
      expect(await plain.connectAll({ project: { command: "node", args: [MCP_SERVER] } }, new ToolRegistry())).toMatchObject({ connected: 1 });
    } finally {
      await plain.close();
    }
  });

  test("R21b: in a confined run the person's server starts in its config's directory, told where the workspace is; unset, where the engine is", async () => {
    const configDir = join(root, "person-config");
    mkdirSync(configDir, { recursive: true });
    const seen = join(root, `mcp-cwd-${crypto.randomUUID().slice(0, 6)}`);
    // the server records where it was started and what it was told, then serves
    const config = { command: "/bin/sh", args: ["-c", `{ pwd; echo "\${YODEX_WORKSPACE:-unset}"; } > "$0"; exec node "$1"`, seen, MCP_SERVER] };
    const mcp = new McpManager();
    mcp.setStdioHome((server) => (server === "mine" ? { cwd: configDir, env: { YODEX_WORKSPACE: "/the/workspace" } } : undefined));
    try {
      expect(await mcp.connectAll({ mine: config }, new ToolRegistry())).toMatchObject({ connected: 1, tools: 1 });
      expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual([realpathSync(configDir), "/the/workspace"]);
    } finally {
      await mcp.close();
    }
    const plain = new McpManager();
    try {
      expect(await plain.connectAll({ mine: config }, new ToolRegistry())).toMatchObject({ connected: 1 });
      expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual([realpathSync(process.cwd()), "unset"]);
    } finally {
      await plain.close();
    }
  });

  test("a host that cannot confine starts nothing: the connect fails with its reason", async () => {
    const mcp = new McpManager();
    mcp.setStdioHost({ spawn: async () => Promise.reject(new Error("not started: nothing here can confine it")) }, (server) => server === "project");
    try {
      expect(await mcp.connectAll({ project: { command: "node", args: [MCP_SERVER] }, mine: { command: "node", args: [MCP_SERVER] } }, new ToolRegistry())).toMatchObject({ connected: 1 });
      expect(mcp.status().map((x) => [x.server, x.ok]).sort()).toEqual([["mine", true], ["project", false]]);
    } finally {
      await mcp.close();
    }
  });
});
