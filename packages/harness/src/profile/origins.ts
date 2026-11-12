import { existsSync } from "node:fs";
import { join } from "node:path";
import { SECTION_NAMES } from "./types";

/**
 * Every prompt slot a HOP owns, by its YAML name under `prompts:` (`verifierTask` is set by
 * `verification.agent.task`; `floor` is set only by a builtin root). Provenance (`Profile.origins`)
 * is keyed `prompts.<slot>`, `sections.<name>` and `tools.describe.<Tool>`.
 */
export const PROMPT_SLOTS = [
  "system",
  "floor",
  "verifierAgent",
  "verifierTask",
  "summarizer",
  "condenser",
  "classifier",
  "selfCheck",
  "antiChurn",
  "checkpoint",
  "watcher",
  "aside",
  "suggest",
  "askModel",
  "askModelContext",
  "recap",
  "handoff",
  "disclose",
] as const;
export type PromptSlot = (typeof PROMPT_SLOTS)[number];

/** A builtin root's provenance: it set every slot and section itself (a root with a memory policy adds `memory.policy`). */
export function rootOrigins(name: string, describe: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries([
    ...PROMPT_SLOTS.map((s) => [`prompts.${s}`, name]),
    ...SECTION_NAMES.map((s) => [`sections.${s}`, name]),
    ...Object.keys(describe).map((t) => [`tools.describe.${t}`, name]),
  ]);
}

/** What `hop lint` warns about in a composed HOP: words or rules it inherits without knowing it. */
export function hopLintWarnings(p: {
  name: string;
  dir?: string | null;
  extendsChain: string[];
  prompts: { system: string };
  tools: { include?: string[]; describe?: Record<string, string> };
  origins: Record<string, string>;
  memory?: { policy?: { record: readonly string[] } };
  requires?: { mcp?: { name: string; optional?: boolean }[] };
}): string[] {
  const out: string[] = [];
  const root = p.extendsChain[0];
  if (root === "coding" && p.origins["prompts.system"] !== "coding") {
    // floor is "" under coding: nothing is said there, which the last clause reports.
    const inherited = PROMPT_SLOTS.filter((s) => s !== "system" && s !== "floor" && p.origins[`prompts.${s}`] === "coding");
    const extra = [
      ...(p.memory?.policy?.record.length && p.origins["memory.policy"] === "coding" ? ["coding's memory policy"] : []),
      ...(p.requires?.mcp?.some((m) => m.name === "websearch") ? ["requires.mcp websearch"] : []),
    ];
    out.push(
      `${p.name} replaces coding's system prompt but still speaks coding's words in ${inherited.map((s) => `prompts.${s}`).join(", ")}` +
        (extra.length ? `, and inherits ${extra.join(" and ")}` : "") +
        `; it also has no engine floor. Extend base to own them.`,
    );
  }
  // Platform-guide-style bundles carry their parent in a `base/` folder: `extends: ./base`. The bare name is the builtin.
  if (p.dir && p.extendsChain.at(-1) === "base" && existsSync(join(p.dir, "base", "hop.yaml"))) {
    out.push(`${p.name} extends the builtin base, but its directory bundles a parent in base/: write extends: ./base for that one`);
  }
  if (p.prompts.system.trim() === "" && root !== undefined) out.push(`${p.name} has an empty prompts.system: the model gets only the engine floor and the host sections`);
  if (root !== undefined && p.tools.include && p.tools.describe) {
    const unused = Object.keys(p.tools.describe).filter((t) => !p.tools.include!.includes(t) && p.origins[`tools.describe.${t}`] === p.name);
    if (unused.length) out.push(`tools.describe names ${unused.join(", ")}, which tools.include leaves out`);
  }
  return out;
}
