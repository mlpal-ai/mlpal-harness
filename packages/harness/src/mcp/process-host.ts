/**
 * The process seam of the stdio MCP transport (P4): where a stdio server's process runs. Without a
 * host a stdio server is a local child (the SDK's StdioClientTransport, unchanged). With one, the
 * host starts the process wherever it lives (the sandbox's `exec/stream` in hosted mode) and this
 * transport frames JSON-RPC over its stdin and stdout exactly as the SDK's does, so the MCP client
 * above it does not change.
 */
import { spawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ExecPolicy } from "../tools/types";

export interface ProcessSpec {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** How a process ended: its exit code when it exited, else null with the host's reason. */
export interface ProcessExit {
  code: number | null;
  reason: string | null;
}

/** One running process. `onExit` fires once, also for a handle that has already exited. */
export interface ProcessHandle {
  write(data: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  kill(): Promise<void>;
  onStdout(cb: (chunk: Uint8Array) => void): void;
  onExit(cb: (exit: ProcessExit) => void): void;
}

export interface ProcessHost {
  spawn(spec: ProcessSpec): Promise<ProcessHandle>;
}

/** What a stdio server inherits when it declares no environment of its own: the SDK's safe set. */
const SAFE_ENV = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

/**
 * A host for stdio servers of a confined run (ruling R21): each is a local child spawned through the run's sandbox
 * wrap, in `cwd`. Its environment is what the SDK's own spawn gives a server (the safe set, here read from the
 * sandbox's scrubbed environment) plus the variables its configuration declares; never the engine's own.
 */
export function localProcessHost(exec: ExecPolicy, cwd: string): ProcessHost {
  return {
    async spawn(spec: ProcessSpec): Promise<ProcessHandle> {
      const base = exec.env();
      const env = { ...Object.fromEntries(SAFE_ENV.flatMap((k) => (base[k] === undefined ? [] : [[k, base[k]]]))), ...spec.env };
      const argv = exec.wrap(spec.argv);
      const child = spawn(argv[0]!, argv.slice(1), { cwd: spec.cwd ?? cwd, env, stdio: ["pipe", "pipe", "ignore"] });
      let exit: ProcessExit | null = null;
      const exitCbs: ((e: ProcessExit) => void)[] = [];
      const end = (e: ProcessExit) => {
        if (exit) return;
        exit = e;
        for (const cb of exitCbs) cb(e);
      };
      child.on("close", (code, signal) => end({ code, reason: code === null ? `signal ${signal}` : null }));
      child.on("error", (e) => end({ code: null, reason: e.message }));
      child.stdin.on("error", () => undefined); // a server that exited: its exit says so
      return {
        write: (data) => new Promise<void>((resolve, reject) => child.stdin.write(data, (e) => (e ? reject(e) : resolve()))),
        closeStdin: async () => void child.stdin.end(),
        kill: async () => void child.kill("SIGTERM"),
        onStdout: (cb) => void child.stdout.on("data", (chunk: Buffer) => cb(chunk)),
        onExit: (cb) => (exit ? cb(exit) : void exitCbs.push(cb)),
      };
    },
  };
}

const describeExit = (e: ProcessExit): string => (e.code !== null ? `process exited (code ${e.code})` : `process ended (${e.reason ?? "unknown"})`);

export class ProcessHostTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private handle: ProcessHandle | null = null;
  private exit: ProcessExit | null = null;
  private closed = false;
  private readonly buffer = new ReadBuffer();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly host: ProcessHost,
    private readonly spec: ProcessSpec,
  ) {}

  async start(): Promise<void> {
    const handle = await this.host.spawn(this.spec);
    this.handle = handle;
    handle.onStdout((chunk) => {
      this.buffer.append(Buffer.from(chunk));
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.buffer.readMessage();
        } catch (e) {
          this.onerror?.(e as Error);
          continue;
        }
        if (message === null) break;
        this.onmessage?.(message);
      }
    });
    handle.onExit((exit) => {
      this.exit = exit;
      this.finish();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.exit) throw new Error(describeExit(this.exit));
    if (!this.handle || this.closed) throw new Error("not connected");
    await this.handle.write(this.encoder.encode(serializeMessage(message)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const handle = this.handle;
    this.finish();
    await handle?.kill().catch(() => undefined);
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
}
