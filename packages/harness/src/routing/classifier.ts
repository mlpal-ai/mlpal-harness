import type { Message } from "@mlpal/harness-protocol";
import type { ModelClient } from "../gateway/client";
import { codingClassifierSystem } from "../profile/builtins/coding";

/**
 * Proactive half of difficulty-aware routing: a one-shot cheap call that rates a task's
 * intrinsic difficulty and picks which ladder rung should attempt it FIRST — so obviously
 * hard work skips a doomed cheap attempt, and (crucially) tasks with no verifier still get
 * routed by difficulty. Reactive escalation then climbs from wherever this lands.
 *
 * Fail-safe by construction: any error, timeout, or unparseable reply returns rung 0 (the
 * cheapest). A bad classifier can never make a run more expensive than plain cheap-first.
 */
export interface ClassifyStartOptions {
  model_client: ModelClient;
  /** Cheap classify-tier model. */
  model: string;
  /** The task text to rate. */
  task: string;
  /** Ladder length; the returned rung is clamped to [0, rungs-1]. */
  rungs: number;
  /** Profile-supplied classifier prompt (LoopPolicy.classifierSystem). Defaults to the
   *  coding profile's — pre-split behavior. */
  system?: (top: number) => string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

function extractText(content: Message["content"]): string {
  return typeof content === "string"
    ? content
    : content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export async function classifyStartRung(opts: ClassifyStartOptions): Promise<number> {
  if (opts.rungs <= 1 || !opts.task.trim()) return 0;
  const top = opts.rungs - 1;
  try {
    const gen = opts.model_client.stream({
      model: opts.model,
      system: (opts.system ?? codingClassifierSystem)(top),
      messages: [{ role: "user", content: `Task:\n${opts.task}` } satisfies Message],
      maxTokens: opts.maxOutputTokens ?? 120,
      signal: opts.signal,
    });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const m = extractText(r.value.message.content).match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]) as { rung?: unknown };
      if (typeof o.rung === "number" && Number.isFinite(o.rung)) {
        return Math.min(top, Math.max(0, Math.round(o.rung)));
      }
    }
  } catch {
    // fall through to the safe default
  }
  return 0;
}
