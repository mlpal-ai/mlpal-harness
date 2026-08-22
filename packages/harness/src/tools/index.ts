import { bashOutputTool, bashTool, killTool } from "./builtin/bash";
import { editTool, readTool, writeTool } from "./builtin/files";
import { exitPlanModeTool } from "./builtin/plan";
import { globTool, grepTool, listTool } from "./builtin/search";
import { webFetchTool } from "./builtin/web";
import { ToolRegistry } from "./registry";
import type { Tool } from "./types";

export * from "./types";
export * from "./registry";
export { backgroundTasks } from "./builtin/background";
export { monitorTool, setMonitorLimit } from "./builtin/bash";
export {
  createAskUserQuestionTool,
  formatOutcome,
  type AskAnswer,
  type AskOption,
  type AskOutcome,
  type AskQuestion,
  type PresentQuestions,
} from "./builtin/ask";

export const BUILTIN_TOOLS: Tool<unknown>[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  listTool,
  webFetchTool,
  bashOutputTool,
  killTool,
  exitPlanModeTool,
] as Tool<unknown>[];

export function defaultRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of BUILTIN_TOOLS) r.register(t);
  return r;
}
