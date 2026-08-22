import { spawn } from "node:child_process";
import { FunctionHook } from "../hooks/engine";
import type { Hook } from "../hooks/types";

/**
 * A Stop-hook that runs a verification command (tests, build, lint). Non-zero exit
 * blocks "done" and feeds the failure back so the agent fixes it — turning "I think
 * it works" into "I verified it works." See docs/05 §6.
 */
export interface CommandVerifierOptions {
  command: string;
  name?: string;
  timeoutMs?: number;
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], { cwd });
    let output = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: killed ? 124 : (code ?? 0), output });
    });
  });
}

export function commandVerifier(opts: CommandVerifierOptions): Hook {
  return new FunctionHook(opts.name ?? `verify:${opts.command}`, ["Stop"], async (_input, ctx) => {
    const { code, output } = await runShell(opts.command, ctx.cwd, opts.timeoutMs ?? 120_000);
    if (code === 0) return {};
    const tail = output.length > 2000 ? output.slice(-2000) : output;
    return {
      block: true,
      reason: `Verification \`${opts.command}\` failed (exit ${code}). Fix it before finishing:\n${tail.trim()}`,
    };
  });
}
