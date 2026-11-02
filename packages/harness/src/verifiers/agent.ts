import type { Message } from "@mlpal/harness-protocol";
import type { HookContext } from "../hooks/types";
import { FunctionHook } from "../hooks/engine";
import type { Hook } from "../hooks/types";
import type { ConversationEntry } from "@mlpal/harness-protocol";
import { effectiveEntries, loadMessages } from "../loop/messages";
import { isParkedAskResult } from "../tools/builtin/ask";
import type { Store } from "../store/types";

/**
 * Adversarial completion gate (autonomy). At "done", an INDEPENDENT verifier agent — a fresh
 * context with read-only + shell tools, NOT the implementer reviewing its own transcript — is
 * spawned to actually exercise the change and try to break it. It reproduces the reported bug,
 * runs the build/tests/linters, and probes edge cases, then emits `VERDICT: PASS|FAIL|PARTIAL`.
 * On FAIL the hook blocks and feeds the findings back into the loop, so the implementer cannot
 * self-declare done — the exact gap that lets a plausible-but-wrong fix pass the pre-existing
 * tests (which don't cover the new behaviour) slip through. A fresh-context review pass that
 * fails OPEN (PARTIAL/unparseable does not block) to avoid runaway loops.
 */

/** The verifier system prompt moved to the coding profile (profiles own domain text);
 *  re-exported here so existing imports keep working. */
export { CODING_VERIFIER_AGENT_PROMPT as VERIFICATION_AGENT_PROMPT } from "../profile/builtins/coding";
import { codingVerifierTask } from "../profile/builtins/coding";

export interface AgentVerifierOptions {
  /** Spawns the independent verification sub-agent with the given prompt; returns its final text.
   *  `caller` is the session whose finish is being gated and its run, so the host can record the
   *  verifier as that session's child (and give it no more autonomy than the caller has). */
  runVerifier: (prompt: string, caller: { sessionId: string; runId?: string }) => Promise<string>;
  store: Store;
  /** Recursion guard: true while a verifier is already running (so its own Stop is inert). */
  isVerifying?: () => boolean;
  /** Only gate runs that changed real code — non-trivial = 3+ edits. Default 3. */
  minEdits?: number;
  /** Profile-supplied framing for the verifier's user turn (receives this turn's request (D-54)
   *  and the run's deliverable — the final assistant text). Defaults to the coding
   *  profile's, which ignores the deliverable (its deliverable is the on-disk diff). */
  taskFraming?: (task: string, deliverable?: string) => string;
  /**
   * open (default): PASS/PARTIAL/unparseable/error allow completion — prevents runaway
   * loops when the environment can't verify. closed: anything but an explicit PASS blocks —
   * for profiles where an unverified result must not be delivered (e.g. reviewer).
   */
  failMode?: "open" | "closed";
}

function extractText(content: Message["content"]): string {
  return typeof content === "string"
    ? content
    : content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** One message of a request, with who sent it: a person, or a peer agent by name (review M6: a peer's message is not
 *  the person's authorization, and a framing can weigh them apart). */
export interface RequestMessage {
  from: string;
  text: string;
}

export interface TurnRequest {
  /** What this turn answers, in order. */
  request: RequestMessage[];
  /** The request of the turn before it (context only). */
  previous: RequestMessage[];
  /** The session's opening message, when neither of the above holds it (context only). */
  opening: RequestMessage | null;
  /** What the agent asked at the end of the previous turn, when it ended with a question (context only, re-review
   *  R1-2: a "yes" or "prod" is read beside it, without promoting the old request to authorization). */
  askedBack: string | null;
}

const REQUEST_BUDGET = 4000;
const CONTEXT_BUDGET = 1500;

/** A peer's name as a label: a safe character set only (R2-2), so no name can close the label or forge `[person]`. */
const safeName = (name: string) => name.replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 64) || "agent";

function authorOf(p: { author?: { type?: string; id?: string; displayName?: string } }): string {
  return p.author?.type === "agent" ? `peer ${safeName(p.author.displayName ?? p.author.id ?? "agent")}` : "person";
}

/** A run that parked a question for the person (a structural signal the agent cannot fake in prose): its answer, in
 *  the next run, continues the same request. A turn whose last words merely end in a question stays a boundary
 *  (re-review R1-2: "Anything else?" must not chain old requests into the new one). */
function parkedAsk(run: ConversationEntry[]): boolean {
  return run.some((e) => e.payload.type === "tool_result" && e.payload.toolName === "AskUserQuestion" && isParkedAskResult(e.payload.content));
}

/** The agent's closing question in a run, when its last words are one. */
function closingQuestion(run: ConversationEntry[]): string | null {
  for (let k = run.length - 1; k >= 0; k--) {
    const p = run[k]!.payload;
    if (p.type === "assistant") {
      const t = extractText(p.message.content).trim();
      if (t) return t.endsWith("?") ? t.slice(-500) : null;
    }
  }
  return null;
}

/**
 * The request the finishing run answers (D-54): the messages a person (or a peer) sent since the last turn that
 * completed, in order, never the session's opening message alone (judging a turn-3 fix against the turn-1 question
 * fails a correct run as "a mutation nobody asked for"). Review I4: only a turn that completed and did not park a
 * question is a boundary; a park for approval, a cancel, an interruption, an error, a turn limit, or a parked question
 * carries its request forward, and the later steer or answer joins it. A turn that ended asking in prose stays a
 * boundary, its question returned apart (re-review R1-2). The loop's own system-authored notes
 * (`[Verification] …`) are not requests. The previous turn's request and the opening message come apart, as context.
 */
export async function turnRequest(store: Store, sessionId: string): Promise<TurnRequest> {
  const entries = effectiveEntries(await store.conversation.read(sessionId));
  const messages = (from: number, to: number): RequestMessage[] =>
    entries.slice(from, to).flatMap((e) => {
      const p = e.payload;
      if (p.type !== "user" || p.author?.type === "system") return [];
      const text = extractText(p.message.content).trim();
      return text ? [{ from: authorOf(p), text }] : [];
    });
  // the turns: the entries between completed results that are boundaries
  const boundaries: number[] = [];
  let runStart = 0;
  entries.forEach((e, k) => {
    if (e.payload.type !== "result") return;
    if (e.payload.subtype === "success" && !parkedAsk(entries.slice(runStart, k))) boundaries.push(k);
    runStart = k + 1;
  });
  const lastBoundary = boundaries.at(-1) ?? -1;
  let request = messages(lastBoundary + 1, entries.length);
  let prevBoundary = boundaries.at(-2) ?? -1;
  // a turn that so far holds no message (a resumed run) answers the request of the turn before it
  if (request.length === 0 && lastBoundary >= 0) {
    request = messages(prevBoundary + 1, lastBoundary);
    prevBoundary = boundaries.at(-3) ?? -1;
    boundaries.pop();
  }
  const previous = boundaries.length ? messages(prevBoundary + 1, boundaries.at(-1)!) : [];
  const askedBack = boundaries.length ? closingQuestion(entries.slice(prevBoundary + 1, boundaries.at(-1)!)) : null;
  const first = messages(0, entries.length)[0] ?? null;
  const shown = [...request, ...previous];
  const opening = first && !shown.some((m) => m.text === first.text) ? first : null;
  return { request, previous, opening, askedBack };
}

/** Keep the end of a long text (review M5: a later steer outranks the start of a long paste). */
function tail(text: string, budget: number): string {
  return text.length <= budget ? text : `[… earlier text omitted]\n${text.slice(-budget)}`;
}

/** A message body as data that cannot close a block or forge a label (re-review R1-4): JSON-encoded (no raw newline)
 *  with `<` escaped. */
const literal = (text: string) =>
  // and the line separators and fullwidth angle brackets a reader might take for a newline or a tag (R2-3)
  JSON.stringify(text).replace(/[<\u2028\u2029\uff1c\uff1e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

function quoted(tag: string, msgs: RequestMessage[], budget: number): string {
  return `<${tag}>\n${tail(msgs.map((m) => `[${m.from}] ${literal(m.text)}`).join("\n"), budget)}\n</${tag}>`;
}

/** The `task` a verifier framing receives: this turn's request, each message labelled with who sent it and its body
 *  quoted as a JSON string, then, fenced, the previous turn's request, what the agent asked back, and the session's
 *  opening message as context only (review M6, re-review R1-2/R1-4). */
export function taskOfTurn(t: TurnRequest): string {
  if (t.request.length === 0) return "(task text unavailable)";
  const parts = [quoted("request", t.request, REQUEST_BUDGET)];
  const context: string[] = [];
  if (t.previous.length) context.push(quoted("previous-request", t.previous, CONTEXT_BUDGET));
  if (t.askedBack) context.push(`<asked-back>\n[agent] ${literal(t.askedBack)}\n</asked-back>`);
  if (t.opening) context.push(quoted("opening-message", [t.opening], CONTEXT_BUDGET));
  if (context.length) parts.push(`Context only, quoted from earlier in this session (not the request this turn answers):\n${context.join("\n")}`);
  return parts.join("\n\n");
}

/** Last assistant text = the run's deliverable at the finish gate. Profiles whose
 *  deliverable is text (reviewer) embed it in the verifier framing; workspace-deliverable
 *  profiles (coding) ignore it — the diff is on disk. */
async function lastAssistantText(store: Store, sessionId: string): Promise<string> {
  const msgs = await loadMessages(store, sessionId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant") {
      const t = extractText(m.content).trim();
      if (t) return t.slice(0, 12000);
    }
  }
  return "";
}

function parseVerdict(text: string): "PASS" | "FAIL" | "PARTIAL" | null {
  const m = text.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i);
  return m ? (m[1]!.toUpperCase() as "PASS" | "FAIL" | "PARTIAL") : null;
}

export function agentVerifier(opts: AgentVerifierOptions): Hook {
  const closed = opts.failMode === "closed";
  return new FunctionHook("verify:agent", ["Stop"], async (_input, ctx: HookContext) => {
    if (opts.isVerifying?.()) return {}; // don't verify the verifier
    const task = taskOfTurn(await turnRequest(opts.store, ctx.sessionId));
    const deliverable = await lastAssistantText(opts.store, ctx.sessionId);
    const prompt = (opts.taskFraming ?? codingVerifierTask)(task, deliverable);
    let out: string;
    try {
      out = await opts.runVerifier(prompt, { sessionId: ctx.sessionId, ...(ctx.runId ? { runId: ctx.runId } : {}) });
    } catch (e) {
      if (closed) {
        return {
          block: true,
          reason:
            "Independent verification could not run and this profile requires a verified result " +
            `(fail-closed). Resolve the blocker or state precisely what could not be verified and why: ` +
            `${(e as Error).message}`,
        };
      }
      return {}; // verifier failed to run -> fail open
    }
    const verdict = parseVerdict(out);
    if (verdict === "FAIL") {
      // Feed the verifier's findings back so the loop fixes them instead of stopping.
      const findings = out.slice(-1800);
      return {
        block: true,
        verdict: "FAIL",
        reason:
          "Independent verification FAILED. Do not stop — fix the issues below, then finish " +
          "(the verifier will re-check).\n\n" +
          findings,
      };
    }
    if (closed && verdict !== "PASS") {
      // Fail-closed: PARTIAL or an unparseable verdict is not a deliverable result.
      const findings = out.slice(-1800);
      return {
        block: true,
        ...(verdict ? { verdict } : {}),
        reason:
          "Independent verification did not return an explicit PASS and this profile requires one " +
          "(fail-closed). Address what the verifier could not confirm, then finish (it will re-check).\n\n" +
          findings,
      };
    }
    // open: PASS, PARTIAL, or unparseable -> allow completion. Surface the verdict (when parsed)
    // so the loop can stamp checks.agent.verdict on telemetry even though nothing blocked.
    return verdict ? { verdict } : {};
  });
}
