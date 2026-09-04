import { z } from "zod";
import { defineTool, type Tool } from "../tools/types";
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
    /** Restrict the child to read-only tools (safe parallel fan-out; also implied by
     *  background). The host applies the same registry filter it uses for background. */
    readOnly?: boolean;
    /** Mid-run guidance for the child, drained by its loop at tool-step boundaries. */
    drainSteering?: () => string[];
  },
  signal?: AbortSignal,
) => Promise<{ text: string; sessionId: string }>;

export function createTaskTool(
  run: SubagentRun,
  agents: AgentDef[] = [],
  background: BackgroundAgents = backgroundAgents,
): Tool<{ description: string; prompt: string; agent?: string; model?: string; run_in_background?: boolean; read_only?: boolean }> {
  const catalog = agents.length
    ? ` Specialized agents available via \`agent\`: ${agents.map((a) => `${a.name} (${a.description})`).join("; ")}.`
    : "";
  return defineTool({
    name: "Agent",
    description:
      "Delegate a focused, self-contained subtask to a sub-agent that works autonomously and returns a result. Use it for well-scoped or parallelizable work (research a question, implement a contained piece). Put COMPLETE instructions in `prompt` — the sub-agent does not see this conversation. It has the same tools but cannot spawn further sub-agents. `model` runs it on any gateway-served model (tier alias or id) — the way to get another model's take on something. Set run_in_background to start it detached and keep working: it runs READ-ONLY (research/verification/analysis, no edits) and its result is delivered to you when it finishes — check with AgentOutput, stop with Kill." +
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
      if (input.run_in_background) {
        // Detached: use the task's OWN signal (not ctx.signal, which dies when this turn ends), so
        // the child outlives the turn and reports back later. Its mid-run statuses flow back as
        // throttled progress events keyed to this task id.
        const task = background.start(input.description, (signal) =>
          run(
            {
              description: input.description,
              callerSessionId: ctx.sessionId,
              prompt: input.prompt,
              agent: input.agent,
              model: input.model,
              background: true,
              onProgress: (status) => background.reportProgress(task.id, status),
              onUsage: (tok, model) => background.reportUsage(task.id, tok, model),
              onSessionId: (sid) => {
                task.sessionId = sid;
              },
              drainSteering: () => task.steerQueue.splice(0),
            },
            signal,
          ).then((r) => {
            task.sessionId ??= r.sessionId;
            return r.text;
          }),
        );
        task.agent = input.agent;
        task.prompt = input.prompt;
        return {
          content:
            `Started background agent ${task.id}: "${input.description}". It runs read-only alongside you; ` +
            `its result will be delivered when it finishes. Check with AgentOutput(id="${task.id}") or ` +
            `stop it with Kill(id="${task.id}").`,
        };
      }
      // Foreground (blocking/parallel) children register too, so the agents panel shows
      // every running sub-agent — peek/steer/kill work the same; only delivery differs
      // (the result returns inline here instead of via the inbox).
      const task = background.track(input.description);
      task.agent = input.agent;
      task.prompt = input.prompt;
      const signal =
        ctx.signal && typeof AbortSignal.any === "function"
          ? AbortSignal.any([ctx.signal, task.abort.signal])
          : (ctx.signal ?? task.abort.signal);
      try {
        const { text } = await run(
          {
            description: input.description,
            callerSessionId: ctx.sessionId,
            prompt: input.prompt,
            agent: input.agent,
            model: input.model,
            readOnly: input.read_only,
            onUsage: (tok, model) => background.reportUsage(task.id, tok, model),
            onSessionId: (sid) => {
              task.sessionId = sid;
            },
            drainSteering: () => task.steerQueue.splice(0),
          },
          signal,
        );
        if (task.status === "running") {
          task.status = "done";
          task.result = text;
          task.endedAt = Date.now();
        }
        return { content: text || "(sub-agent returned no output)" };
      } catch (e) {
        if (task.status === "running") {
          task.status = "failed";
          task.error = e instanceof Error ? e.message : String(e);
          task.endedAt = Date.now();
        }
        throw e;
      }
    },
  });
}

/** Read a background sub-agent task's status, and its full result once it has finished. */
export const agentOutputTool = defineTool({
  name: "AgentOutput",
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
      return { content: `[${t.id} finished] ${t.description}\n${t.result || "(no output)"}` };
    }
    if (t.status === "cancelled") return { content: `[${t.id} cancelled] ${t.description}` };
    return { content: `[${t.id} failed] ${t.description}: ${t.error ?? "unknown error"}`, isError: true };
  },
});
