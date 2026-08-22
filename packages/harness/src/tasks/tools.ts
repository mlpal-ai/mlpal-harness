import { z } from "zod";
import { defineTool, type Tool } from "../tools/types";
import type { TaskStore } from "./tracker";

/**
 * The plan tools: TaskCreate / TaskUpdate / TaskList over the persistent TaskStore.
 * Stable ids mean the model updates ONE task ("mark #3 completed") instead of rewriting
 * the whole list each call — cheaper, less error-prone, and the plan survives restarts.
 * Session scoping is free: the tools read ToolContext.sessionId.
 */
const status = z.enum(["pending", "in_progress", "completed"]);

/** Models sometimes send ids as "3" or "#3"; repair instead of burning a retry. */
const idField = z.preprocess((v) => {
  if (typeof v === "string") {
    const n = Number(v.replace(/^#/, ""));
    if (Number.isFinite(n)) return n;
  }
  return v;
}, z.number().int().positive()) as unknown as z.ZodType<number>;

const SID_FALLBACK = "default";

export function createTaskTools(store: TaskStore): Tool<never>[] {
  const taskCreate = defineTool({
    name: "TaskCreate",
    description:
      "Add a task to the persistent plan. Returns its stable #id — update it later with TaskUpdate. Use for multi-step work so progress stays visible (and survives restarts); skip for trivial single-step requests. Keep exactly one task in_progress at a time.",
    readOnly: true,
    schema: z.object({
      subject: z.string().min(1).describe("short imperative title, a few words"),
      description: z.string().optional().describe("context the task needs when read later (optional)"),
      status: status.optional().describe("initial status (default pending)"),
    }),
    async call(input, ctx) {
      const tracker = store.for(ctx.sessionId ?? SID_FALLBACK);
      const item = tracker.create(input);
      return { content: `#${item.id} created: ${item.subject}. ${tracker.summary()}.` };
    },
  });

  const taskUpdate = defineTool({
    name: "TaskUpdate",
    description:
      'Update one task by its #id — set status ("mark #3 completed"), or revise subject/description. Move the next task to in_progress as you finish the current one.',
    readOnly: true,
    schema: z.object({
      id: idField.describe("the task's #id from TaskCreate/TaskList"),
      status: status.optional(),
      subject: z.string().min(1).optional(),
      description: z.string().optional(),
    }),
    async call(input, ctx) {
      const tracker = store.for(ctx.sessionId ?? SID_FALLBACK);
      const { id, ...patch } = input;
      const item = tracker.update(id, patch);
      if (!item) {
        const ids = tracker.list().map((t) => `#${t.id}`).join(", ") || "(none)";
        return { content: `No task #${id}. Existing: ${ids}.`, isError: true };
      }
      return { content: `#${item.id} → ${item.status}: ${item.subject}. ${tracker.summary()}.` };
    },
  });

  const taskList = defineTool({
    name: "TaskList",
    description: "The current plan: every task with its #id, status, and description.",
    readOnly: true,
    schema: z.object({}),
    async call(_input, ctx) {
      const tracker = store.for(ctx.sessionId ?? SID_FALLBACK);
      const snap = tracker.snapshot();
      return { content: snap ?? "No tasks yet — TaskCreate starts the plan." };
    },
  });

  return [taskCreate, taskUpdate, taskList] as Tool<never>[];
}
