import { spawn } from "node:child_process";
import { isDir } from "../tools/shell-cwd";
import { FunctionHook } from "../hooks/engine";
import type { Hook } from "../hooks/types";
import { type ExecPolicy, killProcessGroup, leaseFor, revertedNotice } from "../tools/types";

/**
 * A Stop-hook that runs a verification command (tests, build, lint). Non-zero exit
 * blocks "done" and feeds the failure back so the agent fixes it — turning "I think
 * it works" into "I verified it works." See docs/05 §6.
 */
export interface CommandVerifierOptions {
  command: string;
  name?: string;
  timeoutMs?: number;
  /** Ruling R21: the run's sandbox. The command (tests, a build: code the agent wrote) runs through its wrap with
   *  its scrubbed environment. Absent = a plain `/bin/bash -c` with the engine's environment. */
  exec?: ExecPolicy;
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  exec: ExecPolicy | undefined,
): Promise<{ code: number; output: string }> {
  // Never in another folder: a verifier proves the session's folder, not its parent.
  if (!isDir(cwd)) return Promise.resolve({ code: 127, output: `the working folder ${cwd} no longer exists` });
  return new Promise((resolve) => {
    const argv = exec ? exec.wrap(["/bin/bash", "-c", command]) : ["/bin/bash", "-c", command];
    const lease = exec ? leaseFor(exec, command) : undefined;
    const ownGroup = exec?.ownGroup === true;
    const child = spawn(argv[0]!, argv.slice(1), { cwd, ...(ownGroup ? { detached: true } : {}), ...(lease ? { env: lease.env } : {}) });
    child.once("exit", () => killProcessGroup(ownGroup ? child.pid : undefined));
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
      void lease?.release();
      resolve({ code: 127, output: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // R22d: what the command created where a sandboxed session may not write was removed; it counts as failed
      const reverted = lease?.release() ?? [];
      if (reverted.length) output += `\n${revertedNotice(reverted)}`;
      resolve({ code: killed ? 124 : reverted.length && !code ? 1 : (code ?? 0), output });
    });
  });
}

export function commandVerifier(opts: CommandVerifierOptions): Hook {
  return new FunctionHook(opts.name ?? `verify:${opts.command}`, ["Stop"], async (_input, ctx) => {
    const { code, output } = await runShell(opts.command, ctx.cwd, opts.timeoutMs ?? 120_000, opts.exec);
    if (code === 0) return {};
    const tail = output.length > 2000 ? output.slice(-2000) : output;
    return {
      block: true,
      reason: `Verification \`${opts.command}\` failed (exit ${code}). Fix it before finishing:\n${tail.trim()}`,
    };
  });
}
