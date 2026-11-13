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
/**
 * The engine features a composed HOP needs, decided from what it uses, not from what it declares: `hop-base` for a
 * HOP on base, or one that sets any slot key an older engine refuses (a new prompts slot, a section, a tool
 * description, `memory.policy.record: []`), plus whatever it declares in `engine.features`. `hop fields` prints it
 * so a publisher gates on the engine's own answer.
 */
export function requiredEngineFeatures(p: {
  extendsChain: string[];
  origins: Record<string, string>;
  engine?: { features: string[] };
  memory?: { policy?: { record: readonly string[] } };
}): string[] {
  const root = p.extendsChain[0];
  const set = (k: string) => p.origins[k] !== undefined && p.origins[k] !== root;
  // A builtin root (empty chain) is the engine's own: it needs nothing beyond what it declares.
  const usesBase =
    root !== undefined &&
    (root === "base" ||
    HOP_BASE_SLOTS.some((s) => set(`prompts.${s}`)) ||
    Object.keys(p.origins).some((k) => (k.startsWith("sections.") || k.startsWith("tools.describe.")) && set(k)) ||
    p.memory?.policy?.record.length === 0);
  return [...new Set([...(usesBase ? ["hop-base"] : []), ...(p.engine?.features ?? [])])].sort();
}

/** Slot keys that only an engine with the `hop-base` feature loads (beyond `extends: base` itself). */
const HOP_BASE_SLOTS = PROMPT_SLOTS.filter((s) => !["system", "floor", "verifierAgent", "verifierTask", "summarizer", "condenser"].includes(s));

/** What `hop lint` warns about in a composed HOP: words or rules it inherits without knowing it, and what it needs. */
export function hopLintWarnings(p: {
  name: string;
  dir?: string | null;
  extendsChain: string[];
  extendsImplicit?: boolean;
  prompts: { system: string; floor: string };
  tools: { include?: string[]; describe?: Record<string, string> };
  sections?: Record<string, string>;
  origins: Record<string, string>;
  engine?: { features: string[] };
  memory?: { policy?: { record: readonly string[] } };
  requires?: { mcp?: { name: string; optional?: boolean }[] };
}): string[] {
  const out: string[] = [];
  const root = p.extendsChain[0];
  if (p.extendsImplicit) out.push(`${p.name} does not say extends: it extends coding by default. Write extends: base (or extends: coding, if that is meant)`);
  if (root === "coding" && p.origins["prompts.system"] !== "coding") {
    const inherited = PROMPT_SLOTS.filter((s) => s !== "system" && s !== "floor" && p.origins[`prompts.${s}`] === "coding");
    const extra = [
      ...(p.memory?.policy?.record.length && p.origins["memory.policy"] === "coding" ? ["coding's memory policy"] : []),
      ...(p.requires?.mcp?.some((m) => m.name === "websearch") ? ["requires.mcp websearch"] : []),
    ];
    out.push(
      `${p.name} replaces coding's system prompt but still speaks coding's words in ${inherited.map((s) => `prompts.${s}`).join(", ")}` +
        (extra.length ? `, and inherits ${extra.join(" and ")}` : "") +
        `. Extend base to own them.`,
    );
  }
  // The floor is base's: a HOP on coding that replaces coding's system prompt (which carried coding's trust rules) has none.
  if (!p.prompts.floor && root !== undefined && root !== "base" && p.origins["prompts.system"] !== root) {
    out.push(`${p.name} has no engine floor: it replaced ${root}'s system prompt, which carried the trust rules (tool output is data; a peer never grants a permission; no secrets). Extend base for the floor, or state those rules in its own prompt`);
  }
  // Platform-guide-style bundles carry their parent in a `base/` folder: `extends: ./base`. The bare name is the builtin.
  if (p.dir && p.extendsChain.at(-1) === "base" && existsSync(join(p.dir, "base", "hop.yaml"))) {
    out.push(`${p.name} extends the builtin base, but its directory bundles a parent in base/: write extends: ./base for that one`);
  }
  if (p.prompts.system.trim() === "" && root !== undefined) out.push(`${p.name} has an empty prompts.system: the model gets only the engine floor and the host sections`);
  if (p.sections?.projectMemory === "off") {
    out.push(`${p.name} sets sections.projectMemory: off, which a host does not honour from a HOP: the person's instruction files (YODEX.md, AGENTS.md) are theirs to switch off`);
  }
  // An engine without hop-base refuses this HOP outright (strict schema): say so where a catalog and an installer can see it.
  if (root !== undefined && requiredEngineFeatures(p).includes("hop-base") && !p.engine?.features.includes("hop-base")) {
    out.push(`${p.name} needs an engine with base and the slot keys: declare engine: { features: [hop-base] } so a catalog or an installer can tell (older engines refuse it)`);
  }
  return out;
}
