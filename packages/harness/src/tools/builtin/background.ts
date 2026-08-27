import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { EventInbox } from "../../events/inbox";
import { commandLabel } from "../../events/inbox";
import { hostEnvName } from "../../host";

/**
 * Background command execution (dev servers, watchers, long builds). Bash with
 * run_in_background starts a task here and returns immediately; BashOutput reads
 * incremental output; Kill stops one. Output is tail-buffered per task. One
 * process-wide registry: ids are sequential ("bg1"…) for easy model reference, and
 * every child is killed when the CLI process exits so nothing leaks.
 *
 * Event delivery is dual-path because the registry is process-wide but consumers are
 * per-session: the main loop attaches an EventInbox (push — can wake a parked loop and
 * feed live UI), scoped to its sessionId so a sub-agent's tasks are never hijacked;
 * everyone else keeps the pull-based drainNotifications(). A task reports through
 * exactly one path (the `exitReported`/`stallReported` flags are shared).
 */
const MAX_BUFFER = 200_000;
/** No output for this long + a prompt-looking tail => the task is probably blocked on input. */
const STALL_MS = 45_000;
const STALL_TAIL = 400;
/** Push-mode stall sweep cadence (pull mode checks lazily at drain time instead). */
const SWEEP_MS = 10_000;

/** Heuristics for "the last line is an interactive prompt awaiting input." */
const PROMPT_PATTERNS: RegExp[] = [
  /\?\s*$/,
  /\[[yY]\/[nN]\]\s*$/,
  /\((?:y(?:es)?\/no?|yes\/no)\)\s*$/i,
  /(?:password|passphrase|username|email|token)\b[^\n]*:\s*$/i,
  /(?:continue|overwrite|proceed|are you sure)\b[^\n]*\??\s*$/i,
  /(?:press\s+(?:enter|any key))\b[^\n]*$/i,
];

/** True when the tail's last non-empty line looks like a prompt waiting for input. */
export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split("\n").pop() ?? "";
  return PROMPT_PATTERNS.some((p) => p.test(lastLine));
}

export interface BgTask {
  id: string;
  command: string;
  /** Absent on adopted tasks (re-attached after a restart) — use `pid` there. */
  child?: ChildProcess;
  output: string;
  /** Read cursor for incremental BashOutput reads. */
  readOffset: number;
  exitCode: number | null;
  startedAt: number;
  /** Wall-clock of the last output byte; drives stall detection. */
  lastOutputAt: number;
  /** Whether the terminal (exit) event has been surfaced to the agent. */
  exitReported: boolean;
  /** Whether a prompt-stall has been surfaced to the agent (one-shot). */
  stallReported: boolean;
  /** Owning session — routes this task's events to that session's inbox when one is attached. */
  sessionId?: string;
  /** Monitor mode: stream output as progress events (debounced) and enforce a deadline. */
  monitor?: boolean;
  /** Hard deadline for monitors — sweep() kills the task and emits an error event past it. */
  timeoutAt?: number;
  /** Debounce handle for monitor progress emission. */
  progressTimer?: ReturnType<typeof setTimeout> | null;
  /** Monotonic progress-event counter (fresh id per emission — coalescing keeps only the latest). */
  progressSeq?: number;
  /** Durable monitors: output file (detached process group writes here, we poll it). */
  outFile?: string;
  /** Read cursor into outFile. */
  filePos?: number;
  /** Output/liveness poll handle (durable + adopted monitors). */
  pollTimer?: ReturnType<typeof setInterval> | null;
  /** Process id — survives in the roster so a restart can re-attach. For adopted tasks
   *  (re-attached after a restart) there is no `child` handle, only this. */
  pid?: number;
  /** Adopted after a restart: liveness is pid-polled and the exit status is unknowable. */
  adopted?: boolean;
}

/** Batch monitor output for this long before emitting one progress event. */
const PROGRESS_DEBOUNCE_MS = 300;
/** Tail length carried on a monitor progress event (a status snapshot, not a delta). */
const PROGRESS_TAIL = 1_500;

/** Exit notification text — shared by the push (inbox) and pull (drain) paths. */
function exitNote(t: BgTask): string {
  const tail = t.output.slice(-STALL_TAIL).trimEnd();
  // An adopted (re-attached) task ran detached from us — its exit status is unknowable.
  const status = t.adopted
    ? "ended (ran detached across a restart; exit status unknown)"
    : t.exitCode === 0
      ? "finished"
      : `failed (exit ${t.exitCode})`;
  return (
    `Shell ${t.id} (${t.command}) ${status}.` +
    (tail ? ` Last output:\n${tail}\n` : " (no output.) ") +
    `Read full output with BashOutput(id: "${t.id}").`
  );
}

/** Prompt-stall notification text — shared by the push and pull paths. */
function stallNote(t: BgTask, nowMs: number): string {
  const tail = t.output.slice(-STALL_TAIL);
  const secs = Math.round((nowMs - t.lastOutputAt) / 1000);
  return (
    `Shell ${t.id} (${t.command}) has produced no output for ${secs}s and its ` +
    `last line looks like an interactive prompt — it is probably blocked waiting for input.` +
    (tail.trim() ? `\nLast output:\n${tail.trimEnd()}\n` : " ") +
    `Kill it with Kill(id: "${t.id}") and re-run non-interactively (pipe input, ` +
    `e.g. \`echo y | …\`, or pass a --yes/--non-interactive flag).`
  );
}

export class BackgroundTasks {
  private readonly tasks = new Map<string, BgTask>();
  private seq = 0;
  private inbox: EventInbox | null = null;
  private inboxSessionId: string | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** When set, monitors run DURABLE: detached process group + file-backed output, so they
   *  survive a CLI exit and can be re-attached on resume. Unset (tests, embedded) => pipe mode. */
  private monitorOutDir: string | null = null;

  configureMonitors(opts: { outDir: string }): void {
    mkdirSync(opts.outDir, { recursive: true });
    this.monitorOutDir = opts.outDir;
  }

  /**
   * Route events for tasks owned by `sessionId` to `inbox` (push). Starts the stall sweep —
   * pull mode detects stalls lazily at drain time, but a push consumer may never poll.
   */
  attachInbox(inbox: EventInbox, sessionId: string): void {
    this.inbox = inbox;
    this.inboxSessionId = sessionId;
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
      this.sweepTimer.unref?.();
    }
  }

  detachInbox(): void {
    this.inbox = null;
    this.inboxSessionId = undefined;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  start(
    command: string,
    cwd: string,
    sessionId?: string,
    opts?: { monitor?: boolean; timeoutMs?: number },
  ): BgTask {
    const id = opts?.monitor ? `mon${++this.seq}` : `bg${++this.seq}`;
    const now = Date.now();
    const durable = Boolean(opts?.monitor && this.monitorOutDir);
    const outFile = durable ? join(this.monitorOutDir!, `${id}-${now}.log`) : undefined;

    let child: ChildProcess;
    if (durable) {
      // Durable monitor: its own process group (survives our exit), output to a file we poll,
      // and a self-timeout guard INSIDE the shell — so even orphaned, its life is bounded.
      // The command rides in an env var (eval "$YODEX_MONITOR_CMD") to dodge quoting entirely.
      const timeoutS = Math.max(1, Math.round((opts?.timeoutMs ?? 600_000) / 1000));
      const fd = openSync(outFile!, "a");
      child = spawn(
        "/bin/bash",
        ["-c", `( sleep ${timeoutS} && kill -TERM -$$ ) 2>/dev/null & eval "$${hostEnvName("MONITOR_CMD")}"`],
        {
          cwd,
          detached: true,
          stdio: ["ignore", fd, fd],
          env: { ...process.env, [hostEnvName("MONITOR_CMD")]: command },
        },
      );
      closeSync(fd); // the child holds its own copy
      child.unref();
    } else {
      child = spawn("/bin/bash", ["-c", command], { cwd });
    }

    const task: BgTask = {
      id,
      command,
      child,
      output: "",
      readOffset: 0,
      exitCode: null,
      startedAt: now,
      lastOutputAt: now,
      exitReported: false,
      stallReported: false,
      sessionId,
      monitor: opts?.monitor,
      timeoutAt: opts?.timeoutMs ? now + opts.timeoutMs : undefined,
      progressTimer: null,
      progressSeq: 0,
      outFile,
      filePos: 0,
      pollTimer: null,
      pid: child.pid,
    };
    const append = (d: Buffer) => {
      this.appendOutput(task, d.toString());
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      task.output += `\nfailed to spawn: ${e.message}`;
      task.exitCode = 127;
      this.finalize(task);
    });
    child.on("close", (code) => {
      task.exitCode = code ?? 0;
      this.finalize(task);
    });
    if (durable) this.startFilePoll(task);
    this.tasks.set(id, task);
    return task;
  }

  /**
   * Adopt an already-running child — a foreground Bash call that hit its timeout. Instead of
   * killing work mid-flight or orphaning it silently, the process becomes a normal background
   * task: BashOutput reads it, Kill stops it, and the inbox gets its terminal event. The
   * model has already seen `outputSoFar` in the tool result, so reads start past it.
   */
  adoptChild(
    child: ChildProcess,
    command: string,
    sessionId: string | undefined,
    outputSoFar: string,
    startedAt: number,
  ): BgTask {
    const id = `bg${++this.seq}`;
    const task: BgTask = {
      id,
      command,
      child,
      output: outputSoFar,
      readOffset: outputSoFar.length,
      exitCode: null,
      startedAt,
      lastOutputAt: Date.now(),
      exitReported: false,
      stallReported: false,
      sessionId,
      monitor: false,
      timeoutAt: undefined,
      progressTimer: null,
      progressSeq: 0,
      outFile: undefined,
      filePos: 0,
      pollTimer: null,
      pid: child.pid,
    };
    const append = (d: Buffer) => {
      this.appendOutput(task, d.toString());
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (e) => {
      task.output += `\nfailed: ${e.message}`;
      task.exitCode = 127;
      this.finalize(task);
    });
    child.on("close", (code) => {
      task.exitCode = code ?? 0;
      this.finalize(task);
    });
    this.tasks.set(id, task);
    return task;
  }

  /**
   * Re-attach a durable monitor from a previous process (found alive in the persisted roster).
   * No child handle exists — liveness is pid-polled, output keeps flowing from its file, and
   * the timeout keeps being enforced. The id keeps its original name; `seq` is bumped past it
   * so new tasks can't collide.
   */
  adopt(ref: {
    id: string;
    command: string;
    sessionId: string;
    pid: number;
    outFile: string;
    filePos?: number;
    startedAt?: number;
    timeoutAt?: number;
  }): BgTask {
    const n = Number(/\d+$/.exec(ref.id)?.[0] ?? 0);
    if (n > this.seq) this.seq = n;
    const task: BgTask = {
      id: ref.id,
      command: ref.command,
      output: "",
      readOffset: 0,
      exitCode: null,
      startedAt: ref.startedAt ?? Date.now(),
      lastOutputAt: Date.now(),
      exitReported: false,
      stallReported: false,
      sessionId: ref.sessionId,
      monitor: true,
      adopted: true,
      timeoutAt: ref.timeoutAt,
      progressTimer: null,
      progressSeq: 0,
      outFile: ref.outFile,
      filePos: ref.filePos ?? 0,
      pollTimer: null,
      pid: ref.pid,
    };
    this.startFilePoll(task);
    this.tasks.set(task.id, task);
    return task;
  }

  private appendOutput(t: BgTask, text: string): void {
    if (!text) return;
    t.output += text;
    t.lastOutputAt = Date.now();
    if (t.output.length > MAX_BUFFER) {
      const drop = t.output.length - MAX_BUFFER;
      t.output = t.output.slice(drop);
      t.readOffset = Math.max(0, t.readOffset - drop);
    }
    if (t.monitor) this.scheduleProgress(t);
  }

  /** Durable/adopted monitors: poll the output file for new bytes; adopted ones also poll the
   *  pid for liveness (no child handle → no 'close' event to rely on). */
  private startFilePoll(t: BgTask): void {
    t.pollTimer = setInterval(() => {
      this.drainFile(t);
      if (t.adopted && t.pid !== undefined && t.exitCode === null && !isAlive(t.pid)) {
        t.exitCode = 0; // unknowable — exitNote() reports "exit status unknown" via `adopted`
        this.finalize(t);
      }
    }, 500);
    t.pollTimer.unref?.();
  }

  /** Read any new bytes from the task's output file into its in-memory buffer. */
  private drainFile(t: BgTask): void {
    if (!t.outFile) return;
    try {
      const size = statSync(t.outFile).size;
      if (size <= (t.filePos ?? 0)) return;
      const fd = openSync(t.outFile, "r");
      try {
        const len = size - (t.filePos ?? 0);
        const buf = Buffer.alloc(Math.min(len, MAX_BUFFER));
        const read = readSync(fd, buf, 0, buf.length, t.filePos ?? 0);
        t.filePos = (t.filePos ?? 0) + read;
        this.appendOutput(t, buf.subarray(0, read).toString());
      } finally {
        closeSync(fd);
      }
    } catch {
      /* file vanished or unreadable — the liveness poll / close handler settles the task */
    }
  }

  /** Terminal path for every task: stop timers, flush file output, report, tidy the file. */
  private finalize(t: BgTask): void {
    if (t.progressTimer) {
      clearTimeout(t.progressTimer);
      t.progressTimer = null;
    }
    if (t.pollTimer) {
      clearInterval(t.pollTimer);
      t.pollTimer = null;
    }
    this.drainFile(t); // pick up the final bytes the poll hasn't seen yet
    this.pushExit(t);
    if (t.outFile) {
      try {
        unlinkSync(t.outFile); // the in-memory buffer serves BashOutput from here on
      } catch {
        /* already gone */
      }
    }
  }

  /** Monitor progress: debounce output bursts into one event carrying the latest tail.
   *  Fresh id per emission — inbox coalescing keeps only the newest pending snapshot. */
  private scheduleProgress(t: BgTask): void {
    if (!this.routes(t) || t.progressTimer || t.exitCode !== null) return;
    t.progressTimer = setTimeout(() => {
      t.progressTimer = null;
      if (t.exitCode !== null || !this.routes(t)) return; // exit event carries the final tail
      this.inbox!.emit({
        id: `${t.id}#p${++t.progressSeq!}`,
        source: t.id,
        sourceType: "monitor",
        kind: "progress",
        label: commandLabel(t.command),
        body: t.output.slice(-PROGRESS_TAIL).trimEnd(),
        ts: Date.now(),
      });
    }, PROGRESS_DEBOUNCE_MS);
    t.progressTimer.unref?.();
  }

  /** Push path: emit the exit event to the owning session's inbox and claim the report. */
  private pushExit(t: BgTask): void {
    if (!this.routes(t) || t.exitReported) return;
    t.exitReported = true;
    this.inbox!.emit({
      id: `${t.id}#exit`,
      source: t.id,
      sourceType: t.monitor ? "monitor" : "shell",
      kind: t.exitCode === 0 ? "complete" : "error",
      label: commandLabel(t.command),
      body: exitNote(t),
      ts: Date.now(),
    });
  }

  /** Push path: periodic sweep — monitor deadlines and prompt-stall detection (one-shot per
   *  task, like the pull path). A timed-out monitor is killed and reports an error event. */
  private sweep(nowMs: number = Date.now()): void {
    for (const t of this.tasks.values()) {
      if (t.exitCode !== null) continue;
      if (t.monitor) {
        if (this.routes(t) && t.timeoutAt !== undefined && nowMs >= t.timeoutAt && !t.exitReported) {
          t.exitReported = true; // claim before kill so the close handler doesn't double-report
          this.inbox!.emit({
            id: `${t.id}#timeout`,
            source: t.id,
            sourceType: "monitor",
            kind: "error",
            label: commandLabel(t.command),
            body:
              `Monitor ${t.id} (${t.command}) hit its ${Math.round((t.timeoutAt - t.startedAt) / 1000)}s timeout and was killed.` +
              (t.output.trim() ? `\nLast output:\n${t.output.slice(-STALL_TAIL).trimEnd()}` : ""),
            ts: nowMs,
          });
          this.kill(t.id);
        }
        continue; // monitors are expected to be quiet between polls — no prompt-stall check
      }
      if (!this.routes(t) || t.stallReported) continue;
      if (nowMs - t.lastOutputAt >= STALL_MS && looksLikePrompt(t.output.slice(-STALL_TAIL))) {
        t.stallReported = true;
        this.inbox!.emit({
          id: `${t.id}#stall`,
          source: t.id,
          sourceType: "shell",
          kind: "progress",
          label: commandLabel(t.command),
          body: stallNote(t, nowMs),
          ts: nowMs,
        });
      }
    }
  }

  private routes(t: BgTask): boolean {
    return this.inbox !== null && t.sessionId !== undefined && t.sessionId === this.inboxSessionId;
  }

  get(id: string): BgTask | undefined {
    return this.tasks.get(id);
  }

  /** Live tasks owned by a session — the loop's "is background work still running" check. */
  liveCount(sessionId?: string): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.exitCode === null && (sessionId === undefined || t.sessionId === sessionId)) n++;
    }
    return n;
  }

  /** Live monitors for a session — backpressure for the Monitor tool's concurrency cap. */
  liveMonitorCount(sessionId?: string): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.monitor && t.exitCode === null && (sessionId === undefined || t.sessionId === sessionId)) n++;
    }
    return n;
  }

  /**
   * Pull path: surface background tasks that need the agent's attention — ones that have
   * exited (finished/failed) or that appear stuck on an interactive prompt — as one-shot
   * notification strings. Tasks routed to an inbox are skipped (already pushed there).
   */
  drainNotifications(nowMs: number = Date.now()): string[] {
    const notes: string[] = [];
    for (const t of this.tasks.values()) {
      if (this.routes(t)) continue;
      if (t.exitCode !== null) {
        if (t.exitReported) continue;
        t.exitReported = true;
        notes.push(`[background] ${exitNote(t)}`);
      } else if (!t.stallReported && nowMs - t.lastOutputAt >= STALL_MS) {
        if (looksLikePrompt(t.output.slice(-STALL_TAIL))) {
          t.stallReported = true;
          notes.push(`[background] ${stallNote(t, nowMs)}`);
        }
      }
    }
    return notes;
  }

  list(): BgTask[] {
    return [...this.tasks.values()];
  }

  kill(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.exitCode !== null) return false;
    if (task.outFile && task.pid !== undefined) {
      // Durable monitor: it's a detached process GROUP — kill the group so its children die too.
      const pid = task.pid;
      signalGroup(pid, "SIGTERM");
      setTimeout(() => {
        if (task.exitCode === null) signalGroup(pid, "SIGKILL");
      }, 2000).unref?.();
      return true;
    }
    task.child?.kill("SIGTERM");
    setTimeout(() => {
      if (task.exitCode === null) task.child?.kill("SIGKILL");
    }, 2000).unref?.();
    return true;
  }

  killAll(): void {
    for (const t of this.tasks.values()) {
      if (t.exitCode !== null) continue;
      // Durable monitors outlive us BY DESIGN: they re-attach on the next resume, and their
      // in-shell timeout guard bounds their life even if no yodex ever comes back.
      if (t.outFile) continue;
      t.child?.kill("SIGKILL");
    }
  }
}

/** True when a process with this pid exists (signal 0 probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal a detached task's process group; falls back to the single pid if the group is gone. */
function signalGroup(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already dead */
    }
  }
}

export const backgroundTasks = new BackgroundTasks();

// Children are not detached, but they'd still outlive us — reap them on exit.
process.on("exit", () => backgroundTasks.killAll());
