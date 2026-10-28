/**
 * The process seam of the stdio MCP transport (P4): where a stdio server's process runs. Without a
 * host a stdio server is a local child (the SDK's StdioClientTransport, unchanged). With one, the
 * host starts the process wherever it lives (the sandbox's `exec/stream` in hosted mode) and this
 * transport frames JSON-RPC over its stdin and stdout exactly as the SDK's does, so the MCP client
 * above it does not change.
 */
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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
