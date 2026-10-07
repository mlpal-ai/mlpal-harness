/**
 * The ambient watcher ("you should know"): a side read of a finished turn, on the person's
 * behalf, that names what the agent did not say. It never blocks the loop and never talks to
 * the agent; its notices go to the person and the run's event log.
 *
 * Two layers. The deterministic one costs nothing and runs whenever the watcher is on: a claim
 * in the reply ("tests pass", "committed") with no matching call in the tool log, and edits
 * that nothing was run to check. The model layer is one bounded call on the cheap tier, after
 * the reply, and only for turns that acted or claimed: it reads the prompt, the tool log in
 * summary, the reply and the instruction files' rules, and reports at most three things the
 * person would want to know (a rule not followed, a part of the request not addressed, a risky
 * action taken quietly). A turn that only read files pays nothing.
 */
import type { Message } from "@mlpal/harness-protocol";
import type { ModelClient } from "../gateway/client";
import { type Logger, silentLogger } from "../obs/logger";

export type WatchNoticeKind = "unverified_claim" | "unchecked_edits" | "rule_miss" | "unaddressed" | "quiet_risk" | "other";

export interface WatchNotice {
  kind: WatchNoticeKind;
  text: string;
  /** "host" for the deterministic layer, else the model that produced it. */
  source: string;
}

export interface WatchToolCall {
  name: string;
  /** The argument that identifies the call (a command, a path, a pattern), clipped. */
  summary: string;
  isError: boolean;
}

export interface WatchDigest {
  prompt: string;
  toolCalls: WatchToolCall[];
  reply: string;
  /** Directive lines from the instruction files, clipped; the model layer checks the turn against them. */
  rules: string[];
}

const NOTICE_MAX_CHARS = 200;
const MAX_NOTICES = 3;
const SUMMARY_MAX = 100;
const KEY_ARGS = ["command", "path", "file_path", "pattern", "description", "prompt", "query", "url"];

function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
}

/** The turn is everything after the last user message that carries text (tool results are
 *  user-role messages too; they are not prompts). Null when there is no such turn. */
export function digestFromMessages(messages: Message[], rules: string[] = []): WatchDigest | null {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const hasText = typeof m.content === "string" ? m.content.trim().length > 0 : m.content.some((b) => b.type === "text" && b.text.trim());
    const onlyResults = typeof m.content !== "string" && m.content.length > 0 && m.content.every((b) => b.type === "tool_result");
    if (hasText && !onlyResults) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const prompt = textOf(messages[start]!.content);
  const toolCalls: WatchToolCall[] = [];
  const byId = new Map<string, WatchToolCall>();
  let reply = "";
  for (const m of messages.slice(start + 1)) {
    if (typeof m.content === "string") {
      if (m.role === "assistant" && m.content.trim()) reply = m.content;
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_use" && m.role === "assistant") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const key = KEY_ARGS.find((k) => typeof input[k] === "string" && (input[k] as string).trim());
        const summary = key ? String(input[key]).replace(/\s+/g, " ").trim().slice(0, SUMMARY_MAX) : "";
        const call: WatchToolCall = { name: b.name, summary, isError: false };
        toolCalls.push(call);
        byId.set(b.id, call);
      } else if (b.type === "tool_result") {
        const call = byId.get(b.tool_use_id);
        if (call && b.is_error) call.isError = true;
      }
    }
    if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t.trim()) reply = t;
    }
  }
  return { prompt, toolCalls, reply, rules };
}

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoRead", "ToolSearch", "Skill", "AskUserQuestion", "NotebookRead"]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const VERIFY_CALL = /\b(test|tests|pytest|vitest|jest|mocha|tsc|typecheck|type-check|build|lint|eslint|ruff|mypy|pyright|cargo (test|check|build|clippy)|go (test|vet|build)|make|check|verify|compile|gradle|mvn)\b/i;
const CLAIMS: { re: RegExp; what: string; evidence: RegExp }[] = [
  { re: /\b(?:all\s+)?(?:the\s+)?tests?\s+(?:now\s+)?(?:pass|passes|passed|passing|are green|is green)\b|\b(?:test suite|suite)\s+(?:is )?(?:green|passes|passing)\b/i, what: "says the tests pass", evidence: /\b(test|tests|pytest|vitest|jest|mocha|cargo test|go test|bun test|npm test|make test|spec)\b/i },
  { re: /\b(?:typecheck|type-check|type check|tsc)\s*(?:is\s+)?(?:passes|passed|clean|green)\b|\btypes?\s+(?:check\s+)?(?:pass|passes|out)\b/i, what: "says the typecheck is clean", evidence: /\b(tsc|typecheck|type-check|mypy|pyright)\b/i },
  { re: /\b(?:build|lint|linter)\s+(?:is\s+)?(?:passes|passed|clean|green|succeeds|succeeded)\b/i, what: "says the build or lint is clean", evidence: /\b(build|lint|eslint|ruff|biome)\b/i },
  { re: /\b(?:i\s+)?(?:have\s+)?committed\b|\bcommit(?:ted)? (?:the|these|those|my)? ?changes\b/i, what: "says it committed", evidence: /\bgit\s+commit\b/i },
  { re: /\b(?:i\s+)?(?:have\s+)?pushed\b/i, what: "says it pushed", evidence: /\bgit\s+push\b/i },
  { re: /\b(?:verified|confirmed) (?:that )?(?:it|this|the \w+) (?:works|runs|passes|behaves)\b|\bworks (?:as expected|correctly|end[- ]to[- ]end)\b/i, what: "says it verified the behaviour", evidence: /./ },
];
const ADMITS_UNRUN = /\b(did not|didn't|have not|haven't|could not|couldn't|not yet|unable to|was not able to|without running|not run|untested|no tests? (were|was) run|cannot run)\b/i;

/** The free layer: what the reply claims against what the tool log shows. */
export function deterministicNotices(d: WatchDigest): WatchNotice[] {
  const out: WatchNotice[] = [];
  const log = d.toolCalls.map((c) => `${c.name} ${c.summary}`).join("\n");
  const admits = ADMITS_UNRUN.test(d.reply);
  for (const c of CLAIMS) {
    if (!c.re.test(d.reply) || admits) continue;
    const evidence = c.evidence.source === "." ? d.toolCalls.some((t) => !READ_ONLY_TOOLS.has(t.name)) : c.evidence.test(log);
    if (evidence) continue;
    out.push({ kind: "unverified_claim", source: "host", text: `the reply ${c.what}, but no such command appears in this turn's tool log` });
  }
  const edits = d.toolCalls.filter((t) => EDIT_TOOLS.has(t.name) && !t.isError);
  const files = new Set(edits.map((t) => t.summary));
  const ran = d.toolCalls.some((t) => t.name === "Bash" && VERIFY_CALL.test(t.summary));
  if (files.size >= 2 && !ran && !admits) {
    out.push({ kind: "unchecked_edits", source: "host", text: `${files.size} files were edited and nothing was run to check them (no test, typecheck, build or lint in the tool log)` });
  }
  return out.slice(0, MAX_NOTICES);
}

/** Whether the turn is worth a model read: it acted, or it claimed something. A turn that
 *  only read and answered has nothing to miss that costs the person anything. */
export function shouldWatch(d: WatchDigest): boolean {
  if (d.toolCalls.some((t) => !READ_ONLY_TOOLS.has(t.name))) return true;
  return CLAIMS.some((c) => c.re.test(d.reply));
}

export const WATCHER_SYSTEM = `You watch a coding agent's finished turn on behalf of the person it works for. You never speak to the agent. Report only what the person should know that the agent did not say itself:
- a rule from the instruction files that the turn did not follow (rule_miss)
- a part of the request that was not addressed and not acknowledged (unaddressed)
- a claim in the reply that the tool log does not support (unverified_claim)
- a risky action the agent took without saying so: a push, a delete, a config change, a network call with data (quiet_risk)
Be strict about evidence: the tool log is summarised, so only report what the summary shows or clearly fails to show. Do not restate what the reply already admits. Do not give advice or praise. An empty list is the common, correct answer.
Answer with JSON only: {"notices":[{"kind":"rule_miss|unaddressed|unverified_claim|quiet_risk|other","text":"one sentence, under 200 characters, naming the specific thing"}]} with at most three notices.`;

export interface ModelWatchOptions {
  client: Pick<ModelClient, "stream">;
  model: string;
  timeoutMs?: number;
  logger?: Logger;
}

export function renderDigest(d: WatchDigest): string {
  const rules = d.rules.length ? `Rules from the instruction files:\n${d.rules.map((r) => `- ${r}`).join("\n")}\n\n` : "";
  const log = d.toolCalls.length ? d.toolCalls.map((c, i) => `${i + 1}. ${c.name}${c.summary ? ` ${c.summary}` : ""}${c.isError ? " [error]" : ""}`).join("\n") : "(no tool calls)";
  return `${rules}Request:\n${d.prompt.slice(0, 4000)}\n\nTool log (${d.toolCalls.length} calls):\n${log.slice(0, 6000)}\n\nReply:\n${d.reply.slice(0, 4000)}`;
}

/** The model layer. A failure of any kind is an empty list and one warning, never an error. */
export async function modelNotices(d: WatchDigest, opts: ModelWatchOptions): Promise<WatchNotice[]> {
  const logger = opts.logger ?? silentLogger;
  try {
    const gen = opts.client.stream({
      model: opts.model,
      system: WATCHER_SYSTEM,
      messages: [{ role: "user", content: renderDigest(d) }],
      maxTokens: 400,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
    });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const text = textOf(r.value.message.content);
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return [];
    const parsed = JSON.parse(text.slice(start, end + 1)) as { notices?: unknown };
    if (!Array.isArray(parsed.notices)) return [];
    const kinds: WatchNoticeKind[] = ["rule_miss", "unaddressed", "unverified_claim", "quiet_risk", "other"];
    return parsed.notices
      .filter((n): n is { kind?: unknown; text: string } => typeof n === "object" && n !== null && typeof (n as { text?: unknown }).text === "string" && (n as { text: string }).text.trim().length > 0)
      .slice(0, MAX_NOTICES)
      .map((n) => ({ kind: kinds.includes(n.kind as WatchNoticeKind) ? (n.kind as WatchNoticeKind) : "other", text: n.text.trim().slice(0, NOTICE_MAX_CHARS), source: opts.model }));
  } catch (e) {
    logger.warn("watcher model read failed; no notices", { model: opts.model, error: String((e as Error)?.message ?? e) });
    return [];
  }
}

/** Both layers. The model's unverified-claim notices give way to the host's, which are exact. */
export async function watchTurn(d: WatchDigest, model?: ModelWatchOptions): Promise<WatchNotice[]> {
  const host = deterministicNotices(d);
  if (!model || !shouldWatch(d)) return host;
  const fromModel = await modelNotices(d, model);
  const hasHostClaim = host.some((n) => n.kind === "unverified_claim");
  const merged = [...host, ...fromModel.filter((n) => !(n.kind === "unverified_claim" && hasHostClaim))];
  return merged.slice(0, MAX_NOTICES + 1);
}

const RULE_VERB = /\b(use|prefer|always|never|must|should|default to|don'?t|do not|avoid|only|stick to|ask|run)\b/i;

/** Directive lines from an instruction file, for the model layer: clipped, fences skipped, at most `max`. */
export function extractRules(content: string, max = 40): string[] {
  const out: string[] = [];
  let fence = false;
  for (const raw of content.split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence || /^\s*#/.test(raw)) continue;
    const line = raw.replace(/^[\s\-*>]+/, "").replace(/\*\*/g, "").trim();
    if (line.length < 12 || !RULE_VERB.test(line)) continue;
    out.push(line.length > 160 ? `${line.slice(0, 159)}…` : line);
    if (out.length >= max) break;
  }
  return out;
}
