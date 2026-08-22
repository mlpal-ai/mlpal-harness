import { z } from "zod";
import { defineTool, type Tool } from "../tools/types";
import { host } from "../host";

/**
 * The Workflow tool lets the agent invoke a named, pre-defined workflow (from .yodex/workflows/)
 * mid-task — deterministic multi-agent orchestration on demand. Running an actual workflow is
 * injected by the host (it needs the CLI's session machinery), the same seam the Task tool uses.
 * Only NAMED workflows run — never arbitrary agent-authored code — so this can't become a hole.
 */
export interface WorkflowInfo {
  name: string;
  description: string;
}

export type WorkflowRunner = (
  name: string,
  args: unknown,
  background?: boolean,
) => Promise<{ result?: unknown; agents?: number; taskId?: string }>;

export function createWorkflowTool(
  run: WorkflowRunner,
  catalog: WorkflowInfo[],
): Tool<{ name: string; args?: unknown }> {
  const list = catalog.length
    ? catalog.map((w) => `${w.name}${w.description ? ` (${w.description})` : ""}`).join("; ")
    : "(none defined yet)";
  return defineTool({
    name: "Workflow",
    description:
      "Run a named multi-agent workflow — deterministic orchestration that fans sub-agents across a " +
      "task and returns a combined result. Use for exhaustive or parallelizable work (broad review, " +
      "migration, research sweeps) where structured decomposition beats doing it inline. Workflows are " +
      `defined in ${host().configDirName}/workflows/. Available: ${list}.`,
    readOnly: false,
    schema: z.object({
      name: z.string().describe("the workflow to run"),
      args: z.unknown().optional().describe("a JSON value passed to the workflow as `args`"),
      background: z
        .boolean()
        .optional()
        .describe("run detached and return a task id immediately; read its result later with BashOutput"),
    }),
    async call(input) {
      if (!catalog.some((w) => w.name === input.name)) {
        return {
          content: `Unknown workflow "${input.name}". Available: ${catalog.map((w) => w.name).join(", ") || "(none)"}`,
          isError: true,
        };
      }
      const { result, agents, taskId } = await run(input.name, input.args, input.background);
      if (taskId) {
        return {
          content: `Started workflow "${input.name}" in the background as task ${taskId}. Keep working; read its result with BashOutput(${taskId}) or stop it with Kill(${taskId}).`,
        };
      }
      const body = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: `Workflow "${input.name}" completed (${agents} sub-agent${agents === 1 ? "" : "s"}).\n\n${body}` };
    },
  });
}
