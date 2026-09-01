import type { Message } from "@mlpal/harness-protocol";
import type { HookContext } from "../hooks/types";
import { FunctionHook } from "../hooks/engine";
import type { Hook } from "../hooks/types";
import { loadMessages } from "../loop/messages";
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
  /** Spawns the independent verification sub-agent with the given prompt; returns its final text. */
  runVerifier: (prompt: string) => Promise<string>;
  store: Store;
  /** Recursion guard: true while a verifier is already running (so its own Stop is inert). */
  isVerifying?: () => boolean;
  /** Only gate runs that changed real code — non-trivial = 3+ edits. Default 3. */
  minEdits?: number;
  /** Profile-supplied framing for the verifier's user turn (receives the original task
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

/** First user message = the task the run was asked to do. */
async function firstUserTask(store: Store, sessionId: string): Promise<string> {
  const msgs = await loadMessages(store, sessionId);
  const u = msgs.find((m) => m.role === "user");
  return u ? extractText(u.content).slice(0, 4000) : "(task text unavailable)";
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
    const task = await firstUserTask(opts.store, ctx.sessionId);
    const deliverable = await lastAssistantText(opts.store, ctx.sessionId);
    const prompt = (opts.taskFraming ?? codingVerifierTask)(task, deliverable);
    let out: string;
    try {
      out = await opts.runVerifier(prompt);
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
