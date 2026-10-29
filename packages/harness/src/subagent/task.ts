import { z } from "zod";
import type { HookEngine } from "../hooks/engine";
import type { EngineEvent, SubagentEvent } from "@mlpal/harness-protocol";
import { frameSubagentResult } from "../input/sanitize";
import { ModelAccessError } from "../profile/model-policy";
import { defineTool, type Tool, type ToolContext } from "../tools/types";
import type { AgentDef } from "./agents";
import { type BackgroundAgents, backgroundAgents } from "./background";

/**
 * Sub-agents: the Task tool delegates a focused, self-contained subtask to a child
 * agent that works autonomously with its own context and returns a result. The runner
 * (which actually spawns the child session) is injected by the host, so the engine
 * stays decoupled. Children run without the Task tool, so they cannot recurse. The
 * child's transcript is a first-class session in the store — observable like any other
 * (ties into inter-agent collaboration). Custom agent definitions (loadAgents) give the
 * child a specialized system prompt, and optionally a model + tool allowlist. See docs/05 §6.
 */
export type SubagentRun = (
  args: {
    description: string;
    prompt: string;
    agent?: string;
    /** The session whose Task call spawned this child (telemetry `parent_run_id`); absent when the
     *  tool context carries no session id. */
    callerSessionId?: string;
    /** The caller's run (turn) at the time of the Task call (telemetry v1 `parent_run`). */
    callerRunId?: string;
    /** The caller's `Agent` tool_use id: the child's session record names it as its parent step. */
    callerToolUseId?: string;
    /** Pin the child to a specific gateway-served model or tier alias (cheap|mid|frontier|max).
     *  The gateway is a multi-model surface: consulting a different provider's model is a
     *  delegation, never a hand-rolled API call. */
    model?: string;
    background?: boolean;
    /** Mid-run status callback (background children): compact one-liners like "turn 3 · Read src/x.ts". */
    onProgress?: (status: string) => void;
    /** Per-model-call usage callback (background children): output tokens + the routed model. */
    onUsage?: (outputTokens: number, model?: string) => void;
    /** The child's session id, reported the moment it's minted (before any model call) —
     *  lets a live viewer (agents panel peek) start tailing the transcript immediately. */
    onSessionId?: (sessionId: string) => void;
    /** Every event of the child's own stream, as it happens — forwarded onto the parent's
     *  stream tagged with the child's session id. */
    onEvent?: (event: EngineEvent) => void;
    /** Restrict the child to read-only tools (safe parallel fan-out; also implied by
     *  background). The host applies the same registry filter it uses for background. */
    readOnly?: boolean;
    /** Mid-run guidance for the child, drained by its loop at tool-step boundaries. */
    drainSteering?: () => string[];
    /** "worktree": the host runs the child in its own git worktree on its own branch, so it may
     *  edit even in the background — its changes come back committed on that branch. */
    isolation?: "worktree";
  },
  signal?: AbortSignal,
) => Promise<{ text: string; sessionId: string }>;

/**
 * The child's lifecycle on the parent's stream, through the tool context's `emit`. `start` waits
 * for the child's session id (the host reports it the moment it is minted); `end` fires once,
 * with the outcome, even for a child killed mid-run. Nothing is emitted when the host carries no
 * stream (`emit` absent).
 */
function lifecycle(ctx: ToolContext, description: string, background: boolean) {
  let sid: string | undefined;
  let model: string | undefined;
  let ended = false;
  const base = (): Omit<SubagentEvent, "kind" | "ts"> => ({ type: "subagent", toolUseId: ctx.toolUseId ?? "", childSessionId: sid ?? "", description, ...(model ? { model } : {}), background });
  const ts = () => new Date().toISOString();
  return {
    started(id: string) {
      sid = id;
      ctx.emit?.({ ...base(), kind: "start", ts: ts() });
    },
    progress(status: string) {
      if (sid) ctx.emit?.({ ...base(), kind: "progress", status, ts: ts() });
    },
    model(m?: string) {
      if (m) model = m;
    },
    event(event: EngineEvent) {
      if (sid) ctx.emit?.({ type: "subagent_event", childSessionId: sid, event });
    },
    ended(outcome: NonNullable<SubagentEvent["outcome"]>, fallbackSid?: string) {
      if (ended) return;
      ended = true;
      sid ??= fallbackSid;
      if (!sid) return;
      ctx.emit?.({ ...base(), kind: "end", outcome, ts: ts() });
    },
  };
}

export function createTaskTool(
  run: SubagentRun,
  agents: AgentDef[] = [],
  background: BackgroundAgents = backgroundAgents,
  opts: { hooks?: HookEngine } = {},
): Tool<{ description: string; prompt: string; agent?: string; model?: string; run_in_background?: boolean; read_only?: boolean; isolation?: "worktree" }> {
  const catalog = agents.length
    ? ` Specialized agents available via \`agent\`: ${agents.map((a) => `${a.name} (${a.description})`).join("; ")}.`
    : "";
  return defineTool({
    name: "Agent",
    hands: "pure",
    description:
      "Delegate a focused, self-contained subtask to a sub-agent that works autonomously and returns a result. Use it for well-scoped or parallelizable work (research a question, implement a contained piece). Put COMPLETE instructions in `prompt` — the sub-agent does not see this conversation. It has the same tools but cannot spawn further sub-agents. `model` runs it on any gateway-served model (tier alias or id) — the way to get another model's take on something. Set run_in_background to start it detached and keep working: it runs READ-ONLY (research/verification/analysis, no edits) unless isolation is \"worktree\", and its result is delivered to you when it finishes — check with AgentOutput, stop with Kill. isolation: \"worktree\" gives the child its own git worktree and branch, so it can edit in parallel with you (and other isolated children) without touching your tree; its changes come back committed on that branch for you to merge or inspect." +
      catalog,
    readOnly: false,
    schema: z.object({
      description: z.string().describe("a 3-5 word task label"),
      prompt: z.string().describe("complete, standalone instructions for the sub-agent"),
      agent: z
        .string()
        .optional()
        .describe("name of a specialized agent definition to run as (omit for the default)"),
      model: z
        .string()
        .optional()
        .describe(
          "run the sub-agent on a specific model: a tier alias (cheap|mid|frontier|max) or any model id the gateway serves, any provider. Use this to consult a DIFFERENT model (second opinion, specialist strengths) — delegate, never hand-roll API calls to the gateway",
        ),
      run_in_background: z
        .boolean()
        .optional()
        .describe("run detached and return immediately (read-only); result delivered on completion"),
      read_only: z
        .boolean()
        .optional()
        .describe(
          "restrict this child to read-only tools. Set it on research/analysis children — a turn of ONLY read_only Agent calls runs them in PARALLEL instead of one after another",
        ),
      isolation: z
        .enum(["worktree"])
        .optional()
        .describe("\"worktree\": run the child in its own git worktree + branch so it may edit in parallel; changes return committed on that branch"),
    }),
    // The concurrency gate asks per call: read-only children can't write, so a batch of
    // them fans out concurrently; any write-capable child serializes the turn as before.
    isCallReadOnly: (input) => {
      const i = input as { read_only?: boolean; run_in_background?: boolean };
      return Boolean(i?.read_only || i?.run_in_background);
    },
    async call(input, ctx) {
      if (input.agent && !agents.some((a) => a.name === input.agent)) {
        const names = agents.map((a) => a.name).join(", ") || "(none)";
        return { content: `Unknown agent "${input.agent}". Available: ${names}`, isError: true };
      }
      const lc = lifecycle(ctx, input.description, Boolean(input.run_in_background));
      if (input.run_in_background) {
        // Detached: use the task's OWN signal (not ctx.signal, which dies when this turn ends), so
        // the child outlives the turn and reports back later. Its mid-run statuses flow back as
        // throttled progress events keyed to this task id.
        if (opts.hooks?.has("SubagentStart")) await opts.hooks.run({ event: "SubagentStart", description: input.description, ...(input.agent ? { agentType: input.agent } : {}), background: true }, { sessionId: ctx.sessionId ?? "", agentId: "", cwd: ctx.cwd, ...(ctx.runId ? { runId: ctx.runId } : {}) });
        const task = background.start(
          input.description,
          (signal) =>
            run(
              {
                description: input.description,
                callerSessionId: ctx.sessionId,
                callerRunId: ctx.runId,
                callerToolUseId: ctx.toolUseId,
                prompt: input.prompt,
                agent: input.agent,
                model: input.model,
                background: true,
                isolation: input.isolation,
                onProgress: (status) => {
                  background.reportProgress(task.id, status);
                  lc.progress(status);
                },
                onUsage: (tok, model) => {
                  background.reportUsage(task.id, tok, model);
                  lc.model(model);
                },
                onSessionId: (sid) => {
                  task.sessionId = sid;
                  lc.started(sid);
                },
                onEvent: (ev) => lc.event(ev),
                drainSteering: () => task.steerQueue.splice(0),
              },
              signal,
            ).then((r) => {
              task.sessionId ??= r.sessionId;
              return r.text;
            }),
          { onEnd: (t) => lc.ended(t.status === "done" ? "success" : t.status === "cancelled" ? "cancelled" : "error", t.sessionId), ownerSessionId: ctx.sessionId },
        );
        task.agent = input.agent;
        task.prompt = input.prompt;
        return {
          content:
            `Started background agent ${task.id}: "${input.description}". It runs ${input.isolation === "worktree" ? "in its own worktree and may edit there" : "read-only"} alongside you; ` +
            `its result will be delivered when it finishes. Check with AgentOutput(id="${task.id}") or ` +
            `stop it with Kill(id="${task.id}").`,
        };
      }
      // Foreground (blocking/parallel) children register too, so the agents panel shows
      // every running sub-agent — peek/steer/kill work the same; only delivery differs
      // (the result returns inline here instead of via the inbox).
      if (opts.hooks?.has("SubagentStart")) await opts.hooks.run({ event: "SubagentStart", description: input.description, ...(input.agent ? { agentType: input.agent } : {}), background: false }, { sessionId: ctx.sessionId ?? "", agentId: "", cwd: ctx.cwd, ...(ctx.runId ? { runId: ctx.runId } : {}) });
      const task = background.track(input.description, ctx.sessionId);
      task.agent = input.agent;
      task.prompt = input.prompt;
      const signal =
        ctx.signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([ctx.signal, task.abort.signal])
          : (ctx.signal ?? task.abort.signal);
      try {
        const { text, sessionId } = await run(
          {
            description: input.description,
            callerSessionId: ctx.sessionId,
            callerRunId: ctx.runId,
            callerToolUseId: ctx.toolUseId,
            prompt: input.prompt,
            agent: input.agent,
            model: input.model,
            readOnly: input.read_only,
            isolation: input.isolation,
            onProgress: (status) => lc.progress(status),
            onUsage: (tok, model) => {
              background.reportUsage(task.id, tok, model);
              lc.model(model);
            },
            onSessionId: (sid) => {
              task.sessionId = sid;
              lc.started(sid);
            },
            onEvent: (ev) => lc.event(ev),
            drainSteering: () => task.steerQueue.splice(0),
          },
          signal,
        );
        if (task.status === "running") {
          task.status = "done";
          task.result = text;
          task.endedAt = Date.now();
        }
        lc.ended(task.status === "cancelled" ? "cancelled" : "success", sessionId);
        return { content: frameSubagentResult(input.description, text) };
      } catch (e) {
        if (task.status === "running") {
          task.status = "failed";
          task.error = e instanceof Error ? e.message : String(e);
          task.endedAt = Date.now();
        }
        lc.ended(task.status === "cancelled" ? "cancelled" : "error");
        // The child named a model the HOP may not use: the step fails typed (ModelRefusal on its
        // tool_result), and the parent model reads why and picks another.
        if (e instanceof ModelAccessError) return { content: e.refusal.message, isError: true, meta: { refusal: e.refusal } };
        throw e;
      }
    },
  });
}

/** Read a background sub-agent task's status, and its full result once it has finished. */
export const agentOutputTool = defineTool({
  name: "AgentOutput",
  hands: "pure",
  description:
    "Check a background sub-agent started by Agent(run_in_background). Returns its status while running, and its full result once finished. The result is also delivered to you automatically on completion, so you don't have to poll — use this only when you want it sooner.",
  readOnly: true,
  schema: z.object({ id: z.string().describe('agent id from Agent, e.g. "agent1"') }),
  async call(input) {
    const t = backgroundAgents.get(input.id);
    if (!t) return { content: `no background agent "${input.id}"`, isError: true };
    if (t.status === "running") {
      return { content: `[${t.id} running (${Math.round((Date.now() - t.startedAt) / 1000)}s)] ${t.description}` };
    }
    if (t.status === "done") {
      return { content: `[${t.id} finished]\n${frameSubagentResult(t.description, t.result ?? "")}` };
    }
    if (t.status === "cancelled") return { content: `[${t.id} cancelled] ${t.description}` };
    return { content: `[${t.id} failed] ${t.description}: ${t.error ?? "unknown error"}`, isError: true, ...(t.refusal ? { meta: { refusal: t.refusal } } : {}) };
  },
});
