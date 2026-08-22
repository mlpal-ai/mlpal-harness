import { z } from "zod";
import { parseJsonLenient } from "../json";
import { defineTool, type Tool } from "../types";

/**
 * AskUserQuestion — structured questions when a decision is genuinely the developer's to make.
 *
 * The tool is a thin seam: the engine owns the schema and the result contract; the HOST injects
 * `present`, which renders the interactive questionnaire (tabs, options, previews, free text,
 * notes) and returns the answers. Headless hosts don't register this tool at all, and the
 * prompt tells the model to decide-and-proceed there.
 *
 * Result contract (what the model sees):
 * - answered: one line per question — "Q → answer[, answer…]" plus "(note: …)" when the user
 *   attached free text to a selection.
 * - declined: a clear sentence that the user closed the form and wants to discuss in chat —
 *   the model should continue the conversation, not re-ask the same form.
 */

const optionSchema = z.object({
  label: z.string().min(1).max(60).describe("1–5 words shown on the choice"),
  description: z.string().max(300).optional().describe("one line of explanation / trade-offs"),
  preview: z
    .string()
    .max(4_000)
    .optional()
    .describe(
      "optional monospace preview (ASCII mockup, code snippet, config) rendered beside the options; use only to compare concrete artifacts — single-select questions only",
    ),
});

const questionSchema = z.object({
  question: z.string().min(1).describe("the complete question, ending with a question mark"),
  // Clamped, not validated: weaker models reliably blow a hard max-length and burn whole turns
  // on the retry (observed: 3 consecutive too_big failures). The tab simply truncates.
  header: z
    .string()
    .optional()
    .transform((h) => (h ?? "").trim().slice(0, 12))
    .describe("short chip label shown on the tab (~12 chars; longer is truncated, omitted is derived)"),
  multiSelect: z.boolean().optional().describe("true = checkboxes (several answers), false/omitted = pick one"),
  options: z
    .array(optionSchema)
    .max(5)
    .default([])
    .describe(
      '0–5 distinct choices. OMIT (or pass []) for an open-ended question — the form shows a free-text field. With choices, do NOT add an "Other"/"Type something" option — the UI adds free-text entry itself',
    ),
});

export type AskOption = z.infer<typeof optionSchema>;
export type AskQuestion = z.infer<typeof questionSchema>;

/** Models routinely stringify nested arrays in tool calls — and botch the inner escaping once the
 *  payload carries prose (descriptions, previews), which a strict JSON.parse cannot recover.
 *  Recovering here beats burning a whole model turn on a zod "expected array, received string"
 *  retry. The assertion narrows ZodEffects' `unknown` input back to the validated shape —
 *  runtime validation is unchanged. */
const questionsField = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const parsed = parseJsonLenient(v);
  return parsed.ok ? parsed.value : v; // on failure, let zod produce the real error
}, z.array(questionSchema).min(1).max(4)) as unknown as z.ZodType<AskQuestion[]>;

export interface AskAnswer {
  question: string;
  /** Selected labels and/or the free text the user typed. Empty when skipped. */
  answers: string[];
  /** Free-text note attached to the selection (preview layout's `n`). */
  note?: string;
}

export interface AskOutcome {
  /** User closed the form to keep talking instead — surface that, don't re-ask. */
  declined: boolean;
  answers: AskAnswer[];
}

export type PresentQuestions = (questions: AskQuestion[]) => Promise<AskOutcome | { parked: true }>;

/** Render the outcome the model reads. Kept deterministic and compact — it lands in context. */
export function formatOutcome(outcome: AskOutcome | { parked: true }): string {
  if ("parked" in outcome) {
    return (
      "No user is attached to this session right now (headless/scheduled run). Your questions were " +
      "PARKED for the user — they get a notification and will see them the next time they open this " +
      "session. Do as much as you responsibly can without the answers, then end the run with a clear " +
      "summary of what is done and exactly which decision is blocked on which question. Do not guess " +
      "the answers and do not re-ask."
    );
  }
  if (outcome.declined) {
    return (
      "The user closed the question form without submitting — they want to discuss this in chat instead. " +
      "Continue the conversation; do not re-ask the same form."
    );
  }
  const lines = outcome.answers.map((a) => {
    const ans = a.answers.length > 0 ? a.answers.join(", ") : "(skipped)";
    return `- ${a.question} → ${ans}${a.note ? `  (note: ${a.note})` : ""}`;
  });
  return `The user answered:\n${lines.join("\n")}`;
}

export function createAskUserQuestionTool(present: PresentQuestions): Tool<{ questions: AskQuestion[] }> {
  return defineTool({
    name: "AskUserQuestion",
    description:
      "Ask the developer up to 4 structured questions when you are blocked on a decision that is genuinely theirs to make — ambiguous requirements, a fork between approaches, missing context you cannot read from the repo. Each question is its own tab and picks its shape: 2–5 labeled options for a choice (put your recommended one FIRST with '(Recommended)' appended to its label), multiSelect for several answers, option previews to compare concrete artifacts (UI mockups, code variants, configs), or NO options at all for an open-ended question — the form then shows a free-text field. Every choice question also gets free-text entry and notes automatically, so answers may contain text you didn't list. Batch related decisions into ONE call rather than asking serially. Do NOT use it for choices with an obvious default, facts the code answers, or permission to proceed.",
    readOnly: true,
    schema: z.object({ questions: questionsField }),
    async call(input) {
      const questions = input.questions.map((q) => ({
        ...q,
        // An empty/omitted header derives from the question itself — never a blank tab.
        header: q.header || q.question.replace(/\?+$/, "").trim().slice(0, 12),
      }));
      // Preview is a single-select affordance (the pane tracks the highlighted option) — enforce
      // the CC rule here so the model learns it from the error instead of a broken layout.
      for (const q of questions) {
        if (q.multiSelect && q.options.some((o) => o.preview)) {
          return {
            content: `Question "${q.header}": previews are single-select only — drop multiSelect or the previews.`,
            isError: true,
          };
        }
        if (q.multiSelect && q.options.length === 0) {
          return {
            content: `Question "${q.header}": multiSelect needs options — for an open-ended question, omit both.`,
            isError: true,
          };
        }
      }
      const outcome = await present(questions);
      return { content: formatOutcome(outcome) };
    },
  });
}
