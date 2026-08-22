/**
 * Workflow runner: deterministic multi-agent orchestration. A workflow is plain code that gets an
 * injected context — agent(), parallel(), pipeline(), phase(), log() — and drives sub-agents with
 * real control flow (loops, conditionals, fan-out) instead of leaving orchestration to the model.
 *
 * Agent spawning is INJECTED (runAgent) so the engine stays decoupled from how sessions are built
 * — the same seam the Task tool uses (SubagentRun). Concurrency is bounded by a semaphore that
 * every agent() call passes through, so a parallel() of 100 items still runs only N at a time.
 */

export interface WorkflowAgentOpts {
  /** Display label for progress; defaults to `agent <n>`. */
  label?: string;
  /** Progress group; defaults to the current phase(). */
  phase?: string;
  /** When set, the sub-agent is asked for JSON and agent() returns the parsed value, not text. */
  schema?: unknown;
  /** Model tag / meta-model override for this call. */
  model?: string;
  /** Reasoning effort override. */
  effort?: string;
  /** Named custom agent definition to run as. */
  agentType?: string;
  /** 'worktree' runs this agent in a fresh git worktree so parallel file-editing agents can't
   *  clobber each other; its changes come back on a branch (or the worktree is auto-removed if
   *  it made none). Requires the workspace to be a git repo — falls back to shared cwd otherwise. */
  isolation?: "worktree";
}

export interface RunAgentResult {
  text: string;
  /** Parsed structured output when opts.schema was provided. */
  data?: unknown;
  /** Output tokens this agent spent — accumulated into budget.spent(). */
  tokens?: number;
}

/** Injected by the host: actually spawn a sub-agent and return its result. */
export type RunAgent = (prompt: string, opts: WorkflowAgentOpts) => Promise<RunAgentResult>;

/** Resume support: an injected cache of prior agent() results keyed by call order (seq). Because
 *  a workflow's control flow is deterministic code, the Nth agent() call is stable across runs —
 *  so a re-run can replay the unchanged prefix from the journal and only run edited/new calls. */
export interface WorkflowCache {
  /** A cached result for this call, or undefined to run it live. */
  lookup(seq: number, prompt: string, opts: WorkflowAgentOpts): RunAgentResult | undefined;
  /** Record a freshly-computed result so a later resume can skip it. */
  record(seq: number, prompt: string, opts: WorkflowAgentOpts, result: RunAgentResult): void;
}

export interface WorkflowEvents {
  onPhase?(title: string): void;
  onLog?(message: string): void;
  onAgentStart?(info: { id: number; label: string; phase?: string }): void;
  onAgentEnd?(info: { id: number; label: string; ok: boolean; ms: number; cached?: boolean }): void;
}

export interface WorkflowContext {
  /** Spawn a sub-agent. Returns its text, or the parsed value when opts.schema is set. */
  agent(prompt: string, opts?: WorkflowAgentOpts): Promise<unknown>;
  /** Run thunks concurrently (bounded by the semaphore); a thrown thunk resolves to null. */
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  /** Run each item through all stages independently (no barrier between stages). A stage that
   *  throws drops that item to null. Each stage gets (prevResult, originalItem, index). */
  pipeline(
    items: unknown[],
    ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown> | unknown>
  ): Promise<unknown[]>;
  /** Run another named workflow inline as a sub-step and return its result. Nesting is one level
   *  only — calling workflow() inside a nested workflow throws. */
  workflow(name: string, args?: unknown): Promise<unknown>;
  /** The turn's output-token target. `total` is null when none was set; `spent()` is the running
   *  sum across this workflow's agents; `remaining()` is `Infinity` with no target. Once spent
   *  reaches total, further agent() calls throw — use it for dynamic "run until N tokens" loops. */
  budget: { total: number | null; spent(): number; remaining(): number };
  /** Start a new phase; subsequent agent() calls group under it. */
  phase(title: string): void;
  /** Emit a progress message. */
  log(message: string): void;
  /** The value passed as `args` to runWorkflow, verbatim. */
  args: unknown;
}

export type WorkflowBody = (ctx: WorkflowContext) => Promise<unknown> | unknown;

export interface RunWorkflowOptions {
  body: WorkflowBody;
  runAgent: RunAgent;
  args?: unknown;
  /** Max concurrent agent() calls. Default 8. */
  concurrency?: number;
  /** Hard cap on total agents spawned (runaway-loop backstop). Default 1000. */
  maxAgents?: number;
  /** Resume cache: when present, agent() replays a matching prior result instead of spawning. */
  cache?: WorkflowCache;
  /** Output-token target for budget.*; agent() throws once the running total reaches it. */
  budget?: number | null;
  /** Injected runner for nested workflow(name, args). Absent → workflow() throws (one-level cap). */
  runNested?: (name: string, args: unknown) => Promise<unknown>;
  events?: WorkflowEvents;
}

/** A small FIFO semaphore: acquire() resolves when a slot is free; call the returned release. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<unknown> {
  const sem = new Semaphore(Math.max(1, opts.concurrency ?? 8));
  const maxAgents = opts.maxAgents ?? 1000;
  const ev = opts.events ?? {};
  let spawned = 0;
  let currentPhase: string | undefined;

  const budgetTotal = opts.budget ?? null;
  let spentTokens = 0;
  const budget = {
    total: budgetTotal,
    spent: () => spentTokens,
    remaining: () => (budgetTotal == null ? Number.POSITIVE_INFINITY : Math.max(0, budgetTotal - spentTokens)),
  };

  const agent = async (prompt: string, aopts: WorkflowAgentOpts = {}): Promise<unknown> => {
    if (spawned >= maxAgents) throw new Error(`workflow exceeded the ${maxAgents}-agent cap`);
    if (budgetTotal != null && spentTokens >= budgetTotal) {
      throw new Error(`workflow token budget (${budgetTotal}) exhausted`);
    }
    const id = ++spawned;
    const label = aopts.label ?? `agent ${id}`;
    const phase = aopts.phase ?? currentPhase;
    // Resume: replay a cached result — no spawn, no semaphore slot, instant.
    const hit = opts.cache?.lookup(id, prompt, aopts);
    if (hit) {
      ev.onAgentStart?.({ id, label, phase });
      ev.onAgentEnd?.({ id, label, ok: true, ms: 0, cached: true });
      return aopts.schema ? (hit.data ?? hit.text) : hit.text;
    }
    const release = await sem.acquire();
    const t0 = Date.now();
    ev.onAgentStart?.({ id, label, phase });
    try {
      const res = await opts.runAgent(prompt, aopts);
      spentTokens += res.tokens ?? 0;
      opts.cache?.record(id, prompt, aopts, res);
      ev.onAgentEnd?.({ id, label, ok: true, ms: Date.now() - t0 });
      return aopts.schema ? (res.data ?? res.text) : res.text;
    } catch (e) {
      ev.onAgentEnd?.({ id, label, ok: false, ms: Date.now() - t0 });
      throw e;
    } finally {
      release();
    }
  };

  const parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> =>
    Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)));

  const pipeline = async (
    items: unknown[],
    ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown> | unknown>
  ): Promise<unknown[]> =>
    Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item;
        try {
          for (const stage of stages) value = await stage(value, item, index);
          return value;
        } catch {
          return null;
        }
      }),
    );

  const phase = (title: string): void => {
    currentPhase = title;
    ev.onPhase?.(title);
  };
  const log = (message: string): void => {
    ev.onLog?.(message);
  };
  const workflow = async (name: string, args?: unknown): Promise<unknown> => {
    if (!opts.runNested) throw new Error("workflow() nesting is one level only");
    return opts.runNested(name, args);
  };

  const ctx: WorkflowContext = { agent, parallel, pipeline, workflow, budget, phase, log, args: opts.args };
  return opts.body(ctx);
}
