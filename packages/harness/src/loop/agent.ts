import {
  addUsage,
  type AssistantEvent,
  type Author,
  type ContentBlock,
  type ConversationEntry,
  emptyUsage,
  HUMAN,
  SYSTEM,
  type EngineEvent,
  isPersisted,
  type Message,
  type ResultEvent,
  type ModelRefusal,
  type SandboxRefusal,
  type ToolResultBlock,
  type ToolResultBlocks,
  type ToolResultEvent,
  type ToolUseBlock,
  type Usage,
  type UserEvent,
} from "@mlpal/harness-protocol";
import { maybeCompact, renderTranscript } from "../context/compaction";
import { type EventInbox, renderEvents, waitForEvent } from "../events/inbox";
import { type SessionEventBus, type SideEvent, SideQueue } from "../events/session-bus";
import type { HookEngine } from "../hooks/engine";
import type { HookContext, SessionEndInput } from "../hooks/types";
import { classifyStartRung } from "../routing/classifier";
import type { ModelRouter } from "../routing/router";
import { GatewayError, type ModelClient, type ModelResult } from "../gateway/client";
import { budgetRefusal, modelRefusal } from "../profile/model-policy";
import { type Logger, silentLogger } from "../obs/logger";
import { type RunStamp, type StampConfig, stampFields } from "../telemetry/stamp";
import { stripInvisible } from "../input/sanitize";
import { type Metrics, noopMetrics } from "../obs/metrics";
import type { CanUseTool, Decision, PermissionRequest } from "../permission/engine";
import type { SafetyReason } from "../permission/safety-envelope";
import type { Effort } from "../gateway/client";
import type { Store } from "../store/types";
import { runTool, type ToolRegistry } from "../tools/registry";
import type { ExecPolicy, ToolResult } from "../tools/types";
import { effectiveEntries, loadMessages } from "./messages";
import { EventTooLargeError } from "../store/errors";
import { diffStat } from "../usage/stats";
import { frameHandoff, postHandoffReply } from "./handoff";

/**
 * Domain heuristics (which commands count as verification, churn thresholds, nudge texts,
 * side-call prompts) live in the harness profile's LoopPolicy — see profile/types.ts. The
 * coding profile carries the values that used to be hardcoded here; `cfg.loop` unset means
 * the coding defaults, so the engine standalone behaves exactly as before the split.
 */
import type { LoopPolicy } from "../profile/types";
import { CODING_PROFILE } from "../profile/builtins/coding";
import {
  buildRunOutcome, providerOfCommand,
  classifyFailure,
  type MemoryProjectionStat,
  type RunResult,
  type RunRole,
  type TelemetrySink,
  type VerifierVerdict,
} from "../telemetry/contract";

export interface AgentConfig {
  agentId: string;
  displayName?: string;
  sessionId: string;
  workspace: string;
  /** telemetry v1: what every record and outbound call is stamped with, beyond session and run. */
  stamp?: StampConfig;
  /** telemetry v1: for a subagent, the parent's run (turn) that spawned it. */
  parentRunId?: string;
  /** A sub-agent: the session and the `Agent` tool_use that spawned it; written to the session
   *  record so listings can hide or nest it. */
  parent?: { sessionId: string; toolUseId: string };
  /** 0.21: written to the session record at creation (never changed on a resume): the principal
   *  that opened it and how it came to exist (`ui` | `api` | `schedule:<id>`). */
  owner?: string;
  origin?: string;
  /** Routes side events (a sub-agent's lifecycle, a child's forwarded events) to this session
   *  whether or not its loop is running. Without it, side events raised while a tool runs still
   *  reach the stream; those raised after the run (a background child's end) are dropped. */
  events?: SessionEventBus;
  cwd: string;
  /** Allowed filesystem roots for path-based tools. Defaults to [cwd]; --add-dir extends it. */
  roots?: string[];
  /** Execution sandbox for command-running tools (Bash, background tasks, monitors). */
  exec?: ExecPolicy;
  model: string;
  systemPrompt: string;
  tools: ToolRegistry;
  store: Store;
  model_client: ModelClient;
  canUseTool: CanUseTool;
  maxTokens?: number;
  maxTurns?: number;
  /** Reasoning effort (adaptive thinking + a discrete level), sent to the gateway as
   *  output_config.effort. Held stable for the whole run so it never invalidates the prompt cache. */
  effort?: Effort;
  signal?: AbortSignal;
  logger?: Logger;
  metrics?: Metrics;
  /** Model context window (from the registry). Enables auto-compaction when set. */
  contextWindow?: number;
  compaction?: {
    enabled?: boolean;
    threshold?: number;
    keepRecentTurns?: number;
    /** Model used to summarize (defaults to the main model). */
    model?: string;
    /** memory v13 (DESIGN §3): after a summary compaction the host rebuilds the context from
     *  memory first — the projection, the workspace note, the last log records — and the text
     *  returned here is appended as a system-authored user turn before the next model call. */
    onAfterCompact?: (summary: string) => Promise<string | undefined>;
  };
  /** memory v13 (DESIGN §3, F5): the model does not checkpoint on its own in short runs, so the
   *  host asks every `everyTurns` turns. `nudge` is the HOP's wording; `enabled` is read at each
   *  turn because the memory server may connect after the session was built. */
  memoryCheckpoint?: { everyTurns: number; nudge: (turns: number) => string; enabled?: () => boolean };
  hooks?: HookEngine;
  /** Per-subtask model routing (summaries, sub-agents). Falls back to `model`. */
  router?: ModelRouter;
  /** Cap on how many times a Stop hook can force continuation (verifier loop). */
  maxStopContinuations?: number;
  /**
   * Difficulty-aware model ladder (cheap → strong). When set, the loop starts on the
   * first rung and climbs to the next each time the current rung fails the Stop verifier
   * `escalationPatience` times — cheap-by-default, escalate-only-when-stuck. Inert without
   * a Stop verifier (nothing signals difficulty).
   */
  escalation?: string[];
  /**
   * Verifier blocks a rung must accumulate before the loop climbs to the next model.
   * >1 lets a cheap model self-correct from test feedback before paying for a stronger
   * one — cheap models often fix their own mistake on the 2nd/3rd try. Default 2.
   */
  escalationPatience?: number;
  /**
   * Proactive routing: run a one-shot cheap classifier at the start of each turn to pick
   * the ladder rung to START on (obviously-hard tasks skip a doomed cheap attempt; tasks
   * with no verifier still get difficulty-routed). Fail-safe to rung 0. Requires `escalation`.
   */
  classifyStart?: boolean;
  /** Drain peer messages (inter-agent collaboration) at the finish point. Default true. */
  enablePeerMessages?: boolean;
  /**
   * Background-task watcher hook: returns one-shot notifications for background tasks that have
   * finished/failed or appear stuck on an interactive prompt. Called between turns and at the
   * finish point so the agent learns about them instead of having to poll. Undefined => no watcher.
   */
  drainBackgroundNotifications?: () => string[];
  /**
   * Async event inbox — the typed successor to drainBackgroundNotifications. Background
   * producers (bg shells, bg sub-agents, monitors) push events here; the loop drains at every
   * step boundary (folded into the tool-result turn mid-run; its own turn at the finish point)
   * so long-running work reports without blocking. When set, producers attached to it stop
   * reporting through drainBackgroundNotifications (no double delivery).
   */
  inbox?: EventInbox;
  /**
   * Finish-boundary wait policy ("-p wait-all"): when the model wants to finish but
   * hasLiveWork() is true, park until the next inbox event (then continue) or maxWaitMs
   * (then finish). Leave unset in interactive mode — the REPL owns idle-time surfacing there.
   */
  backgroundWait?: { hasLiveWork: () => boolean; maxWaitMs?: number };
  /**
   * Interactive steering: returns messages the user typed *while this run was working* (via the
   * REPL) to inject into the CURRENT run rather than queue for after it. Drained at every step
   * boundary — folded into the tool-result turn after a tool step, so a steer lands before the
   * next model turn, and injected as its own turn at the finish point, so a steer that arrives as
   * the agent is wrapping up continues the run instead of being lost. Undefined => no steering
   * (headless), so behaviour there is unchanged.
   */
  drainSteering?: () => string[];
  /** The CURRENT plan (task tracker render) appended verbatim after a compaction summary —
   *  plans are anchor state, never summarized. Replaces the old last-TodoWrite capture. */
  planSnapshot?: () => string | null;
  /** Resolve an "ask" decision (interactive prompt). Headless default denies. `ask` carries WHY the
   *  policy asked: a §10 safety edge (`safetyReason`) must always be answered per action — no
   *  session grant or live-mode raise may satisfy it — so the host needs to tell the two apart. */
  onAsk?: (req: PermissionRequest, ask: AskContext) => Promise<Decision | null>;
  /** Observes the EFFECTIVE permission decision for every attempt, after the whole cascade and any
   *  interactive/headless resolution — the seam the host's attempt trace hangs off. Never throws
   *  into the loop (errors are swallowed). */
  onDecision?: (req: PermissionRequest, decision: Decision, via: DecisionVia) => void;
  /** Headless safety runs (§10): when a safety-edge ask has no interactive answerer, END the run
   *  as NEEDS_APPROVAL (stop-and-wait) rather than denying the action and continuing. The host sets
   *  this for a headless run under a HOP with a safety envelope; it writes the hop-run-result-v1
   *  artifact from the terminal result event's pendingApproval. */
  parkHeadless?: boolean;
  /**
   * Completion self-check: nudge once to verify-or-admit when a run made >= selfCheckMinEdits
   * successful edits but never ran a test/build/typecheck. Default on (undefined => on); set
   * false to disable. Automatically inert when a Stop verifier is wired (it takes precedence).
   */
  selfCheck?: boolean;
  /** Minimum successful edits before the completion self-check may fire. Default 3. */
  selfCheckMinEdits?: number;
  /** Project's detected verify command (e.g. "pytest"), named in the self-check nudge if set. */
  verifyHint?: string;
  /** Same-tier fallback models for the main model, tried on a transient pre-content failure. */
  modelFallbacks?: string[];
  /**
   * Condense tool outputs longer than `threshold` chars via a cheap side-model before they enter
   * context. A separate one-shot call, so the main conversation's cache is untouched. Off if unset.
   */
  condense?: { threshold: number; model: string };
  /**
   * Mid-loop anti-churn breaker: when one file is edited churn-threshold times in a run
   * with no verification, nudge once to commit-and-stop. Default on (undefined => on); set false
   * to disable. Inert when a Stop verifier is wired (it takes precedence).
   */
  antiChurn?: boolean;
  /**
   * Harness-profile loop policy: verification vocabulary, churn threshold, nudge texts, and
   * side-call prompts (summarizer/condenser/classifier). Unset => the coding profile's policy
   * (pre-split behavior, byte-identical — pinned by golden tests).
   */
  loop?: LoopPolicy;
  /**
   * HOP telemetry sink (D11.2). When set, the loop emits one content-free RunOutcomeEvent at the
   * finish point of every run — the Capture stage of the HOP optimizer. Fire-and-forget: the
   * emit is wrapped so it can never throw or delay the run. Unset (headless/tests) => no emit and
   * zero behaviour change. The host owns identity/tier resolution (it holds the catalog); the
   * engine only assembles run-state fields.
   */
  telemetry?: {
    hop: { name: string; version: string };
    /** Workspace/repo identity — the episode scope on the memory side. */
    repo: string;
    /** Resolve a served model id to its tier label; host-provided (has the catalog). */
    resolveTier?: (model: string) => string | undefined;
    /** d11.4: main loop vs sub-agent run (host knows which session it built). */
    role: RunRole;
    /** d11.4: the session that spawned this run (sub-agent runs only). */
    parentRunId?: string;
    /** Host override of the HOP's `telemetry.taskType` (an eval kit knows the scenario's class). */
    taskType?: string;
    /** Envelope `source_ref`: how the run began (`interactive` | `one-shot` | `routine:<name>` | …). */
    sourceRef?: string;
    /** d11.5: the event_ids of the memories the host injected into this run's prompt. */
    memoriesInjected?: () => string[];
    /** d11.6: the memory service projection the run started with (counts), when one was used. */
    memoryProjection?: () => MemoryProjectionStat | undefined;
    /** memory v13 (F8): true when the host parked a question for the person during this run. A
     *  run that ended cleanly after parking is recorded as `parked`, never `success`. */
    parked?: () => boolean;
    emit: TelemetrySink;
  };
}

export interface TurnInput {
  text: string;
  /** Attachments (image/document blocks) sent alongside the text — drag-dropped or
   *  @-mentioned media files. Prepended to the user message content. */
  blocks?: ContentBlock[];
  /** Who is speaking — human by default, or a peer agent for inter-agent injection. */
  author?: Author;
}

function now(): string {
  return new Date().toISOString();
}

/** How an attempt's effective decision was reached: straight from the policy, from the interactive
 *  answerer, or from the headless resolution of an ask (parked at the §10 edge, or refused). */
export type DecisionVia = "policy" | "interactive" | "headless_park" | "headless_refused" | "tool";

/** Why the permission policy asked. `safetyReason` is set only for a §10 safety-envelope edge. */
export interface AskContext {
  reason?: string;
  safetyReason?: SafetyReason;
}

/** Thrown from the permission gate when a headless run hits the §10 approval edge, so the run
 *  ENDS as NEEDS_APPROVAL (stop-and-wait) instead of denying the action and continuing. */
class SafetyParkSignal extends Error {
  constructor(
    readonly command: string,
    readonly reason: SafetyReason,
  ) {
    super("safety approval edge (headless park)");
    this.name = "SafetyParkSignal";
  }
}

/** Sleep `ms`, resolving early if `signal` aborts — so a listening worker stops promptly. */
function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** The result a resumed engine records for a tool the dead one had started: it is never run again. */
export const INTERRUPTED_TOOL_RESULT =
  "interrupted: the engine restarted while this tool ran; its effect may already have happened — check before repeating";

/** The tool calls of the turn's last assistant entry that no later tool_result answers. */
function unansweredToolUses(turn: ConversationEntry[]): ToolUseBlock[] {
  let at = -1;
  for (let i = turn.length - 1; i >= 0; i--) {
    if (turn[i]!.payload.type === "assistant") {
      at = i;
      break;
    }
  }
  if (at < 0) return [];
  const asst = turn[at]!.payload as AssistantEvent;
  const answered = new Set(turn.slice(at + 1).flatMap((e) => (e.payload.type === "tool_result" ? [e.payload.toolUseId] : [])));
  return (asst.message.content as ContentBlock[]).filter((b): b is ToolUseBlock => b.type === "tool_use" && !answered.has(b.id));
}

async function serial<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

/** Resolve with the tool result, or immediately with an interrupt result on abort. */
function raceAbort(
  work: Promise<ToolResult>,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve({ content: "[interrupted by user]", isError: true });
  return new Promise((resolve) => {
    const onAbort = () => resolve({ content: "[interrupted by user]", isError: true });
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (r) => {
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ content: `Tool threw: ${(e as Error).message}`, isError: true });
      },
    );
  });
}

/** A short string view of rich tool-result blocks (for the transcript + rendering). */
function summarizeBlocks(blocks: ToolResultBlocks): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "image") return `[image ${b.source.media_type}]`;
      return `[document ${b.source.media_type}]`;
    })
    .join(" ");
}

/**
 * A single addressable agent session. The agentic tool-use loop, built
 * against the callModel seam, the unified store, and an author-tagged input.
 */
export class AgentSession {
  private readonly maxTokens: number;
  private readonly maxTurns: number;
  /** char/4-invisible tokens: the serialized tool-schema block + fixed request overhead.
   *  Computed once (the toolset is stable for a run) and fed to compaction. */
  private toolSchemaTokens = 0;
  private initialized = false;
  /** SessionStart fires once per session instance (not per turn). */
  private sessionStartFired = false;

  /** Side events raised while this run's tools execute, yielded on the stream as they arrive. */
  private readonly side = new SideQueue();

  constructor(private readonly cfg: AgentConfig) {
    this.maxTokens = cfg.maxTokens ?? 8192;
    this.maxTurns = cfg.maxTurns ?? 50;
    // Estimate the tool-schema block once: the JSON the gateway sends as `tools`, which the
    // transcript-only char/4 estimate never sees (easily 5-15k tokens). ~1200 tokens fixed
    // request overhead on top.
    try {
      const schemas = JSON.stringify(cfg.tools.schemas());
      this.toolSchemaTokens = Math.ceil(schemas.length / 4) + 1200;
    } catch {
      this.toolSchemaTokens = 1200;
    }
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    const { store, cfg } = this;
    const ts = now();
    await cfg.store.registry.putAgent({
      agentId: cfg.agentId,
      displayName: cfg.displayName ?? cfg.agentId,
      createdAt: ts,
      lastSeen: ts,
    });
    const existing = await store.registry.getSession(cfg.sessionId);
    if (!existing) {
      // 0.21: a sub-agent belongs to whoever owns its parent (and came to exist the same way), so a
      // principal's listing and guard cover its children; an explicit owner on the child wins.
      const inherited = cfg.parent && (!cfg.owner || !cfg.origin) ? await store.registry.getSession(cfg.parent.sessionId).catch(() => null) : null;
      const owner = cfg.owner ?? inherited?.owner;
      const origin = cfg.origin ?? inherited?.origin;
      await store.registry.putSession({
        sessionId: cfg.sessionId,
        agentId: cfg.agentId,
        workspace: cfg.workspace,
        cwd: cfg.cwd,
        status: "active",
        head: null,
        model: cfg.model,
        ...(cfg.stamp?.hop ? { hop: cfg.stamp.hop } : {}),
        ...(cfg.parent ? { parent: cfg.parent } : {}),
        ...(owner ? { owner } : {}),
        ...(origin ? { origin } : {}),
        createdAt: ts,
        updatedAt: ts,
      });
    } else if (cfg.stamp?.hop && existing.hop !== cfg.stamp.hop) {
      await store.registry.patchSession(cfg.sessionId, { hop: cfg.stamp.hop });
    }
  }

  private get store(): Store {
    return this.cfg.store;
  }

  /** A tool's side event: through the bus when the host has one (so it reaches this session
   *  even after the run), else straight onto this run's queue. */
  private emitSide(e: SideEvent): void {
    if (this.cfg.events) this.cfg.events.emit(this.cfg.sessionId, e);
    else this.side.push(e);
  }

  /** Yield side events on the stream; the persisted ones (a sub-agent's start and end) join the
   *  conversation's parent chain and carry their uuid. Returns the new chain head. */
  private async *flushSide(events: Iterable<SideEvent>, parent: string | null): AsyncGenerator<EngineEvent, string | null, void> {
    for (const e of events) {
      if (e.type === "subagent" && isPersisted(e)) {
        parent = (await this.store.conversation.append(this.cfg.sessionId, e, parent)).uuid;
        yield { ...e, uuid: parent };
      } else {
        yield e;
      }
    }
    return parent;
  }

  /** Run one turn to completion, yielding the live event stream. */
  async *run(input: TurnInput): AsyncGenerator<EngineEvent, void, void> {
    await this.init();
    const { cfg } = this;
    const author = input.author ?? HUMAN;
    // Events for this session raised through the bus during the run land on this run's queue.
    const unsubscribe = cfg.events?.subscribe(cfg.sessionId, (e) => this.side.push(e));
    let parent = await this.store.conversation.head(cfg.sessionId);
    const isNewSession = parent === null;

    if (isNewSession) {
      const sys = {
        type: "system" as const,
        subtype: "init" as const,
        sessionId: cfg.sessionId,
        agentId: cfg.agentId,
        model: cfg.model,
        cwd: cfg.cwd,
        ts: now(),
      };
      const e = await this.store.conversation.append(cfg.sessionId, sys, parent);
      parent = e.uuid;
      yield { ...sys, uuid: parent };
    }

    // SessionStart hook — fires once, when a session's conversation is first created.
    // Gating on isNewSession (empty conversation) is correct across every host: the REPL
    // builds a fresh AgentSession per turn, so an instance flag alone would misfire — only
    // turn 1 of a genuinely new session has an empty DAG. Any injectContext is seeded as a
    // system-authored turn ahead of the user's, so it lands in the model's context.
    if (isNewSession && !this.sessionStartFired && cfg.hooks?.has("SessionStart")) {
      this.sessionStartFired = true;
      const results = await cfg.hooks.run(
        { event: "SessionStart", source: "startup" },
        this.hookCtx(),
      );
      const seeded = results
        .map((r) => r.injectContext?.trim())
        .filter((c): c is string => Boolean(c))
        .join("\n\n");
      if (seeded) {
        const se: UserEvent = {
          type: "user",
          message: { role: "user", content: seeded },
          author: SYSTEM,
          ts: now(),
        };
        parent = (await this.store.conversation.append(cfg.sessionId, se, parent)).uuid;
        yield { ...se, uuid: parent };
      }
    }

    // UserPromptSubmit: a hook may reject the prompt (the run ends with the reason), rewrite it,
    // or add context to it — before anything is persisted, so a rejected prompt leaves no turn.
    // Invisible characters never reach the model: they hide instructions a person cannot see.
    const stripped = stripInvisible(input.text);
    let promptText = stripped.text;
    if (stripped.removed) {
      (cfg.logger ?? silentLogger).warn("prompt sanitized: invisible characters removed", { removed: stripped.removed, sessionId: cfg.sessionId });
      (cfg.metrics ?? noopMetrics).increment("agent.prompt_sanitized", 1);
    }
    // telemetry v1: one run per turn. The id is minted before the UserPromptSubmit hook so a
    // host that stamps its own records (an MCP call, a checkpoint, a verdict) from that hook's
    // context joins the run that is starting, not the one that ended.
    const runId = crypto.randomUUID();
    const previousRun = this.currentRun;
    this.currentRun = runId;
    if (cfg.hooks?.has("UserPromptSubmit")) {
      const results = await cfg.hooks.run({ event: "UserPromptSubmit", prompt: promptText }, this.hookCtx());
      const blocker = results.find((r) => r.block);
      if (blocker) {
        this.currentRun = previousRun; // a rejected prompt leaves no turn and no run
        yield { type: "result", subtype: "error", numTurns: 0, usage: emptyUsage(), ts: now(), reason: `prompt rejected by hook: ${blocker.reason ?? "no reason given"}` };
        return;
      }
      for (const r of results) if (r.updatedPrompt) promptText = r.updatedPrompt;
      const extra = results.map((r) => r.injectContext?.trim()).filter((c): c is string => Boolean(c));
      if (extra.length) promptText = `${promptText}\n\n${extra.join("\n\n")}`;
    }

    // Attachments (images/PDFs) ride ahead of the text in one user message.
    const userContent = input.blocks?.length
      ? [...input.blocks, { type: "text" as const, text: promptText }]
      : promptText;
    const userEvt: UserEvent = {
      type: "user",
      message: { role: "user", content: userContent },
      author,
      ts: now(),
    };
    const userUuid = (await this.store.conversation.append(cfg.sessionId, userEvt, parent)).uuid;
    parent = userUuid;
    yield { ...userEvt, uuid: parent };

    yield* this.turn({ author, task: input.text ?? "", parent, runId, ref: userUuid, unsubscribe });
  }

  /** The turn after its user entry: the model-and-tools loop to the run's result. `run()` enters it
   *  after appending the person's turn; `resume()` after recording what a dead engine left in flight
   *  (`prelude`), without a new user entry. */
  private async *turn(t: {
    author: Author;
    /** What the turn asks, for the start-rung classifier. */
    task: string;
    parent: string | null;
    runId: string;
    /** The entry the turn starts from, for the run.start record. */
    ref: string | null;
    unsubscribe?: () => void;
    resumed?: boolean;
    prelude?: (log: Logger, parent: string | null) => AsyncGenerator<EngineEvent, string | null, void>;
    /** A resumed turn whose model call had answered: its first iteration starts from that answer. */
    answered?: ModelResult;
    /** What the turn had already spent before a resume (its model calls so far). */
    usage?: Usage;
  }): AsyncGenerator<EngineEvent, void, void> {
    const { cfg } = this;
    const { author, runId, unsubscribe } = t;
    let parent = t.parent;
    // The person's prompt names the run; a steer or a peer message keeps the prompt of the turn
    // it lands in.
    this.seq = 0; // record order within the run; (run, seq) is unique across processes
    if (author.type === "human" || !this.currentPrompt) this.currentPrompt = runId;
    await this.event("run.start", { author: author.type, ref: t.ref, ...(t.resumed ? { resumed: true } : {}) });
    const log = (cfg.logger ?? silentLogger).child({
      runId,
      sessionId: cfg.sessionId,
      agentId: cfg.agentId,
    });
    const metrics = cfg.metrics ?? noopMetrics;

    // Mark the session actively-looping so peers (HandoffTask) can tell it's live and route
    // work to it instead of spawning a concurrent editor. Reset to "idle" at the finish.
    await this.store.registry.patchSession(cfg.sessionId, { status: "active" });

    // A resumed turn first records what the dead engine left in flight (plan §5).
    if (t.prelude) parent = yield* t.prelude(log, parent);

    let messages = await loadMessages(this.store, cfg.sessionId);
    let totalUsage: Usage = t.usage ?? emptyUsage();
    let pendingAnswer = t.answered;
    const toolCalls: Record<string, number> = {}; // d11.7: per-tool call counts, names only
    const providerLabels: Record<string, number> = {}; // d11.8: provider CLI counts from Bash calls
    let turns = 0;
    let stopContinuations = 0;
    // Max-tokens recovery: a response cut off by the per-request output cap shouldn't be silently
    // accepted (a truncated answer or half-written file). Bounded so a persistently-too-large task
    // can't loop forever. Continues across the max-output-tokens boundary.
    let maxTokensRecoveries = 0;
    const maxTokensRecoveryLimit = 3;
    // The gateway's real input_tokens from the last request this turn — compaction's floor.
    let lastInputTokens = 0;
    // Completion self-check state. Steps aside when any Stop verifier is wired (that takes
    // precedence). Counts successful edits and whether the run ran a test/build/typecheck, so
    // it can nudge once if the run is about to finish having edited real code but never checked.
    const loop = cfg.loop ?? CODING_PROFILE.loop;
    const selfCheckOn = cfg.selfCheck !== false && !cfg.hooks?.has("Stop");
    const selfCheckMinEdits = cfg.selfCheckMinEdits ?? 3;
    const antiChurnOn = cfg.antiChurn !== false && !cfg.hooks?.has("Stop");
    let editsMade = 0;
    let verifyObserved = false;
    // A verification command RAN (matched the vocab), independent of whether it passed — the
    // observe mechanism's {ran} vs {passed} for telemetry checks.observe. verifyObserved is
    // {passed} (ran and not env-broken).
    let verifyRan = false;
    let selfCheckFired = false;
    // Anti-churn: edits-per-file this run, and whether the breaker has already fired once.
    const editsByFile = new Map<string, number>();
    let churnFired = false;
    // HOP telemetry run-state (only assembled at the finish point when cfg.telemetry is set).
    const startMs = Date.now();
    let verifierVerdict: VerifierVerdict | null = null;
    let outcome: RunResult | null = null;
    let thrownError: unknown;
    // Cross-repo handoff: correlationIds of received task requests we owe a reply to when
    // this run finishes, and the latest assistant text to send back as that reply.
    const owedReplies: string[] = [];
    let lastAssistantText = "";
    // Difficulty escalation: start on the cheapest rung; climb only after the current rung
    // fails the verifier `patience` times (lets a cheap model self-correct before we pay up).
    const ladder = cfg.escalation ?? [];
    const patience = Math.max(1, cfg.escalationPatience ?? 2);
    let escalationRung = 0;
    let rungBlocks = 0;
    let activeModel = ladder[0] ?? cfg.model;
    const maxStopContinuations = cfg.maxStopContinuations ?? Math.max(3, ladder.length * patience);

    // Proactive routing: a cheap classifier picks the rung to START on. Fail-safe to 0.
    if (cfg.classifyStart && ladder.length > 1) {
      const classifyModel = cfg.router?.resolve("classify") ?? ladder[0]!;
      const rung = await classifyStartRung({
        model_client: cfg.model_client,
        model: classifyModel,
        task: t.task,
        rungs: ladder.length,
        system: loop.classifierSystem,
        signal: cfg.signal,
      });
      if (rung > 0) {
        escalationRung = rung;
        activeModel = ladder[rung]!;
        log.info("classifier picked start rung", { rung, model: activeModel });
        metrics.increment("agent.classify_start", 1, { rung: String(rung) });
      }
    }
    log.info("run start", { model: activeModel, ladder: ladder.length, authorType: author.type });

    try {
    for (;;) {
      if (cfg.signal?.aborted) {
        log.warn("run cancelled");
        outcome = "cancelled";
        parent = yield* this.finish("cancelled", turns, totalUsage, parent);
        return;
      }
      if (turns >= this.maxTurns) {
        log.warn("run hit max turns", { maxTurns: this.maxTurns });
        outcome = "max_turns";
        parent = yield* this.finish("max_turns", turns, totalUsage, parent);
        break;
      }
      // A resumed turn's first iteration starts from the answer the dead engine already persisted:
      // no model call, nothing compacted or nudged before it.
      const answered = pendingAnswer;
      pendingAnswer = undefined;
      // Auto-compaction: summarize older turns before they overflow the window.
      if (!answered && cfg.contextWindow && cfg.compaction?.enabled !== false) {
        const preCompactCount = messages.length;
        const c = await maybeCompact(messages, cfg.systemPrompt, {
          contextWindow: cfg.contextWindow,
          maxOutputTokens: this.maxTokens,
          threshold: cfg.compaction?.threshold,
          keepRecentTurns: cfg.compaction?.keepRecentTurns,
          // The tool-schema block the char/4 estimate can't see, plus fixed request overhead.
          overheadTokens: this.toolSchemaTokens,
          // The gateway's real input count from the last request this turn — a lower bound on
          // true occupancy, so an optimistic char/4 estimate can't defer compaction past the
          // model's hard limit.
          knownFloorTokens: lastInputTokens,
          summarize: (older) => this.summarize(older),
          // PreCompact rides on the summarize seam, carrying the verbatim window about to be
          // replaced, so a host checkpoints exactly what is lost (memory v13 DESIGN §3).
          onCompactWindow: cfg.hooks?.has("PreCompact")
            ? async (older) => {
                this.compactions += 1;
                await cfg.hooks!.run(
                  { event: "PreCompact", trigger: "auto", messageCount: preCompactCount, transcript: renderTranscript(older), window: this.compactions },
                  this.hookCtx(),
                );
              }
            : undefined,
        });
        if (c.compacted) {
          messages = c.messages;
          if (!c.summary) {
            // microcompaction only (tool results cleared in-memory) — no boundary to persist
            log.info("microcompacted old tool results");
            metrics.increment("agent.microcompactions", 1, { model: cfg.model });
          } else {
          // Persist a boundary so the next load/resume starts from the summary, not the
          // whole DAG. The live run keeps the recent verbatim turns in `messages`; on
          // reload they fall under the summary — bounded context is the point.
          const ce = {
            type: "compact" as const,
            summary: c.summary ?? "",
            trigger: "auto" as const,
            replacedMessages: c.replaced ?? 0,
            ts: now(),
          };
          parent = (await this.store.conversation.append(cfg.sessionId, ce, parent)).uuid;
          await this.event("compact", { trigger: "auto", replaced: c.replaced ?? 0, summaryTokens: c.summaryTokens, ref: parent });
          yield { ...ce, uuid: parent };
          log.info("compacted context", {
            summaryTokens: c.summaryTokens,
            messages: messages.length,
          });
          metrics.increment("agent.compactions", 1, { model: cfg.model });
          if (cfg.hooks?.has("PostCompact")) await cfg.hooks.run({ event: "PostCompact", trigger: "auto", replaced: c.replaced ?? 0, summaryChars: (c.summary ?? "").length }, this.hookCtx());
          // memory v13 (DESIGN §3): after compaction the context is rebuilt from memory first.
          if (cfg.compaction?.onAfterCompact) {
            const rebuilt = await cfg.compaction.onAfterCompact(c.summary).catch((e) => {
              log.warn("after-compaction memory rebuild failed", { error: String((e as Error)?.message ?? e) });
              return undefined;
            });
            if (rebuilt?.trim()) {
              const ue: UserEvent = { type: "user", message: { role: "user", content: rebuilt }, author: SYSTEM, ts: now() };
              parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
              yield { ...ue, uuid: parent };
              messages.push({ role: "user", content: rebuilt });
              metrics.increment("agent.memory_rebuilds", 1);
            }
          }
          }
        }
      }

      turns++;
      metrics.increment("agent.turns", 1, { model: cfg.model });
      // memory v13 (F5): the periodic checkpoint is a host trigger, not a habit the model keeps.
      if (!answered && cfg.memoryCheckpoint && cfg.memoryCheckpoint.everyTurns > 0 && turns % cfg.memoryCheckpoint.everyTurns === 0 && (cfg.memoryCheckpoint.enabled?.() ?? true)) {
        const note = cfg.memoryCheckpoint.nudge(turns);
        const ue: UserEvent = { type: "user", message: { role: "user", content: note }, author: SYSTEM, ts: now() };
        parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
        yield { ...ue, uuid: parent };
        messages.push({ role: "user", content: note });
        log.info("memory checkpoint nudge", { turns });
        metrics.increment("agent.checkpoint_nudges", 1);
      }

      let result: ModelResult;
      const callStartMs = Date.now();
      const callId = crypto.randomUUID(); // names the model span; the gateway sees it in traceparent
      // Snapshot the tool set SENT: MCP servers may connect during the call, and the ledger must
      // record what the model saw, not what the registry holds afterwards.
      const toolSchemas = cfg.tools.schemas();
      try {
        result = answered ?? (yield* cfg.model_client.stream({
          model: activeModel,
          system: cfg.systemPrompt,
          messages: [...messages], // snapshot — the model client never sees our mutable array
          tools: toolSchemas,
          maxTokens: this.maxTokens,
          signal: cfg.signal,
          trace: { stamp: this.stamp(), callId },
          ...(activeModel === cfg.model && cfg.modelFallbacks ? { fallbackModels: cfg.modelFallbacks } : {}),
          ...(cfg.effort ? { effort: cfg.effort } : {}),
        }));
      } catch (e) {
        if (e instanceof GatewayError && e.kind === "cancelled") {
          log.warn("run cancelled mid-stream");
          outcome = "cancelled";
          parent = yield* this.finish("cancelled", turns, totalUsage, parent);
          return;
        }
        // The gateway refused the model for this HOP (rule 4), or the key's budget cap is spent
        // (0.22.1): the run ends as a typed error the frontend reads from fields, not a thrown
        // exception it must parse.
        if (e instanceof GatewayError && (e.modelAccessDenied || e.budgetExceeded)) {
          const hop = (cfg.stamp?.hop ?? "?").split("@")[0]!;
          const model = e.model ?? activeModel;
          const refusal = e.budgetExceeded ? budgetRefusal(model, hop, { window: e.window, resetsAt: e.resetAt }) : modelRefusal(model, hop, "gateway");
          log.warn(e.budgetExceeded ? "budget cap spent: the gateway refused the call" : "model refused by the gateway", { model, hop, detail: e.message });
          metrics.increment(`agent.${refusal.code}`, 1, { model });
          outcome = "error";
          parent = yield* this.finish("error", turns, totalUsage, parent, undefined, refusal);
          return;
        }
        log.error("model call failed", { error: String(e) });
        metrics.increment("agent.errors", 1, { model: cfg.model });
        outcome = "error";
        thrownError = e;
        throw e;
      }

      // A model call is recorded once: a resumed answer was, by the engine that made it.
      if (!answered) {
        // The gateway's charge rides with the token counts (protocol 0.17.0): per call on the
        // assistant event, summed on the run's result.
        const callUsage: Usage = { ...result.usage, ...(result.computeUnits !== undefined ? { compute_units: result.computeUnits } : {}) };
        totalUsage = addUsage(totalUsage, callUsage);
        // Real occupancy of the request just sent (input + cache), the floor for the NEXT
        // turn's compaction check. Cache-read counts against the window too.
        lastInputTokens =
          (result.usage.input_tokens ?? 0) +
          (result.usage.cache_read_input_tokens ?? 0) +
          (result.usage.cache_creation_input_tokens ?? 0);
        const asstEvt: AssistantEvent = {
          type: "assistant",
          message: result.message,
          usage: callUsage,
          stopReason: result.stopReason,
          model: result.model,
          ...(result.effort ? { effort: result.effort } : {}),
          ts: now(),
        };
        parent = (await this.store.conversation.append(cfg.sessionId, asstEvt, parent)).uuid;
        // The per-call ledger /usage reads: duration and the gateway's own compute units ride
        // with the token counts, so session cost is the meter's figure, not an estimate.
        // `ms` is the wall-clock time the run waited for this call, from issuing it to its result:
        // every gateway attempt, backoff and failover, and any host suspension, included. It is one
        // request's latency only when `attempts` is 1 (absent: the client does not count them).
        await this.store.logs.write(cfg.sessionId, "model", {
          ...this.stampFields(),
          callId,
          ref: parent,
          model: result.model,
          stopReason: result.stopReason,
          usage: result.usage,
          ms: Date.now() - callStartMs,
          tools: toolSchemas.length, // a changed tool set is a prompt-prefix change (cache miss cause)
          ...(result.computeUnits === undefined ? {} : { computeUnits: result.computeUnits }),
          ...(result.servingBackend ? { servingBackend: result.servingBackend } : {}),
          ...(result.traceId ? { traceId: result.traceId } : {}),
          ...(result.effort ? { effort: result.effort } : {}),
          ...(result.attempts === undefined ? {} : { attempts: result.attempts }),
        });
        yield { ...asstEvt, uuid: parent };
        messages.push(result.message);
      }

      const toolUses = (result.message.content as ContentBlock[]).filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );
      for (const tu of toolUses) {
        toolCalls[tu.name] = (toolCalls[tu.name] ?? 0) + 1;
        // d11.8: which infrastructure CLI a Bash call started with — a label, never the command
        if (tu.name === "Bash") {
          const cmd = (tu.input as { command?: unknown } | undefined)?.command;
          const label = typeof cmd === "string" ? providerOfCommand(cmd) : undefined;
          if (label) providerLabels[label] = (providerLabels[label] ?? 0) + 1;
        }
      }
      const asstText = (result.message.content as ContentBlock[])
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (asstText.trim()) lastAssistantText = asstText.trim();
      if (toolUses.length === 0) {
        // Output hit the per-request token cap: the answer was truncated mid-thought. Resume it
        // (splitting large outputs) instead of accepting the cut — up to a bounded number of times.
        if (result.stopReason === "max_tokens" && maxTokensRecoveries < maxTokensRecoveryLimit) {
          maxTokensRecoveries += 1;
          const note =
            "[Output limit] Your last response hit the output token limit and was cut off. Continue " +
            "exactly where you left off — no apology, no recap. If you're producing something large " +
            "(a file, a long list), split it into smaller pieces across multiple steps.";
          const ue: UserEvent = { type: "user", message: { role: "user", content: note }, author: SYSTEM, ts: now() };
          parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
          yield { ...ue, uuid: parent };
          messages.push({ role: "user", content: note });
          log.info("max_tokens recovery: resuming truncated output", { recoveries: maxTokensRecoveries });
          metrics.increment("agent.max_tokens_recovery", 1);
          continue;
        }

        // Inter-agent collaboration: drain peer messages. If any arrived while we were
        // working, inject them as author-tagged turns and continue instead of finishing.
        if (cfg.enablePeerMessages !== false) {
          const peers = await this.store.mailbox.drain(cfg.sessionId);
          if (peers.length > 0) {
            for (const pm of peers) {
              // A correlated peer message is a cross-repo task request: reply is owed to its
              // private correlationId channel when we finish. Frame it so the model reports back.
              const framed = frameHandoff({ ...pm, text: stripInvisible(pm.text).text });
              if (pm.correlationId) owedReplies.push(pm.correlationId);
              const ue: UserEvent = {
                type: "user",
                message: { role: "user", content: framed },
                author: pm.from,
                ts: now(),
              };
              parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
              yield { ...ue, uuid: parent };
              messages.push({ role: "user", content: framed });
              log.info("peer message injected", { from: pm.from.id ?? pm.from.type, handoff: Boolean(pm.correlationId) });
              metrics.increment("agent.peer_messages", 1);
            }
            continue;
          }
        }

        // Interactive steering that arrived while the agent was wrapping up (produced no tool call
        // this turn): inject and keep going instead of finishing — the "picked up before the next
        // loop" behaviour, at the one boundary the mid-loop fold above can't reach. Prev turn is
        // assistant text here, so a fresh user turn keeps alternation valid.
        if (cfg.drainSteering) {
          const steers = cfg.drainSteering().map((s) => s.trim()).filter(Boolean);
          if (steers.length > 0) {
            for (const steer of steers) {
              const ue: UserEvent = { type: "user", message: { role: "user", content: steer }, author, ts: now() };
              parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
              yield { ...ue, uuid: parent };
              messages.push({ role: "user", content: steer });
            }
            log.info("user steer injected at finish", { count: steers.length });
            metrics.increment("agent.steer", steers.length, { at: "finish" });
            continue;
          }
        }

        // Background-task watcher: surface finished/failed/prompt-stalled tasks the agent started,
        // so it doesn't wrap up while a task it launched is unresolved (or silently hung on input).
        if (cfg.drainBackgroundNotifications) {
          const notes = cfg.drainBackgroundNotifications();
          if (notes.length > 0) {
            for (const text of notes) {
              const ue: UserEvent = { type: "user", message: { role: "user", content: text }, author: SYSTEM, ts: now() };
              parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
              yield { ...ue, uuid: parent };
              messages.push({ role: "user", content: text });
            }
            log.info("background notifications injected at finish", { count: notes.length });
            metrics.increment("agent.bg_notifications", notes.length);
            continue;
          }
        }

        // Async event inbox at the finish point: pending events continue the run; with a wait
        // policy (-p wait-all), park for the next event while work this run started is still
        // live — a run must not end with its own background work unresolved. Parked before the
        // Stop verifier on purpose: a pending result may change what "done" looks like.
        if (cfg.inbox) {
          if (cfg.inbox.size() === 0 && cfg.backgroundWait?.hasLiveWork() && !cfg.signal?.aborted) {
            const maxWaitMs = cfg.backgroundWait.maxWaitMs ?? 300_000;
            log.info("parking for background events", { maxWaitMs });
            metrics.increment("agent.bg_park", 1);
            await waitForEvent(cfg.inbox, maxWaitMs, cfg.signal);
          }
          const events = cfg.inbox.drain();
          if (events.length > 0) {
            const text = renderEvents(events);
            const ue: UserEvent = { type: "user", message: { role: "user", content: text }, author: SYSTEM, ts: now() };
            parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
            yield { ...ue, uuid: parent };
            messages.push({ role: "user", content: text });
            log.info("inbox events injected at finish", {
              count: events.length,
              ids: events.map((e) => e.id),
            });
            metrics.increment("agent.inbox_events", events.length, { at: "finish" });
            continue;
          }
        }

        // Stop hooks (verifier loop): a hook may block "done" and force a correction.
        if (cfg.hooks?.has("Stop") && stopContinuations < maxStopContinuations) {
          const results = await cfg.hooks.run({ event: "Stop", numTurns: turns }, this.hookCtx());
          // Stamp the agent-verifier verdict for telemetry even when it passes (allows without
          // blocking). The last verdict seen is the finishing one — a FAIL that blocks is later
          // overwritten by the PASS the loop eventually reaches.
          const v = results.find((r) => r.verdict)?.verdict;
          if (v) verifierVerdict = v;
          const blocker = results.find((r) => r.block);
          if (blocker) {
            stopContinuations += 1;
            if (cfg.hooks?.has("StopFailure")) {
              await cfg.hooks.run({ event: "StopFailure", reason: blocker.reason ?? "stop hook blocked", ...(v ? { verdict: v } : {}), continuations: stopContinuations }, this.hookCtx());
            }
            // Climb the difficulty ladder, but only once the current rung has failed the
            // verifier `patience` times — a cheap model often fixes its own mistake from
            // the test feedback, so give it a couple of shots before paying for a stronger one.
            rungBlocks += 1;
            let escNote = "";
            if (rungBlocks >= patience && escalationRung < ladder.length - 1) {
              escalationRung += 1;
              rungBlocks = 0;
              const escalatedFrom = activeModel;
              activeModel = ladder[escalationRung]!;
              escNote = ` Escalating to a stronger model (${activeModel}) after ${patience} failed ${patience === 1 ? "attempt" : "attempts"}.`;
              log.info("escalating model after verifier block", { to: activeModel, rung: escalationRung });
              metrics.increment("agent.escalations", 1, { to: activeModel });
              // The cheaper model wasn't good enough and we climbed — the highest-value feedback datum
              // (a direct comparative outcome). Fire-and-forget so it never affects this run.
              cfg.model_client.postFeedback?.({
                model: escalatedFrom,
                task_type: loop.taskType,
                outcome: "escalated",
                escalated_to: activeModel,
              });
            }
            const note = `[Verification] ${blocker.reason ?? "Not done yet — keep going."}${escNote}`;
            log.info("stop blocked by hook; continuing", { reason: blocker.reason, stopContinuations });
            metrics.increment("agent.stop_continuations", 1, { model: activeModel });
            const ue: UserEvent = {
              type: "user",
              message: { role: "user", content: note },
              author: SYSTEM,
              ts: now(),
            };
            parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
            yield { ...ue, uuid: parent };
            messages.push({ role: "user", content: note });
            continue;
          }
        }
        // Completion self-check (default-on, one-shot): a run that edited real code but never
        // ran a test/build/typecheck gets a single nudge to verify-or-admit before finishing.
        // Edit-gated + one-shot, so trivial and already-verified runs pay nothing.
        if (selfCheckOn && !selfCheckFired && editsMade >= selfCheckMinEdits && !verifyObserved) {
          selfCheckFired = true;
          const note = loop.selfCheckNudge(editsMade, cfg.verifyHint);
          log.info("completion self-check fired", { editsMade });
          metrics.increment("agent.self_check", 1);
          const ue: UserEvent = {
            type: "user",
            message: { role: "user", content: note },
            author: SYSTEM,
            ts: now(),
          };
          parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
          yield { ...ue, uuid: parent };
          messages.push({ role: "user", content: note });
          continue;
        }

        // Cross-repo handoff: answer any task requests received this run on their private
        // correlationId channel, so the calling agent (blocked in HandoffTask) unblocks.
        for (const correlationId of owedReplies) {
          await postHandoffReply(this.store, cfg.agentId, correlationId, lastAssistantText);
          log.info("handoff reply sent", { correlationId });
        }
        owedReplies.length = 0;
        await this.store.registry.patchSession(cfg.sessionId, { head: parent, status: "idle" });
        log.info("run done", {
          turns,
          inputTokens: totalUsage.input_tokens,
          outputTokens: totalUsage.output_tokens,
        });
        outcome = "success";
        parent = yield* this.flushSide(this.side.drain(), parent);
        parent = yield* this.finish("success", turns, totalUsage, parent);
        break;
      }

      // Execute tools — read-only calls run concurrently; if any mutates, serialize
      // to preserve ordering and avoid write races. Results persist/yield in order.
      // A tool may classify per CALL (Agent with read_only children can fan out safely).
      metrics.increment("agent.tool_calls", toolUses.length, { model: cfg.model });
      const allReadOnly = toolUses.every((tu) => {
        const tool = cfg.tools.get(tu.name);
        if (!tool) return false;
        return tool.isCallReadOnly?.(tu.input) ?? tool.readOnly;
      });
      const work: Promise<ToolResultEvent[]> =
        allReadOnly && toolUses.length > 1
          ? Promise.all(toolUses.map((tu) => this.executeTool(tu, author, log)))
          : serial(toolUses, (tu) => this.executeTool(tu, author, log));
      // A sub-agent's lifecycle and its forwarded events arrive while the Agent tool blocks;
      // they go out as they happen, not when the tool returns.
      for await (const side of this.side.until(work)) parent = yield* this.flushSide([side], parent);
      const trEvts = await work;

      // Verification signals for the completion self-check and the anti-churn breaker: count
      // successful edits (total and per-file) and note whether a real check command ran.
      if (selfCheckOn || antiChurnOn) {
        for (const tu of toolUses) {
          // Capability tags, not tool names: a profile with a different toolset keeps
          // these signals (name matching silently disabled them for renamed tools).
          const tool = cfg.tools.get(tu.name);
          if (tool?.edits) {
            const r = trEvts.find((e) => e.toolUseId === tu.id);
            if (r && !r.isError) {
              editsMade += 1;
              const path = String((tu.input as { path?: unknown }).path ?? "");
              if (path) editsByFile.set(path, (editsByFile.get(path) ?? 0) + 1);
            }
          } else if (tool?.executes && loop.verifyCommandRe) {
            const cmd = String((tu.input as { command?: unknown }).command ?? "");
            if (loop.verifyCommandRe.test(cmd)) {
              const r = trEvts.find((e) => e.toolUseId === tu.id);
              if (r) verifyRan = true;
              // A check that couldn't actually run (missing deps/interpreter) isn't verification.
              if (r && !(loop.envBrokenRe?.test(r.content) ?? false)) verifyObserved = true;
            }
          }
        }
      }

      // Mid-loop anti-churn breaker: once a single file crosses the edit threshold with no
      // verification in between, inject one nudge to commit-and-stop. Unlike the completion
      // self-check, this fires DURING the loop, so it can interrupt an in-progress doubt spiral.
      let churnNote: string | null = null;
      if (antiChurnOn && !churnFired) {
        for (const [path, n] of editsByFile) {
          if (n >= loop.churnThreshold) {
            churnFired = true;
            churnNote = loop.antiChurnNudge(path, n);
            log.info("anti-churn breaker fired", { path, edits: n });
            metrics.increment("agent.anti_churn", 1);
            break;
          }
        }
      }

      const toolResults: ToolResultBlock[] = [];
      for (const raw of trEvts) {
        const persisted = await this.appendToolResult(raw, parent);
        const trEvt = persisted.event;
        parent = persisted.uuid;
        yield { ...trEvt, uuid: parent };
        toolResults.push({
          type: "tool_result",
          tool_use_id: trEvt.toolUseId,
          content: trEvt.blocks ?? trEvt.content,
          is_error: trEvt.isError,
        });
      }
      // Condense oversized tool outputs (a cheap side-call) before they enter the model's context.
      // The full result was already persisted + yielded above; only the copy the model sees shrinks,
      // saving cost and keeping the main context (and its cache) small. Errors are left intact.
      if (cfg.condense) {
        for (const tr of toolResults) {
          if (!tr.is_error && typeof tr.content === "string" && tr.content.length > cfg.condense.threshold) {
            tr.content = await this.condenseOutput(tr.content, cfg.condense.model, log);
          }
        }
      }
      const turnContent = toolResults as ContentBlock[];
      if (churnNote) turnContent.push({ type: "text", text: churnNote });
      // Interactive steering typed mid-run: fold it into this same user turn so it reaches the model
      // on the very next step (role alternation stays valid — it rides with the tool results, exactly
      // like churnNote). Each steer is also persisted + yielded so the transcript shows what the user
      // injected and a resume replays it; loadMessages folds a user event that trails tool results
      // back into one turn, so live context and reloaded context match.
      if (cfg.drainSteering) {
        for (const raw of cfg.drainSteering()) {
          const steer = raw.trim();
          if (!steer) continue;
          const ue: UserEvent = { type: "user", message: { role: "user", content: steer }, author, ts: now() };
          parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
          yield { ...ue, uuid: parent };
          turnContent.push({ type: "text", text: steer });
          log.info("user steer injected mid-loop");
          metrics.increment("agent.steer", 1, { at: "midloop" });
        }
      }
      // Peer messages that arrived while tools ran: the same fold as steering — a teammate's
      // message reaches the model between tool rounds, not at the end of the run. Correlated
      // handoffs register their owed reply exactly as the finish-boundary drain does.
      if (cfg.enablePeerMessages !== false) {
        const peers = await this.store.mailbox.drain(cfg.sessionId);
        for (const pm of peers) {
          const framed = frameHandoff(pm);
          if (pm.correlationId) owedReplies.push(pm.correlationId);
          const ue: UserEvent = { type: "user", message: { role: "user", content: framed }, author: pm.from, ts: now() };
          parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
          yield { ...ue, uuid: parent };
          turnContent.push({ type: "text", text: framed });
          log.info("peer message injected mid-loop", { from: pm.from.id ?? pm.from.type });
          metrics.increment("agent.peer_messages", 1);
        }
      }
      // Async events that arrived while tools ran: fold the batch into this same turn (rides
      // with the tool results like steering, so no extra message and the cache prefix holds).
      // The model reacts on the very next step — or ignores it and keeps working.
      if (cfg.inbox && cfg.inbox.size() > 0) {
        const events = cfg.inbox.drain();
        const text = renderEvents(events);
        const ue: UserEvent = { type: "user", message: { role: "user", content: text }, author: SYSTEM, ts: now() };
        parent = (await this.store.conversation.append(cfg.sessionId, ue, parent)).uuid;
        yield { ...ue, uuid: parent };
        turnContent.push({ type: "text", text });
        log.info("inbox events injected mid-loop", {
          count: events.length,
          ids: events.map((e) => e.id),
        });
        metrics.increment("agent.inbox_events", events.length, { at: "midloop" });
      }
      messages.push({ role: "user", content: turnContent });
    }
    } catch (e) {
      if (e instanceof SafetyParkSignal) {
        // §10 safety edge hit headless: END the run as needs_approval and hand the pending action
        // to the host (for the hop-run-result-v1 artifact). The finally emits d11.3 needs_approval.
        outcome = "needs_approval";
        log.info("run parked for approval", { reason: e.reason });
        metrics.increment("agent.needs_approval", 1, { reason: e.reason });
        parent = yield* this.finish("needs_approval", turns, totalUsage, parent, { command: e.command, reason: e.reason });
      } else {
        throw e;
      }
    } finally {
      // Finalize on EVERY exit — success, cancel, max-turns, or a thrown model error.
      // Previously only the success branch reset status/head and answered owed handoffs,
      // so a cancelled or errored run left the session advertised "active" forever (a
      // phantom live editor that HandoffTask routing trusts) and left peers blocked in
      // HandoffTask waiting out their full timeout. Idempotent: owedReplies is already
      // empty and the patch already applied on the success path.
      for (const correlationId of owedReplies) {
        await postHandoffReply(this.store, cfg.agentId, correlationId, lastAssistantText).catch(() => {});
      }
      owedReplies.length = 0;
      await this.store.registry.patchSession(cfg.sessionId, { head: parent, status: "idle" }).catch(() => {});
      // Side events raised after the run's last flush (a background child starting while this run
      // finishes) would die in this run's queue: once unsubscribed they go back through the bus,
      // which now finds no running loop, persists the persisted kinds at the head and tells the
      // idle listeners, in the order they arrived.
      unsubscribe?.();
      if (cfg.events) for (const e of this.side.drain()) cfg.events.emit(cfg.sessionId, e);
      // A peer message that arrived after this run's last mailbox read (the window a server's
      // `send` can hit while the loop shuts down) stays in a top-level session's mailbox for its
      // next run or its idle poller. A sub-agent never runs again, so its late mail goes to the
      // session that delegated it, marked as such, instead of waiting forever.
      if (cfg.parent && cfg.enablePeerMessages !== false) {
        const late = await this.store.mailbox.drain(cfg.sessionId).catch(() => []);
        for (const pm of late) {
          await this.store.mailbox
            .post(cfg.parent.sessionId, { ...pm, toSession: cfg.parent.sessionId, text: `[sent to sub-agent ${cfg.sessionId.slice(0, 8)} after it finished] ${pm.text}` })
            .catch(() => undefined);
        }
      }

      // HOP telemetry Capture (D11.2): emit one content-free run-outcome at the finish point.
      // `outcome` is null only when the generator was abandoned before any terminal result — no
      // outcome to report, so skip. Fire-and-forget: never throws, never blocks the caller.
      if (cfg.telemetry && outcome) {
        // A clean finish that parked a question for the person is not a success (F8).
        const recorded: RunResult = outcome === "success" && cfg.telemetry.parked?.() ? "parked" : outcome;
        try {
          cfg.telemetry.emit(
            buildRunOutcome({
              hop: cfg.telemetry.hop,
              repo: cfg.telemetry.repo,
              model: activeModel,
              tier: cfg.telemetry.resolveTier?.(activeModel),
              role: cfg.telemetry.role,
              runId: cfg.sessionId,
              parentRunId: cfg.telemetry.parentRunId,
              memoriesInjected: cfg.telemetry.memoriesInjected?.(),
              memoryProjection: cfg.telemetry.memoryProjection?.(),
              toolCalls,
              labels: providerLabels,
              taskType: cfg.telemetry.taskType ?? loop.taskType,
              sourceRef: cfg.telemetry.sourceRef,
              runResult: recorded,
              failureClass: classifyFailure(recorded, thrownError),
              tokens: {
                input: totalUsage.input_tokens ?? 0,
                output: totalUsage.output_tokens ?? 0,
                cacheRead: totalUsage.cache_read_input_tokens ?? 0,
                cacheCreation: totalUsage.cache_creation_input_tokens ?? 0,
              },
              wallMs: Date.now() - startMs,
              turns,
              checks: {
                selfCheckFired,
                antiChurnFired: churnFired,
                observeRan: verifyRan,
                observePassed: verifyObserved,
                agentVerdict: verifierVerdict,
              },
              occurredAt: now(),
            }),
          );
        } catch (e) {
          log.warn("telemetry emit failed (ignored)", { error: String(e) });
        }
      }
    }
  }

  /**
   * Persistent-worker loop — the missing piece that lets an idle agent pick up cross-repo work.
   * Stays alive, polls this session's mailbox, and processes each incoming handoff/peer message
   * autonomously (as its own run), then reports back on the handoff's private channel. Marks the
   * session `listening` while waiting — a live-routable status (so HandoffTask routes here instead
   * of dispatching a throwaway) heartbeated to keep the freshness guard satisfied — and `active`
   * while processing. Runs until `signal` aborts. Yields the live event stream for observability.
   */
  async *listen(opts: {
    signal: AbortSignal;
    pollMs?: number;
    /** Process the mail already queued (plus any that arrives while processing), then return
     *  instead of waiting — the auto-wake mode: SendMessage to a dead session spawns this. */
    once?: boolean;
  }): AsyncGenerator<EngineEvent, void, void> {
    await this.init();
    const { cfg } = this;
    const pollMs = opts.pollMs ?? 1500;
    const log = (cfg.logger ?? silentLogger).child({
      sessionId: cfg.sessionId,
      agentId: cfg.agentId,
      mode: "listen",
    });
    await this.store.registry.patchSession(cfg.sessionId, { status: "listening" });
    log.info("listening for handoffs");
    let idleSince: number | null = null;
    try {
      while (!opts.signal.aborted) {
        const peers = await this.store.mailbox.drain(cfg.sessionId);
        if (peers.length === 0) {
          if (opts.once) return; // woke, drained, done — the whole point of once
          // TeammateIdle: once per idle stretch, when the worker first finds nothing to do.
          if (!idleSince) {
            idleSince = Date.now();
            if (cfg.hooks?.has("TeammateIdle")) await cfg.hooks.run({ event: "TeammateIdle", idleMs: 0 }, this.hookCtx());
          }
          // Heartbeat: bump updatedAt so HandoffTask's freshness guard keeps seeing us as live.
          await this.store.registry.patchSession(cfg.sessionId, { status: "listening" });
          await interruptibleSleep(pollMs, opts.signal);
          continue;
        }
        idleSince = null;
        for (const pm of peers) {
          // Process each drained message as its own run, seeded from the (framed) message and
          // authored by the sender. A second message arriving mid-run is caught by run()'s own
          // finish-drain, so nothing is lost and this repo never has two concurrent editors.
          let lastText = "";
          for await (const ev of this.run({ text: frameHandoff(pm), author: pm.from })) {
            if (ev.type === "assistant") {
              const c = ev.message.content;
              const t =
                typeof c === "string"
                  ? c
                  : c.map((b) => (b.type === "text" ? b.text : "")).join("");
              if (t.trim()) lastText = t.trim();
            }
            yield ev;
          }
          if (pm.correlationId) {
            await postHandoffReply(this.store, cfg.agentId, pm.correlationId, lastText);
            log.info("handoff reply sent (listen)", { correlationId: pm.correlationId });
          }
        }
        await this.store.registry.patchSession(cfg.sessionId, { status: "listening" });
      }
    } finally {
      await this.store.registry.patchSession(cfg.sessionId, { status: "idle" });
      log.info("listen loop stopped");
    }
  }

  /**
   * Shrink a large tool output with a cheap side-model. Preserves errors and directly-relevant lines
   * verbatim; drops boilerplate/bulk. Fail-safe: on any error returns a head+tail truncation, so a
   * condense failure never loses the whole output or breaks the run.
   */
  private async condenseOutput(text: string, model: string, log: Logger): Promise<string> {
    try {
      const gen = this.cfg.model_client.stream({
        trace: { stamp: this.stamp(), callId: `summarize:${this.compactions + 1}` },
        model,
        system: (this.cfg.loop ?? CODING_PROFILE.loop).condenserSystem,
        messages: [{ role: "user", content: text }],
        maxTokens: 1024,
        signal: this.cfg.signal,
      });
      let r = await gen.next();
      while (!r.done) r = await gen.next();
      const c = r.value.message.content;
      const out = typeof c === "string" ? c : c.map((b) => (b.type === "text" ? b.text : "")).join("");
      if (out.trim()) {
        this.cfg.metrics?.increment("agent.condense", 1);
        return out;
      }
    } catch (e) {
      log.warn("condense failed; truncating", { error: (e as Error).message });
    }
    const half = 4000;
    return `${text.slice(0, half)}\n\n…[${text.length} chars total; middle elided]…\n\n${text.slice(-half)}`;
  }

  /**
   * Summarize older turns for compaction, via the (optionally cheaper) model. Structured
   * sections resume measurably better than freeform prose; the live
   * todo list is appended verbatim afterward — plans are anchor state, never summarized.
   */
  private async summarize(older: Message[], instructions?: string): Promise<string> {
    const { cfg } = this;
    const focus = instructions?.trim()
      ? `\n\nPay special attention to, and preserve in detail: ${instructions.trim()}`
      : "";
    const gen = cfg.model_client.stream({
      model: cfg.compaction?.model ?? cfg.router?.resolve("summarize") ?? cfg.model,
      system: (cfg.loop ?? CODING_PROFILE.loop).summarizerSystem + focus,
      messages: [{ role: "user", content: `Summarize this transcript:\n\n${renderTranscript(older)}` }],
      maxTokens: 1536,
      signal: cfg.signal,
    });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const content = r.value.message.content;
    const text =
      typeof content === "string"
        ? content
        : content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const plan = this.cfg.planSnapshot?.() ?? null;
    return plan ? `${text}\n\n## Current plan (verbatim, resume from here)\n${plan}` : text;
  }

  /**
   * Manually compact the session now (the `/compact` command). Summarizes the whole
   * current context and appends a boundary, so the next turn reloads from the summary.
   * Returns null when there's nothing to compact (already at/near a boundary).
   */
  async compact(instructions?: string): Promise<{ summary: string; replaced: number } | null> {
    await this.init();
    const { cfg } = this;
    const messages = await loadMessages(this.store, cfg.sessionId);
    if (messages.length < 2) return null;
    // The same host seams as an automatic compaction (memory v13 DESIGN §3): the verbatim window
    // goes to PreCompact before it is summarised away, and the context is rebuilt from memory
    // after, as a system-authored turn behind the boundary so the next run loads it.
    if (cfg.hooks?.has("PreCompact")) {
      this.compactions += 1;
      await cfg.hooks.run(
        { event: "PreCompact", trigger: "manual", messageCount: messages.length, transcript: renderTranscript(messages), window: this.compactions },
        this.hookCtx(),
      );
    }
    const summary = await this.summarize(messages, instructions);
    let parent = await this.store.conversation.head(cfg.sessionId);
    const ce = {
      type: "compact" as const,
      summary,
      trigger: "manual" as const,
      replacedMessages: messages.length,
      ts: now(),
    };
    parent = (await this.store.conversation.append(cfg.sessionId, ce, parent)).uuid;
    await this.event("compact", { trigger: "manual", replaced: messages.length, ref: parent });
    if (cfg.hooks?.has("PostCompact")) await cfg.hooks.run({ event: "PostCompact", trigger: "manual", replaced: messages.length, summaryChars: summary.length }, this.hookCtx());
    if (cfg.compaction?.onAfterCompact) {
      const rebuilt = await cfg.compaction.onAfterCompact(summary).catch((e) => {
        (cfg.logger ?? silentLogger).warn("after-compaction memory rebuild failed", { error: String((e as Error)?.message ?? e) });
        return undefined;
      });
      if (rebuilt?.trim()) {
        const ue: UserEvent = { type: "user", message: { role: "user", content: rebuilt }, author: SYSTEM, ts: now() };
        await this.store.conversation.append(cfg.sessionId, ue, parent);
        (cfg.metrics ?? noopMetrics).increment("agent.memory_rebuilds", 1);
      }
    }
    return { summary, replaced: messages.length };
  }

  /** Summary compactions this session (automatic and manual), the PreCompact window ordinal. */
  private compactions = 0;

  private hookCtx(): HookContext {
    return { sessionId: this.cfg.sessionId, agentId: this.cfg.agentId, cwd: this.cfg.cwd, ...(this.currentRun ? { runId: this.currentRun } : {}) };
  }

  /**
   * Tear the session down: fire SessionEnd hooks. The host (CLI/server) calls this when
   * the user exits or clears — the engine can't know when a session is "done" on its own.
   * Idempotent and best-effort; a failing hook never throws to the caller.
   */
  async end(reason: SessionEndInput["reason"] = "exit"): Promise<void> {
    const { cfg } = this;
    if (!cfg.hooks?.has("SessionEnd")) return;
    try {
      await cfg.hooks.run({ event: "SessionEnd", reason }, this.hookCtx());
    } catch {
      // best-effort teardown
    }
  }

  /** The `tool_started` marker, before the tool's effect can happen. `appendEvent` resolves once it is
   *  durable where the backend can resume (the remote store: on its acknowledgement), and a refusal
   *  (a lost lease) throws here, so the tool does not run. */
  private async markStarted(tu: ToolUseBlock): Promise<void> {
    if (!this.store.appendEvent) return;
    // Stamped like every record of the run (the file backend keeps it in the events channel).
    await this.store.appendEvent(this.cfg.sessionId, "tool_started", { ...this.stampFields(), toolUseId: tu.id, name: tu.name, ts: now() });
  }

  /** Persists a tool result. One too large for the session store becomes an error result the model
   *  can act on, persisted in its place; any other failure propagates. */
  private async appendToolResult(trEvt: ToolResultEvent, parent: string | null): Promise<{ event: ToolResultEvent; uuid: string }> {
    try {
      return { event: trEvt, uuid: (await this.store.conversation.append(this.cfg.sessionId, trEvt, parent)).uuid };
    } catch (e) {
      if (!(e instanceof EventTooLargeError)) throw e;
      const mib = (bytes: number) => Number((bytes / 2 ** 20).toFixed(2));
      const event: ToolResultEvent = {
        type: "tool_result",
        toolUseId: trEvt.toolUseId,
        toolName: trEvt.toolName,
        content: `the tool's result of ${mib(e.bytes)} MiB exceeds the session store's event limit of ${mib(e.limit)} MiB; read a smaller range or write it to a file`,
        isError: true,
        ts: now(),
      };
      return { event, uuid: (await this.store.conversation.append(this.cfg.sessionId, event, parent)).uuid };
    }
  }

  /**
   * Continue a turn a dead engine left in flight (plan §5). Nothing in flight (no turn since the last
   * `result` or `error`): returns `{resumed: false}` without a write. Otherwise the head's tool calls
   * without a result are settled first: one with a `tool_started` marker is never run again and gets
   * an `INTERRUPTED_TOOL_RESULT` error result; one without runs now, through the normal path. Then the
   * turn continues from the head (no new user entry) to its result, as `run()` does.
   */
  async *resume(): AsyncGenerator<EngineEvent, { resumed: boolean }, void> {
    const { cfg } = this;
    const entries = effectiveEntries(await this.store.conversation.read(cfg.sessionId));
    let turnStart = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const type = entries[i]!.payload.type;
      if (type === "result" || type === "error") break;
      if (type === "user") turnStart = i;
    }
    if (turnStart < 0) return { resumed: false };

    await this.init();
    const turnEntries = entries.slice(turnStart);
    // The person's turn, not a system-seeded one ahead of it, names the run's author and its task.
    const asked = (turnEntries.find((e) => e.payload.type === "user" && e.payload.author?.type !== "system") ?? turnEntries[0]!).payload as UserEvent;
    const author = asked.author?.type === "system" ? HUMAN : (asked.author ?? HUMAN);
    const content = asked.message.content;
    const task = typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("");
    // The head is the last entry that moves the turn on; a sub-agent's lifecycle entry after it does not.
    const head = [...turnEntries].reverse().find((e) => e.payload.type === "user" || e.payload.type === "assistant" || e.payload.type === "tool_result")!.payload;
    const answered =
      head.type === "assistant" && !(head.message.content as ContentBlock[]).some((b) => b.type === "tool_use")
        ? { model: head.model, message: head.message, usage: head.usage, stopReason: head.stopReason }
        : undefined;
    // The turn's model calls so far, so the resumed run's result counts the whole turn.
    const usage = turnEntries.reduce((u, e) => (e.payload.type === "assistant" ? addUsage(u, e.payload.usage) : u), emptyUsage());
    const unsubscribe = cfg.events?.subscribe(cfg.sessionId, (e) => this.side.push(e));
    const parent = await this.store.conversation.head(cfg.sessionId);
    const runId = crypto.randomUUID();
    this.currentRun = runId;
    const pending = unansweredToolUses(turnEntries);
    yield* this.turn({
      author,
      task,
      parent,
      runId,
      ref: parent,
      unsubscribe,
      resumed: true,
      usage,
      ...(answered ? { answered } : {}),
      ...(pending.length ? { prelude: (log: Logger, at: string | null) => this.settleInterrupted(pending, author, log, at) } : {}),
    });
    return { resumed: true };
  }

  /** The prelude of a resumed turn: a result for each tool call the dead engine left unanswered,
   *  persisted in the call order (one user turn, as after a batch). */
  private async *settleInterrupted(pending: ToolUseBlock[], author: Author, log: Logger, parent: string | null): AsyncGenerator<EngineEvent, string | null, void> {
    const markers = (await this.store.readEvents?.(this.cfg.sessionId, "tool_started")) ?? [];
    const started = new Set(markers.map((m) => m.toolUseId));
    for (const tu of pending) {
      let result: ToolResultEvent;
      if (started.has(tu.id)) {
        log.warn("resume: a started tool is not run again", { tool: tu.name, toolUseId: tu.id });
        result = { type: "tool_result", toolUseId: tu.id, toolName: tu.name, content: INTERRUPTED_TOOL_RESULT, isError: true, ts: now() };
      } else {
        result = await this.executeTool(tu, author, log);
      }
      const persisted = await this.appendToolResult(result, parent);
      parent = persisted.uuid;
      yield { ...persisted.event, uuid: parent };
    }
    return parent;
  }

  private async executeTool(
    tu: ToolUseBlock,
    principal: Author,
    log: Logger,
  ): Promise<ToolResultEvent> {
    const { cfg } = this;
    const make = (
      content: string,
      isError: boolean,
      blocks?: ToolResultBlocks,
      diff?: string,
      decided?: Decision,
      refused?: ModelRefusal,
      sandboxRefused?: SandboxRefusal,
    ): ToolResultEvent => ({
      type: "tool_result",
      toolUseId: tu.id,
      toolName: tu.name,
      content,
      blocks,
      ...(diff ? { diff } : {}),
      ...(refused ? { refusal: refused } : {}),
      ...(sandboxRefused ? { sandboxRefusal: sandboxRefused } : {}),
      ...(decided?.behavior !== "ask" && decided?.judge ? { judged: { verdict: decided.behavior, reason: decided.judge.reason } } : {}),
      isError,
      ts: now(),
    });

    let input = tu.input;

    // PreToolUse hooks: may block or rewrite the tool input.
    if (cfg.hooks?.has("PreToolUse")) {
      const results = await cfg.hooks.run(
        { event: "PreToolUse", toolName: tu.name, input },
        this.hookCtx(),
      );
      const blocker = results.find((r) => r.block);
      if (blocker) {
        log.info("tool blocked by hook", { tool: tu.name, reason: blocker.reason });
        await this.store.logs.write(cfg.sessionId, "exec", {
          ...this.stampFields(),
          tool: tu.name,
          decision: "hook_block",
          isError: true,
        });
        return make(`Blocked by hook: ${blocker.reason ?? "denied"}`, true);
      }
      for (const r of results) if (r.updatedInput) input = r.updatedInput;
    }

    // resolve() lets tools that register asynchronously (MCP servers still connecting)
    // satisfy the call — the permission check below needs the real readOnly/edits flags.
    const tool = await cfg.tools.resolve(tu.name);
    const permReq: PermissionRequest = {
      toolName: tu.name,
      input,
      readOnly: tool?.readOnly ?? false,
      isEdit: tool?.edits ?? false,
      isMemory: tool?.memory ?? false,
      principal,
    };
    const { decision, via } = await this.resolve(permReq);
    const toolStartMs = Date.now();

    let raw: string | ToolResultBlocks;
    let isError: boolean;
    let diff: string | undefined;
    let refusal: ModelRefusal | undefined;
    let sandboxRefusal: SandboxRefusal | undefined;
    if (decision.behavior === "deny") {
      raw = `Permission denied: ${decision.reason ?? "not allowed"}`;
      isError = true;
    } else {
      // The side-effect key (plan §5): a call that may change something is on record, durably,
      // before it runs, so an engine resuming this session never runs it twice.
      if (tool && !(tool.isCallReadOnly?.(input) ?? tool.readOnly)) await this.markStarted(tu);
      // Race the tool against the abort signal: a stuck tool (e.g. a filesystem scan
      // that ignores the signal) must never trap Ctrl-C — control returns immediately
      // and the orphaned promise is dropped.
      const res = await raceAbort(
        runTool(cfg.tools, tu.name, input, {
          cwd: cfg.cwd,
          roots: cfg.roots ?? [cfg.cwd],
          signal: cfg.signal,
          sessionId: cfg.sessionId,
          ...(this.currentRun ? { runId: this.currentRun } : {}),
          exec: cfg.exec,
          toolUseId: tu.id,
          emit: (e) => this.emitSide(e),
        }),
        cfg.signal,
      );
      raw = res.content;
      isError = res.isError ?? false;
      diff = res.meta?.diff;
      refusal = res.meta?.refusal;
      sandboxRefusal = res.meta?.sandboxRefusal;
      // An ALLOWED call is observed only now: a tool's own boundary (roots) can still refuse it,
      // and the trace must record the effective outcome, not the cascade's permission.
      this.observed(
        permReq,
        res.meta?.refused
          ? { behavior: "deny", reason: typeof res.content === "string" ? res.content.split("\n")[0]! : "refused by the tool", source: "tool_boundary" }
          : decision,
        res.meta?.refused ? "tool" : via,
      );
    }

    let display = typeof raw === "string" ? raw : summarizeBlocks(raw);
    const blocks = typeof raw === "string" ? undefined : raw;

    // PostToolUse hooks: observations are appended so the model sees them.
    if (cfg.hooks?.has("PostToolUse")) {
      const results = await cfg.hooks.run(
        { event: "PostToolUse", toolName: tu.name, input, result: display, isError },
        this.hookCtx(),
      );
      const notes = results.map((r) => r.injectContext).filter((n): n is string => Boolean(n));
      if (notes.length) display += `\n\n[hook] ${notes.join("\n")}`;
    }

    log.info("tool", { tool: tu.name, decision: decision.behavior, isError });
    await this.store.logs.write(cfg.sessionId, "exec", {
      ...this.stampFields(),
      tool: tu.name,
      decision: decision.behavior,
      isError,
      // Wall time of the tool itself (absent on a denial: nothing ran); the OTLP tool span reads it.
      ...(decision.behavior === "deny" ? {} : { ms: Date.now() - toolStartMs }),
      ...(diff ? { diff: diffStat(diff) } : {}),
    });

    return make(display, isError, blocks, diff, decision, refusal, sandboxRefusal);
  }

  /** Resolve the permission decision. Denials and parks are observed here; an ALLOW is observed by
   *  the caller after the tool ran, so a tool-boundary refusal can turn it into the effective deny. */
  private async resolve(req: PermissionRequest): Promise<{ decision: Decision; via: DecisionVia }> {
    const d = await this.cfg.canUseTool(req);
    if (d.behavior !== "ask") return { decision: d.behavior === "allow" ? d : this.observed(req, d, "policy"), via: "policy" };
    // PermissionRequest: a hook may answer in the person's place (the first answer wins);
    // no answer means the ask proceeds exactly as before.
    if (this.cfg.hooks?.has("PermissionRequest")) {
      const results = await this.cfg.hooks.run({ event: "PermissionRequest", toolName: req.toolName, input: req.input, ...(d.reason ? { reason: d.reason } : {}), ...(d.safetyReason ? { safetyReason: d.safetyReason } : {}) }, this.hookCtx());
      const answer = results.find((r) => r.decision);
      if (answer?.decision) {
        const decided: Decision = answer.decision === "allow" ? { behavior: "allow" } : { behavior: "deny", reason: answer.reason ?? "denied by hook" };
        return { decision: decided.behavior === "allow" ? decided : this.observed(req, decided, "policy"), via: "policy" };
      }
    }
    if (this.cfg.onAsk) {
      // null = "no answer from this answerer" (a policy file with no matching rule): fall through
      // to the headless handling below, exactly as if no answerer were installed.
      const answered = await this.cfg.onAsk(req, { reason: d.reason, safetyReason: d.safetyReason });
      if (answered) {
        return { decision: answered.behavior === "allow" ? answered : this.observed(req, answered, "interactive"), via: "interactive" };
      }
    }
    // A §10 safety edge with no interactive answerer: park the whole run (stop-and-wait) instead of
    // denying just this action and continuing — the infra HOP must not proceed past the edge.
    if (d.safetyReason && this.cfg.parkHeadless) {
      this.observed(req, d, "headless_park");
      throw new SafetyParkSignal(String(req.input.command ?? req.input.path ?? ""), d.safetyReason);
    }
    return {
      decision: this.observed(req, { behavior: "deny", reason: "approval required but running non-interactively", source: "mode" }, "headless_refused"),
      via: "headless_refused",
    };
  }

  private observed(req: PermissionRequest, decision: Decision, via: DecisionVia): Decision {
    try {
      this.cfg.onDecision?.(req, decision, via);
    } catch {
      // the trace is for grading; a failing observer must never affect the gate
    }
    return decision;
  }

  /** End the run: the result is persisted at the conversation head (a replay then carries run
   *  boundaries and usage), the session's head moves to it, and it is yielded with its uuid. */
  private async *finish(
    subtype: "success" | "error" | "max_turns" | "cancelled" | "needs_approval",
    numTurns: number,
    usage: Usage,
    parent: string | null,
    pendingApproval?: { command: string; reason: string },
    refusal?: ModelRefusal,
    sandboxRefusal?: SandboxRefusal,
  ): AsyncGenerator<EngineEvent, string | null, void> {
    const base = this.result(subtype, numTurns, usage, pendingApproval);
    if (base.type !== "result") return parent;
    const ev: ResultEvent = refusal
      ? { ...base, reason: refusal.message, refusal }
      : sandboxRefusal
        ? { ...base, reason: sandboxRefusal.message, sandboxRefusal }
        : base;
    const entry = await this.store.conversation.append(this.cfg.sessionId, ev, parent);
    await this.store.registry.patchSession(this.cfg.sessionId, { head: entry.uuid }).catch(() => undefined);
    yield { ...ev, uuid: entry.uuid };
    return entry.uuid;
  }

  private result(
    subtype: "success" | "error" | "max_turns" | "cancelled" | "needs_approval",
    numTurns: number,
    usage: Usage,
    pendingApproval?: { command: string; reason: string },
  ): EngineEvent {
    void this.event("run.end", { subtype, turns: numTurns, usage, ...(pendingApproval ? { pending: pendingApproval.reason } : {}) });
    if (subtype !== "success" && this.cfg.hooks?.has("Notification")) {
      const kind = subtype === "needs_approval" ? "needs_approval" : subtype === "max_turns" ? "max_turns" : subtype === "cancelled" ? "cancelled" : "error";
      const message = pendingApproval ? `${pendingApproval.reason}: ${pendingApproval.command}` : `run ended: ${subtype}`;
      void this.cfg.hooks.run({ event: "Notification", kind, message }, this.hookCtx()).catch(() => undefined);
    }
    return { type: "result", subtype, numTurns, usage, ts: now(), ...(pendingApproval ? { pendingApproval } : {}) };
  }

  // ---- telemetry v1: the stamp and the event log ----
  private currentRun: string | null = null;
  private currentPrompt: string | null = null;
  private seq = 0;

  /** The run (turn) in progress, for a host that spawns subagents or writes its own records. */
  runId(): string | null {
    return this.currentRun;
  }

  private stamp(): RunStamp {
    const { cfg } = this;
    return {
      session: cfg.sessionId,
      run: this.currentRun ?? "none",
      ...(this.currentPrompt ? { prompt: this.currentPrompt } : {}),
      ...(cfg.parentRunId ? { parent_run: cfg.parentRunId } : {}),
      ...(cfg.stamp ?? {}),
    };
  }

  /** The stamp plus `seq`, the record's order within its run (per run, so a continued session in
   *  a new process never repeats a number; readers order by (run, seq), runs by their start). */
  private stampFields(): Record<string, string | number> {
    return { ...stampFields(this.stamp()), seq: ++this.seq };
  }

  /** One record in the session's events channel: what the harness did, stamped. Never content. */
  private event(kind: string, fields: Record<string, unknown>): Promise<void> {
    return this.store.logs.write(this.cfg.sessionId, "events", { ...this.stampFields(), kind, ...fields });
  }
}
