/**
 * Structured questions on the wire: what AskUserQuestion (harness tools/builtin/ask.ts) asks
 * and what the person answers. The engine's own zod schema is stricter (a header is always
 * derived, options default to []); these are the shapes a frontend sees and sends.
 */
export interface AskOption {
  label: string;
  description?: string;
  /** Monospace preview rendered beside the options; single-select questions only. */
  preview?: string;
}

export interface AskQuestion {
  question: string;
  /** Short chip label for the question's tab (~12 chars). */
  header?: string;
  multiSelect?: boolean;
  options?: AskOption[];
}

export interface AskAnswer {
  question: string;
  /** Selected labels and/or the free text the person typed. Empty when skipped. */
  answers: string[];
  /** Free-text note attached to a selection. */
  note?: string;
}

export interface AskOutcome {
  /** The person closed the form to keep talking instead; the model must not re-ask the form. */
  declined: boolean;
  answers: AskAnswer[];
}
