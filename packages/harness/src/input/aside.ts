import type { Message } from "@mlpal/harness-protocol";
import type { ModelClient } from "../gateway/client";
import { CODING_ASIDE_SYSTEM } from "../profile/side-prompts";

/**
 * Answer a quick side question ("/btw …") about an in-flight session WITHOUT touching it: a single
 * read-only model call with a snapshot of the conversation as context. No tools, nothing persisted,
 * nothing injected into the main run — the agent keeps working, and this just gives the user a fast
 * answer alongside. Fail-safe: any error returns a short apology string rather than throwing, so the
 * caller never has to special-case failure in the render path.
 */
export interface AsideOptions {
  model_client: ModelClient;
  /** The HOP's system for this call (`profile.prompts.side`); default: the coding text. */
  system?: string;
  /** Cheap tier — a side answer shouldn't cost like a main turn. */
  model: string;
  /** The user's question (already stripped of the "/btw" prefix). */
  question: string;
  /** A rendered snapshot of the ongoing session, for grounding. Caller bounds its length. */
  transcript?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}


function extractText(content: Message["content"]): string {
  return typeof content === "string"
    ? content
    : content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export async function answerAside(opts: AsideOptions): Promise<string> {
  const question = opts.question.trim();
  if (!question) return "(no question)";
  try {
    const gen = opts.model_client.stream({
      model: opts.model,
      system: opts.system ?? CODING_ASIDE_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            (opts.transcript ? `Session so far (for context):\n${opts.transcript}\n\n` : "") +
            `Side question: ${question}`,
        } satisfies Message,
      ],
      maxTokens: opts.maxOutputTokens ?? 500,
      signal: opts.signal,
    });
    let r = await gen.next();
    while (!r.done) r = await gen.next();
    const text = extractText(r.value.message.content).trim();
    return text || "(no answer)";
  } catch {
    return "(couldn't answer that just now)";
  }
}
