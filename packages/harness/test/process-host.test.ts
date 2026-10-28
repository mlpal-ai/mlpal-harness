import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { CommandHook } from "../src/hooks/engine";
import { McpManager } from "../src/mcp/manager";
import { type ProcessExit, type ProcessHandle, type ProcessHost, type ProcessSpec, ProcessHostTransport } from "../src/mcp/process-host";
import { runTool, ToolRegistry } from "../src/tools/registry";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.mjs");

/** A ProcessHost that spawns locally and records what it was asked: the seam's contract, without a sandbox. */
function recordingHost(): ProcessHost & { specs: ProcessSpec[]; handles: ProcessHandle[]; writes: number[] } {
  const specs: ProcessSpec[] = [];
  const handles: ProcessHandle[] = [];
  const writes: number[] = [];
  return {
    specs,
    handles,
    writes,
    async spawn(spec) {
      specs.push(spec);
      const [cmd, ...args] = spec.argv;
      const child = spawn(cmd!, args, { env: { PATH: process.env.PATH ?? "", ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"] });
      let exited: ProcessExit | null = null;
      const exitCbs: ((e: ProcessExit) => void)[] = [];
      child.on("exit", (code) => {
        exited = { code, reason: null };
        for (const cb of exitCbs) cb(exited);
      });
      const h: ProcessHandle = {
        async write(data) {
          writes.push(data.length);
          child.stdin.write(data);
        },
        async closeStdin() {
          child.stdin.end();
        },
        async kill() {
          child.kill("SIGKILL");
        },
        onStdout(cb) {
          child.stdout.on("data", (d: Buffer) => cb(new Uint8Array(d)));
        },
        onExit(cb) {
          if (exited) cb(exited);
          else exitCbs.push(cb);
        },
      };
      handles.push(h);
      return h;
    },
  };
}

describe("ProcessHost: the stdio MCP transport's seam (P4)", () => {
  test("a stdio server with a host is spawned through it: the MCP client lists and calls its tools unchanged", async () => {
    const host = recordingHost();
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      const n = await mcp.connect("guest", { command: "node", args: [SERVER], env: { GUEST_VAR: "x" }, host }, reg);
      expect(n).toBeGreaterThan(0);
      expect(host.specs).toEqual([{ argv: ["node", SERVER], env: { GUEST_VAR: "x" } }]);
      expect(host.writes.length).toBeGreaterThan(0);
      const res = await runTool(reg, "mcp__guest__greet", { name: "sandbox" }, { cwd: process.cwd() });
      expect(res).toMatchObject({ isError: false });
      expect(String(res.content)).toContain("Hello, sandbox!");
      expect(mcp.status()).toEqual([{ server: "guest", ok: true, tools: n }]);
    } finally {
      await mcp.close();
    }
  }, 15000);

  test("the process exiting closes the transport; close() kills the process", async () => {
    const host = recordingHost();
    const t = new ProcessHostTransport(host, { argv: ["node", SERVER] });
    let closed = 0;
    t.onclose = () => closed++;
    await t.start();
    await t.close();
    expect(closed).toBe(1);
    // A second close is a no-op: onclose fires once.
    await t.close();
    expect(closed).toBe(1);
  });

  test("a process that exits on its own fires onclose once with the transport unusable", async () => {
    const host = recordingHost();
    const t = new ProcessHostTransport(host, { argv: ["sh", "-c", "exit 3"] });
    const closed = new Promise<void>((r) => (t.onclose = () => r()));
    await t.start();
    await closed;
    await expect(t.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toThrow("process exited (code 3)");
  });

  test("a spawn the host refuses rejects start with its error", async () => {
    const t = new ProcessHostTransport({ spawn: async () => Promise.reject(new Error("workspace attached to sbx_9")) }, { argv: ["x"] });
    await expect(t.start()).rejects.toThrow("workspace attached to sbx_9");
  });

  test("without a host the stdio server is a local child exactly as before", async () => {
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      expect(await mcp.connect("local", { command: "node", args: [SERVER] }, reg)).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  }, 15000);
});

describe("CommandHook with a runner (P4: a hook is one exec in the sandbox)", () => {
  const ctx = { sessionId: "s", agentId: "a", cwd: "/host/path" };

  test("the runner gets the command, the event JSON as stdin and the hook's timeout; stdout JSON is the result", async () => {
    const calls: unknown[] = [];
    const hook = new CommandHook("h", ["PreToolUse"], "check-it", {
      timeoutMs: 1234,
      runner: async (command, o) => {
        calls.push({ command, ...o });
        return { exitCode: 0, stdout: '{"injectContext":"from the guest"}', stderr: "" };
      },
    });
    const input = { event: "PreToolUse" as const, toolName: "Bash", input: { command: "ls" } };
    expect(await hook.run(input, ctx)).toEqual({ injectContext: "from the guest" });
    expect(calls).toEqual([{ command: "check-it", stdin: JSON.stringify(input), timeoutMs: 1234 }]);
  });

  test("exit 2 blocks with stderr as the reason; a runner that throws is a no-op, as a failed spawn is", async () => {
    const block = new CommandHook("b", ["PreToolUse"], "deny", { runner: async () => ({ exitCode: 2, stdout: "", stderr: "denied in the guest\n" }) });
    expect(await block.run({ event: "PreToolUse", toolName: "Bash", input: {} }, ctx)).toEqual({ block: true, reason: "denied in the guest" });
    const broken = new CommandHook("x", ["PreToolUse"], "deny", { runner: async () => Promise.reject(new Error("sandbox gone")) });
    expect(await broken.run({ event: "PreToolUse", toolName: "Bash", input: {} }, ctx)).toEqual({});
  });
});
