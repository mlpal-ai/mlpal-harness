import { spawn } from "node:child_process";
import { z } from "zod";
import { backgroundTasks } from "./background";
import { backgroundAgents } from "../../subagent/background";
import { defineTool, err, ok, type ToolContext } from "../types";

const MAX_TIMEOUT = 600_000;
const DEFAULT_TIMEOUT = 120_000;
const MAX_OUTPUT = 200_000;

/**
 * Shell prelude: give raw `grep` default directory exclusions for RECURSIVE searches. This is
 * NOT an alias to a different tool — it's the real grep binary (same flags, same regex dialect,
 * same exit codes; --exclude-dir is a no-op for non-recursive use), so nothing the model knows
 * about grep breaks. It closes the one measured pathology of raw shell search: an unbounded
 * `grep -r` over a monorepo wandering into .venv/node_modules cost a real run 90s. Deliberately
 * NOT aliasing to ripgrep (rg's -r means --replace — a semantic landmine) and NOT touching
 * `find` (it has no safe default-exclusion injection). Escape hatch: `command grep` (or an
 * explicit path into an excluded dir — the excludes match directories *traversed*, not named).
 */
const HEAVY_DIRS = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
];
const SHELL_PRELUDE = `grep() { command grep ${HEAVY_DIRS.map((d) => `--exclude-dir=${d}`).join(" ")} "$@"; }
export -f grep >/dev/null 2>&1 || true
`;

function run(
  command: string,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<{ output: string; code: number; adoptedAs?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("/bin/bash", ["-c", SHELL_PRELUDE + command], { cwd: ctx.cwd });
    let output = "";
    let killedByTimeout = false;
    let settled = false;

    const append = (d: Buffer) => {
      if (output.length < MAX_OUTPUT) output += d.toString();
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    // Timeout policy: work is never killed blindly. The still-running process is ADOPTED as
    // a background task — observable (BashOutput), stoppable (Kill), and its completion
    // fires an inbox event — while the tool returns what it has, so the model can decide:
    // wait for the event, or investigate why a "quick" command blew its budget.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ctx.signal?.removeEventListener("abort", onAbort);
      child.stdout.removeListener("data", append);
      child.stderr.removeListener("data", append);
      const task = backgroundTasks.adoptChild(child, command, ctx.sessionId, output, started);
      const secs = Math.round(timeoutMs / 1000);
      resolve({
        output:
          `${output.trim() ? `${output}\n` : ""}[still running after ${secs}s — adopted as background task ${task.id}. ` +
          `You'll get an event when it finishes; BashOutput("${task.id}") reads it, Kill("${task.id}") stops it. ` +
          `If this command should have been quick, investigate the hang instead of waiting.]`,
        code: 0,
        adoptedAs: task.id,
      });
    }, timeoutMs);

    const onAbort = () => child.kill("SIGKILL");
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      child.stdout.removeListener("data", append);
      child.stderr.removeListener("data", append);
      let out = output;
      if (out.length >= MAX_OUTPUT) out += "\n[output truncated]";
      if (killedByTimeout) out += `\n[timed out after ${timeoutMs}ms]`;
      resolve({ output: out, code: code ?? 0 });
    };
    child.on("error", (e) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ output: `failed to spawn: ${e.message}`, code: 127 });
      }
    });
    // `close` = process exited AND stdio flushed — the clean path.
    child.on("close", (code) => finalize(code));
    // `exit` alone can hang forever on `close`: a backgrounded grandchild (`server &`)
    // inherits the pipes and holds them open long after bash exits. Give the streams a
    // short flush grace after exit, then finalize with what we have — the tool reports
    // the COMMAND's result; a still-running orphan is the user's `&`, not our wait.
    child.on("exit", (code) => {
      setTimeout(() => finalize(code), 250);
    });
  });
}

export const bashTool = defineTool({
  name: "Bash",
  description:
    "Execute a shell command via bash in the working directory. Returns combined stdout+stderr. Set run_in_background for long-lived commands (dev servers, watchers): returns a task id immediately; read output later with BashOutput and stop it with Kill. A foreground command that outlives its timeout (default 120s, max 600s) is not killed — it is adopted as a background task and you get an event when it finishes; investigate instead of re-running if it should have been quick.",
  readOnly: false,
  executes: true,
  schema: z.object({
    command: z.string(),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT)
      .optional()
      .describe(`timeout in ms (default ${DEFAULT_TIMEOUT})`),
    run_in_background: z
      .boolean()
      .optional()
      .describe("start the command as a background task and return its id immediately"),
  }),
  async call(input, ctx) {
    if (input.run_in_background) {
      const task = backgroundTasks.start(input.command, ctx.cwd, ctx.sessionId);
      return ok(
        `Started background task ${task.id}. You'll be notified when it finishes or if it looks ` +
          `stuck on a prompt; you can also read output anytime with BashOutput(id: "${task.id}").`,
      );
    }
    const { output, code } = await run(input.command, ctx, input.timeout ?? DEFAULT_TIMEOUT);
    const body = output.trim() || "(no output)";
    return {
      content: code === 0 ? body : `[exit ${code}]\n${body}`,
      isError: code !== 0,
    };
  },
});

export const bashOutputTool = defineTool({
  name: "BashOutput",
  description:
    "Read new output from a background task started by Bash(run_in_background). Returns output since the last read plus the task's status. Call again later for more.",
  readOnly: true,
  schema: z.object({
    id: z.string().describe('shell id from Bash, e.g. "bg1"'),
  }),
  async call(input) {
    const task = backgroundTasks.get(input.id);
    if (!task) return err(`no background shell "${input.id}"`);
    const fresh = task.output.slice(task.readOffset);
    task.readOffset = task.output.length;
    const status =
      task.exitCode === null
        ? `running (${Math.round((Date.now() - task.startedAt) / 1000)}s)`
        : `exited with code ${task.exitCode}`;
    return ok(`[${task.id} ${status}] ${task.command}\n${fresh.trim() || "(no new output)"}`);
  },
});

/** Backpressure: a runaway loop must not fan out unbounded watcher processes. The default
 *  matches settings `background.maxMonitors`; the CLI overrides it from the loaded settings. */
let maxMonitors = 8;
export function setMonitorLimit(n: number): void {
  maxMonitors = n;
}
const MONITOR_DEFAULT_TIMEOUT_S = 600;
const MONITOR_MAX_TIMEOUT_S = 3_600;

export const monitorTool = defineTool({
  name: "Monitor",
  description:
    "Watch something long-running WITHOUT blocking: starts a detached shell script and returns its id immediately so you can keep working. The script's output streams back to you automatically as events (batched), and you're notified when it exits or times out — do NOT poll for it; you can also read output anytime with BashOutput or stop it with Kill. Write the script to emit output only when something noteworthy happens (e.g. a check-loop that echoes on state changes: `for i in $(seq 1 60); do check && { echo done; break; }; sleep 10; done`).",
  readOnly: false,
  schema: z.object({
    command: z.string().describe("shell script to run detached; its output becomes your events"),
    timeout_s: z
      .number()
      .int()
      .min(1)
      .max(MONITOR_MAX_TIMEOUT_S)
      .optional()
      .describe(`kill the monitor after this many seconds (default ${MONITOR_DEFAULT_TIMEOUT_S})`),
  }),
  async call(input, ctx) {
    const live = backgroundTasks.liveMonitorCount(ctx.sessionId);
    if (live >= maxMonitors) {
      return err(
        `Monitor limit reached (${live}/${maxMonitors} running). Kill one with Kill or fold this check into an existing monitor.`,
      );
    }
    const timeoutMs = (input.timeout_s ?? MONITOR_DEFAULT_TIMEOUT_S) * 1000;
    const task = backgroundTasks.start(input.command, ctx.cwd, ctx.sessionId, {
      monitor: true,
      timeoutMs,
    });
    return ok(
      `Started monitor ${task.id} (timeout ${Math.round(timeoutMs / 1000)}s). Its output will reach you as events — keep working; do not poll or wait for it.`,
    );
  },
});

export const killTool = defineTool({
  name: "Kill",
  description:
    'Stop background work by id — a shell from Bash(run_in_background) (e.g. "bg1"), a monitor ("mon1"), or a sub-agent from Agent(run_in_background) (e.g. "agent1").',
  readOnly: false,
  schema: z.object({
    id: z.string(),
  }),
  async call(input) {
    const shell = backgroundTasks.get(input.id);
    if (shell) {
      if (shell.exitCode !== null) return ok(`${shell.id} had already exited with code ${shell.exitCode}`);
      backgroundTasks.kill(input.id);
      return ok(`sent SIGTERM to ${shell.id} (${shell.command})`);
    }
    const agent = backgroundAgents.get(input.id);
    if (agent) {
      if (agent.status !== "running") return ok(`${agent.id} had already ${agent.status}`);
      backgroundAgents.kill(input.id);
      return ok(`cancelled ${agent.id} ("${agent.description}")`);
    }
    return err(`no background work with id "${input.id}"`);
  },
});
