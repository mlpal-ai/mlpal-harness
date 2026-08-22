import { spawn } from "node:child_process";
import { type Logger, silentLogger } from "../obs/logger";
import type { Hook, HookContext, HookEvent, HookInput, HookResult } from "./types";

export class HookEngine {
  private readonly hooks: Hook[] = [];

  constructor(private readonly logger: Logger = silentLogger) {}

  register(hook: Hook): void {
    this.hooks.push(hook);
  }

  has(event: HookEvent): boolean {
    return this.hooks.some((h) => h.events.includes(event));
  }

  /** Run every hook registered for the event, in registration order. A hook that
   *  throws is isolated (logged, treated as a no-op) so one bad hook can't break a run. */
  async run(input: HookInput, ctx: HookContext): Promise<HookResult[]> {
    const matching = this.hooks.filter((h) => h.events.includes(input.event));
    const out: HookResult[] = [];
    for (const hook of matching) {
      try {
        out.push(await hook.run(input, ctx));
      } catch (e) {
        this.logger.error("hook failed", { hook: hook.id, event: input.event, error: String(e) });
      }
    }
    return out;
  }
}

/** In-process hook — used for built-ins and tests. */
export class FunctionHook implements Hook {
  constructor(
    readonly id: string,
    readonly events: readonly HookEvent[],
    private readonly fn: (input: HookInput, ctx: HookContext) => Promise<HookResult> | HookResult,
  ) {}

  async run(input: HookInput, ctx: HookContext): Promise<HookResult> {
    return this.fn(input, ctx);
  }
}

export interface CommandHookOptions {
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Shell hook: the event JSON is written to the command's stdin; a JSON HookResult is
 * read from stdout. Exit code 2 = block (a common hook convention). This is arbitrary
 * code execution by config — the host must gate it off in multi-tenant/hosted mode.
 */
export class CommandHook implements Hook {
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(
    readonly id: string,
    readonly events: readonly HookEvent[],
    private readonly command: string,
    opts: CommandHookOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.logger = opts.logger ?? silentLogger;
  }

  run(input: HookInput, ctx: HookContext): Promise<HookResult> {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", this.command], { cwd: ctx.cwd });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", () => {
        clearTimeout(timer);
        resolve({});
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const parsed = parseHookOutput(stdout);
        // exit code 2 = block; stderr becomes the reason if not provided
        if (code === 2) {
          resolve({ ...parsed, block: true, reason: parsed.reason ?? (stderr.trim() || "blocked by hook") });
        } else {
          resolve(parsed);
        }
      });

      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
  }
}

function parseHookOutput(stdout: string): HookResult {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const o = JSON.parse(trimmed) as HookResult;
    return o && typeof o === "object" ? o : {};
  } catch {
    // non-JSON stdout is treated as injected context (a plain message)
    return { injectContext: trimmed };
  }
}
