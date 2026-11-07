import { CODING_MEMORIZE_ALONE, CODING_MEMORIZE_HABIT, CODING_MEMORIZE_SCOPE_NOTE, CODING_PERSON_PREFERENCE_HABIT, CODING_RUNG_MEMORY_PROMPT } from "../profile/builtins/coding";
import { MEMORIZE_UPDATE_HINT } from "./derived";

/** What the work-memory module tells the model to call: it is true of a session only when all of them are there. */
const WORK_MEMORY_TOOLS = ["memory_notes", "memory_answer", "memory_search", "memory_write", "memory_checkpoint", "memory_resolve", "memory_retract"];
/** The module's section of a composed system prompt: it runs to the next module or the end. */
const WORK_MEMORY_MODULE = /\n*<!-- module: work-memory -->\n[\s\S]*?(?=\n*<!-- module: |$)/;
const MEMORY_TOOL_NAME = /\b(?:memory_(?:notes|answer|search|write|checkpoint|resolve|retract)|Memorize)\b/g;

/** Whether a session has a memory tool, by its bare name (`Memorize`, `memory_write`). */
export type HasMemoryTool = (name: string) => boolean;

/**
 * The prompt as it is true of one session: the host's sentences about memory tools the session does not have are taken
 * out. Which tools a session has is known only at session build (the memory server, the grant and `tools.include` all
 * move it), so the HOP's prompt cannot say. Every tool present returns the prompt unchanged. Text a HOP wrote itself is
 * not edited: `memoryToolsNamed` is how a host finds it.
 */
export function fitPromptToMemoryTools(prompt: string, has: HasMemoryTool): string {
  let out = prompt;
  if (!WORK_MEMORY_TOOLS.every(has)) {
    const rung = has("memory_checkpoint") && has("memory_search");
    out = out.replace(WORK_MEMORY_MODULE, () => (rung ? `\n\n<!-- module: work-memory -->\n${CODING_RUNG_MEMORY_PROMPT}` : ""));
  }
  if (!has("memory_write")) out = out.replace(`${CODING_PERSON_PREFERENCE_HABIT}\n`, "");
  if (!has("Memorize")) out = out.replace(`${CODING_MEMORIZE_HABIT}\n`, "").replace(CODING_MEMORIZE_ALONE, "").replace(CODING_MEMORIZE_SCOPE_NOTE, "").replace(MEMORIZE_UPDATE_HINT, "");
  return out;
}

/** The memory tools a prompt names, each once. */
export function memoryToolsNamed(prompt: string): string[] {
  return [...new Set(prompt.match(MEMORY_TOOL_NAME))];
}
