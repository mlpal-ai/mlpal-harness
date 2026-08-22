import { z } from "zod";
import { defineTool } from "../types";

/**
 * ExitPlanMode — the signal that a read-only planning phase is done. The agent, while in a
 * read-only mode (recon), researches the task, then calls this with its implementation plan.
 * The host surfaces the plan for approval and, on yes, switches to an editing mode and lets
 * the agent implement it. readOnly so it never trips the permission gate; the plan is the
 * whole payload.
 */
export const exitPlanModeTool = defineTool({
  name: "ExitPlanMode",
  description:
    "Call this ONLY when you are in read-only planning mode and have finished researching: present your implementation plan (in `plan`, as markdown) for the user to approve BEFORE making any changes. Do NOT use it for trivial edits, for questions, or when you are already in an editing mode — just do the work in those cases.",
  readOnly: true,
  schema: z.object({
    plan: z.string().describe("the implementation plan to run past the user, in concise markdown"),
  }),
  async call(input) {
    return { content: `[plan ready for approval]\n\n${input.plan}` };
  },
});
