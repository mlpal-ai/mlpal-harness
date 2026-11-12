import type { Message } from "@mlpal/harness-protocol";
import type { ModelClient } from "../gateway/client";
import { CODING_SUGGEST_SYSTEM } from "../profile/side-prompts";

/**
 * One-shot input autocomplete: given a developer's partial message to the agent and the recent
 * conversation, propose the text that would *finish* it — shown as ghost text the user accepts with
 * Tab. A single cheap call, deliberately tiny (a few output tokens), and fail-safe: any error,
 * timeout, or empty/echoing reply returns null, so a bad suggestion is simply no suggestion.
 *
 * Returns the CONTINUATION only (what to append after the draft), joined so `draft + result` reads
 * correctly — a leading space is added when both sides are word characters. Never returns the whole
 * message or something that merely repeats what's already typed.
 */
export interface SuggestOptions {
  model_client: ModelClient;
  /** The HOP's system for this call (`profile.prompts.side`); default: the coding text. */
  system?: string;
  /** Cheap classify/summarize-tier model — this must not cost real money per keystroke-pause. */
  model: string;
  /** The partial message, completed from its end. */
  draft: string;
  /** Recent conversation, already compacted by the caller (optional). */
  context?: string;
  signal?: AbortSignal;
  /** Output cap. A hint is short; the default keeps the call cheap. */
  maxOutputTokens?: number;
}


function extractText(content: Message["content"]): string {
  return typeof content === "string"
    ? content
    : content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export async function suggestCompletion(opts: SuggestOptions): Promise<string | null> {
  const draft = opts.draft;
  if (!draft.trim()) return null;
  try {
    const gen = opts.model_client.stream({
      model: opts.model,
      system: opts.system ?? CODING_SUGGEST_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            (opts.context ? `Recent conversation:\n${opts.context}\n\n` : "") +
            `Partial message (give only the continuation): ${draft}`,
        } satisfies Message,
      ],
      maxTokens: opts.maxOutputTokens ?? 40,
      signal: opts.signal,
    });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    let line = extractText(r.value.message.content).replace(/\r?\n[\s\S]*$/, "").trim();
    // Strip quotes the model sometimes wraps a phrase in, then bound the length — this is a hint.
    line = line.replace(/^["'`]|["'`]$/g, "").trim().slice(0, 80);
    if (!line) return null;
    // Reject echoes: the model repeating (the tail of) what's already typed would just duplicate.
    if (draft.trimEnd().endsWith(line) || line === draft.trim()) return null;
    // Join cleanly: "add tests" + "for the parser" needs the space; "foo(" + "bar)" must not.
    const needsSpace = /\w$/.test(draft) && /^\w/.test(line);
    return (needsSpace ? " " : "") + line;
  } catch {
    return null;
  }
}
