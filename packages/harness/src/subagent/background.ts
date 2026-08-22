/**
 * Background sub-agent tasks — the agent analogue of Bash(run_in_background). Task(run_in_background)
 * starts a detached child run here and returns immediately; the main loop keeps working, and the
 * child's result (or failure/cancellation) is surfaced back via drainNotifications at the next step
 * boundary, exactly like a finished background shell. AgentOutput reads an agent's status/result and
 * Kill cancels it.
 *
 * The runner is passed in per task (a closure the host builds from its sub-agent runner), so this
 * registry stays a plain state store with no dependency on how a child is actually spawned.
 *
 * Blast radius: background children run READ-ONLY (enforced by the host — a read-only tool set), so
 * a task researching or verifying in parallel can never race the main agent's edits. Mutation stays
 * on the blocking Task path, where ordering is guaranteed.
 */
import type { EventInbox } from "../events/inbox";

export type TaskStatus = "running" | "done" | "failed" | "cancelled";

export interface BgAgentTask {
  id: string;
  description: string;
  status: TaskStatus;
  /** The child's final text, once it finishes. */
  result?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** Whether the terminal state has been surfaced to the main loop (one-shot). */
  reported: boolean;
  abort: AbortController;
  /** Cumulative output tokens the child has generated — cost visibility in /bg. */
  outputTokens: number;
  /** The model the child was routed to (difficulty gate / agent-def pin). */
  model?: string;
  /** The child's session id — lets the agents panel address its live transcript. */
  sessionId?: string;
  /** Custom agent type, when one was requested (e.g. "code-reviewer"). */
  agent?: string;
  /** The full task prompt — the peek view shows what the child was actually asked. */
  prompt?: string;
  /** Pending mid-run guidance for this child. Drained by the child's loop at its next
   *  tool-step boundary (the loop's drainSteering seam) — how the panel steers an agent. */
  steerQueue: string[];
  /** True for blocking/parallel children (the main loop is waiting on them). They appear
   *  in the panel like any worker but are NOT "background" work: excluded from bg counts,
   *  born `reported` (inline delivery). */
  foreground?: boolean;
}

export class BackgroundAgents {
  private readonly tasks = new Map<string, BgAgentTask>();
  private seq = 0;
  private inbox: EventInbox | null = null;

  /** `progressMinMs` is injectable for tests; production uses the default. */
  constructor(private readonly progressMinMs = 2_000) {}

  /** Push completions to `inbox` instead of the pull-based drainNotifications. The Task tool
   *  only exists on the main loop (children can't recurse), so no per-session routing needed. */
  attachInbox(inbox: EventInbox): void {
    this.inbox = inbox;
  }

  detachInbox(): void {
    this.inbox = null;
  }

  /** Register a FOREGROUND (blocking/parallel) child so the agents panel can see, peek,
   *  steer, and kill it while it runs. Its result returns inline as the tool_result, so the
   *  record is born `reported` — the inbox/drain paths must never double-deliver it. The
   *  caller completes the record itself (guarding on status === "running" so kill wins). */
  track(description: string): BgAgentTask {
    const id = `agent${++this.seq}`;
    const task: BgAgentTask = {
      id,
      description,
      status: "running",
      startedAt: Date.now(),
      reported: true,
      abort: new AbortController(),
      outputTokens: 0,
      steerQueue: [],
      foreground: true,
    };
    this.tasks.set(id, task);
    return task;
  }

  /** Start a detached child. `runner` receives an abort signal wired to this agent's Kill. */
  start(description: string, runner: (signal: AbortSignal) => Promise<string>): BgAgentTask {
    const id = `agent${++this.seq}`;
    const abort = new AbortController();
    const task: BgAgentTask = { id, description, status: "running", startedAt: Date.now(), reported: false, abort, outputTokens: 0, steerQueue: [] };
    this.tasks.set(id, task);
    // Detached on purpose — not awaited. The result/error lands on the record for drain/AgentOutput.
    // Guard each transition on status === "running" so a kill (which sets "cancelled" up front) wins.
    void runner(abort.signal).then(
      (text) => {
        if (task.status !== "running") return;
        task.status = "done";
        task.result = text;
        task.endedAt = Date.now();
        this.push(task);
      },
      (e) => {
        if (task.status !== "running") return;
        task.status = "failed";
        task.error = e instanceof Error ? e.message : String(e);
        task.endedAt = Date.now();
        this.push(task);
      },
    );
    return task;
  }

  /** Per-task last-emit clock — a chatty child can't flood the inbox. */
  private readonly lastProgressAt = new Map<string, number>();
  private progressSeq = 0;

  /** Queue mid-run guidance for a child. Only a running child can be steered — a late steer
   *  to a finished/killed task is a silent no-op (returns false so the UI can say so). */
  steer(id: string, text: string): boolean {
    const t = this.tasks.get(id);
    if (!t || t.status !== "running") return false;
    t.steerQueue.push(text);
    return true;
  }

  /** Live cost/routing telemetry from the child — no throttle (it's state, not an event). */
  reportUsage(id: string, outputTokens: number, model?: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.outputTokens += outputTokens;
    if (model) t.model = model;
  }

  /** Mid-run status from a live child ("turn 3 · Read src/x.ts"). Throttled per task; a fresh
   *  id per emission means inbox coalescing keeps only the newest pending snapshot. */
  reportProgress(id: string, status: string): void {
    const t = this.tasks.get(id);
    if (!t || t.status !== "running" || !this.inbox) return;
    const now = Date.now();
    if (now - (this.lastProgressAt.get(id) ?? 0) < this.progressMinMs) return;
    this.lastProgressAt.set(id, now);
    this.inbox.emit({
      id: `${id}#p${++this.progressSeq}`,
      source: id,
      sourceType: "agent",
      kind: "progress",
      label: t.description,
      body: status,
      ts: now,
    });
  }

  /** Push path: emit the terminal event and claim the report so drainNotifications skips it.
   *  A cancelled task is NOT pushed — the model initiated the kill, it already knows. */
  private push(t: BgAgentTask): void {
    if (!this.inbox || t.reported) return;
    t.reported = true;
    this.inbox.emit({
      id: `${t.id}#end`,
      source: t.id,
      sourceType: "agent",
      kind: t.status === "done" ? "complete" : "error",
      label: t.description,
      body:
        t.status === "done"
          ? t.result || "(no output)"
          : `failed: ${t.error ?? "unknown error"}`,
      ts: Date.now(),
    });
  }

  /** Live BACKGROUND tasks — the loop's "is background work still running" check and the
   *  status bar's "N bg". Foreground children are excluded: the main loop is already
   *  waiting on them, so counting them as background work would be a lie. */
  liveCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === "running" && !t.foreground) n++;
    return n;
  }

  get(id: string): BgAgentTask | undefined {
    return this.tasks.get(id);
  }

  list(): BgAgentTask[] {
    return [...this.tasks.values()];
  }

  /** Cancel a running task. Marks it cancelled immediately (so it's reported even if the child
   *  ignores the signal for a moment) and aborts its signal. */
  kill(id: string): boolean {
    const t = this.tasks.get(id);
    if (!t || t.status !== "running") return false;
    t.status = "cancelled";
    t.endedAt = Date.now();
    t.abort.abort();
    return true;
  }

  /** One-shot notifications for tasks that ended and haven't been surfaced yet — injected into the
   *  main loop so the agent learns a background task it started finished, without polling. */
  drainNotifications(): string[] {
    const out: string[] = [];
    for (const t of this.tasks.values()) {
      if (t.status === "running" || t.reported) continue;
      t.reported = true;
      if (t.status === "done") {
        out.push(`[Background task ${t.id} "${t.description}" finished. Result:]\n${t.result || "(no output)"}`);
      } else if (t.status === "cancelled") {
        out.push(`[Background task ${t.id} "${t.description}" was cancelled.]`);
      } else {
        out.push(`[Background task ${t.id} "${t.description}" failed: ${t.error ?? "unknown error"}]`);
      }
    }
    return out;
  }

  killAll(): void {
    for (const t of this.tasks.values()) if (t.status === "running") this.kill(t.id);
  }
}

export const backgroundAgents = new BackgroundAgents();

// A detached child would outlive us — abort them on exit.
process.on("exit", () => backgroundAgents.killAll());
