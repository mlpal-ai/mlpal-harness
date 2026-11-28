import { spawn } from "node:child_process";
import { HOME_LIMITS, SYSTEM, type HomeRefreshError } from "@mlpal/harness-protocol";
import { createPolicy } from "../permission/engine";
import { scriptCommand } from "../profile/ui";
import { type ExecPolicy, killProcessGroup, leaseFor } from "../tools/types";

/**
 * W3-1: running one home script (WAVE-3-HOP-SHAPED-HOME §2, "Scripts are author code, like hooks"). A script is the
 * HOP author's code running in the person's workspace, so it takes the path every command of a session takes: the
 * session's ExecPolicy (the OS sandbox's wrap, when one confines, and the environment a command gets, through a lease),
 * `/bin/bash -c` as Bash, hooks and verifiers spawn, in its own process group when the sandbox asks. Before it starts,
 * the HOP's deny rules and the engine's hard denials judge its command line exactly as they judge a Bash call; there is
 * no one to ask, so anything short of an allow-or-run is a refusal (`denied`).
 *
 * Bounded: 10 s of wall time and 256 KiB of stdout, past either the process group is killed. Never throws.
 */

export interface HomeScript {
  /** The block id, for the log. */
  block: string;
  /** Absolute path inside the HOP's directory (the loader checked it). */
  scriptPath: string;
}

export type ScriptOutcome =
  | { ok: true; stdout: string; ms: number; stderrBytes: number; stderrTail: string }
  | { ok: false; error: Exclude<HomeRefreshError, "not_json" | "invalid_block">; detail: string; ms: number; exitCode?: number; stderrBytes: number; stderrTail: string };

export type HomeScriptRunner = (script: HomeScript) => Promise<ScriptOutcome>;

export interface HomeScriptRunnerOptions {
  /** Required: without it a child would inherit the engine's own environment, which no HOP code may see. */
  exec: ExecPolicy;
  /** Where the script runs: the workspace root, as a session's commands. */
  cwd: string;
  /** The session's folders (the hard denials' rm -rf guard reads them). */
  roots?: readonly string[];
  /** The deny rules a session of this HOP enforces (the HOP's, then settings', lockedDenyUnion). */
  deny?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
}

/** What `lint --home` shows the author of a failing script's stderr: its end, at most this. Never logged. */
const STDERR_TAIL = 4 * 1024;

export function createHomeScriptRunner(opts: HomeScriptRunnerOptions): HomeScriptRunner {
  const timeoutMs = opts.timeoutMs ?? HOME_LIMITS.scriptTimeoutMs;
  const maxBytes = opts.maxBytes ?? HOME_LIMITS.scriptOutputBytes;
  // autopilot: the mode default allows, so only the hard denials, the containment routes and the deny rules can refuse
  const policy = createPolicy({ mode: "autopilot", deny: [...(opts.deny ?? [])] });
  return async (script) => {
    const started = Date.now();
    const command = scriptCommand(script.scriptPath);
    const verdict = await policy({ toolName: "Bash", input: { command }, readOnly: true, isEdit: false, principal: SYSTEM, cwd: opts.cwd, ...(opts.roots ? { roots: opts.roots } : {}) });
    if (verdict.behavior !== "allow") {
      return { ok: false, error: "denied", detail: verdict.behavior === "deny" ? verdict.reason : "the HOP's rules would ask, and no one is asked", ms: 0, stderrBytes: 0, stderrTail: "" };
    }
    return spawnScript(command, opts.exec, opts.cwd, timeoutMs, maxBytes, started);
  };
}

function spawnScript(command: string, exec: ExecPolicy, cwd: string, timeoutMs: number, maxBytes: number, started: number): Promise<ScriptOutcome> {
  return new Promise((resolve) => {
    const lease = leaseFor(exec, command);
    const ownGroup = exec.ownGroup === true;
    const argv = exec.wrap(["/bin/bash", "-c", command]);
    let settled = false;
    let killedFor: "timeout" | "output_too_large" | undefined;
    const out: Buffer[] = [];
    let outBytes = 0;
    let errTail = "";
    let errBytes = 0;
    const finish = (o: ScriptOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env: lease.env, stdio: ["ignore", "pipe", "pipe"], ...(ownGroup ? { detached: true } : {}) });
    } catch (e) {
      void lease.release();
      return resolve({ ok: false, error: "not_started", detail: (e as Error).message, ms: Date.now() - started, stderrBytes: 0, stderrTail: "" });
    }
    const kill = (why: "timeout" | "output_too_large") => {
      killedFor ??= why;
      if (ownGroup) killProcessGroup(child.pid);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => kill("timeout"), timeoutMs);
    child.stdout!.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > maxBytes) return kill("output_too_large");
      out.push(d);
    });
    child.stderr!.on("data", (d: Buffer) => {
      errBytes += d.length;
      errTail = (errTail + d.toString()).slice(-STDERR_TAIL);
    });
    child.once("exit", () => killProcessGroup(ownGroup ? child.pid : undefined));
    child.once("error", (e) => {
      void lease.release();
      finish({ ok: false, error: "not_started", detail: e.message, ms: Date.now() - started, stderrBytes: errBytes, stderrTail: errTail });
    });
    child.once("close", (code) => {
      const reverted = lease.release() ?? [];
      const ms = Date.now() - started;
      const base = { ms, stderrBytes: errBytes, stderrTail: errTail };
      if (killedFor === "timeout") return finish({ ok: false, error: "timeout", detail: `ran past ${timeoutMs} ms and was stopped`, ...base });
      if (killedFor === "output_too_large") return finish({ ok: false, error: "output_too_large", detail: `printed over ${maxBytes} bytes and was stopped`, ...base });
      if (reverted.length) return finish({ ok: false, error: "sandbox", detail: `the sandbox removed what it wrote where a command may not write: ${reverted.join(", ")}`, ...base });
      if (code !== 0) return finish({ ok: false, error: "exit_nonzero", detail: `exited with code ${code ?? "none (killed)"}`, ...(code !== null ? { exitCode: code } : {}), ...base });
      finish({ ok: true, stdout: Buffer.concat(out).toString("utf8"), ...base });
    });
  });
}
