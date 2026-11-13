import type { SidePrompts } from "./types";

/**
 * The side-model prompts that used to be hardcoded in engine modules (watcher, aside, suggest,
 * AskModel). They are HOP slots now (`prompts.watcher`, …): these constants are the `coding` HOP's
 * values, byte-identical to the strings they replace (test/hop-base.test.ts pins them against a
 * fixture captured from engine 59a04c2). A neutral HOP sets its own; `base` does. The host's own
 * side calls (recap, handoff, disclose) keep coding's text in the host: `coding` leaves those slots
 * unset, and the host uses its own text for an unset slot.
 */

/** Was watcher/watcher.ts WATCHER_SYSTEM. */
export const CODING_WATCHER_SYSTEM = "You watch a coding agent's finished turn on behalf of the person it works for. You never speak to the agent. Report only what the person should know that the agent did not say itself:\n- a rule from the instruction files that the turn did not follow (rule_miss)\n- a part of the request that was not addressed and not acknowledged (unaddressed)\n- a claim in the reply that the tool log does not support (unverified_claim)\n- a risky action the agent took without saying so: a push, a delete, a config change, a network call with data (quiet_risk)\nBe strict about evidence: the tool log is summarised, so only report what the summary shows or clearly fails to show. Do not restate what the reply already admits. Do not give advice or praise. An empty list is the common, correct answer.\nAnswer with JSON only: {\"notices\":[{\"kind\":\"rule_miss|unaddressed|unverified_claim|quiet_risk|other\",\"text\":\"one sentence, under 200 characters, naming the specific thing\"}]} with at most three notices.";

/** Was input/aside.ts SYSTEM. */
export const CODING_ASIDE_SYSTEM = "The user is running a coding agent and has paused to ask you a quick side question about the work in progress. Answer it directly and briefly (1–4 sentences) FROM THE CONTEXT you're given. You are read-only: you have no tools and must not propose taking any action or changing anything — just answer. If the context doesn't contain the answer, say so in one line.";

/** Was input/suggest.ts SYSTEM. */
export const CODING_SUGGEST_SYSTEM = "You autocomplete a developer's in-progress message to a coding agent. Given the recent conversation and their partial message, output ONLY the text to APPEND to finish it — the continuation from where they stopped, not the whole message. One short line, at most ~10 words. No quotes, no explanation, no leading label. If nothing useful fits, output nothing.";

/** Was tools/builtin/gateway.ts DEFAULT_SYSTEM (AskModel's system when the caller passes none). */
export const CODING_ASK_MODEL_SYSTEM = "You are an expert engineer giving an independent, candid second opinion to another AI agent. Be specific and concrete, disagree when warranted, and say what you are unsure about.";

/** Was the label line AskModel puts before `<conversation>` when context="recent" (gateway.ts). */
export const CODING_ASK_MODEL_CONTEXT = "Recent conversation between a developer and their coding agent, for context:";

/** The `coding` HOP's side prompts (also `reviewer`'s: the review loop used these same calls). */
export const CODING_SIDE_PROMPTS: SidePrompts = {
  watcher: CODING_WATCHER_SYSTEM,
  aside: CODING_ASIDE_SYSTEM,
  suggest: CODING_SUGGEST_SYSTEM,
  askModel: CODING_ASK_MODEL_SYSTEM,
  askModelContext: CODING_ASK_MODEL_CONTEXT,
};

/** Every host section on, unconditionally: what `coding` and `reviewer` sent before sections were HOP slots. */
export const ALL_SECTIONS_ON = {
  capabilities: "on",
  environment: "on",
  gateway: "on",
  verify: "on",
  projectMemory: "on",
  skills: "on",
} as const;

/** Every host section sent only when what it describes is available: `base`'s default. */
export const ALL_SECTIONS_AUTO = {
  capabilities: "auto",
  environment: "auto",
  gateway: "auto",
  verify: "auto",
  projectMemory: "auto",
  skills: "auto",
} as const;
