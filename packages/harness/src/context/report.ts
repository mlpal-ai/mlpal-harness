import type { Message } from "@mlpal/harness-protocol";
import { estimateMessagesTokens, estimateTokens } from "./compaction";

/**
 * A structural breakdown of what occupies the model's context window, for the `/context`
 * command. Token figures are char/4 estimates (provider-neutral) — the same basis the
 * compaction decision uses. When the real input-token count from the last model call is
 * known, we surface it too. We label estimates
 * as estimates and anchor to the gateway's real number when we have one.
 */
export interface ContextSegment {
  label: string;
  tokens: number;
}

export interface ContextReport {
  segments: ContextSegment[];
  /** Sum of the estimated segments. */
  estimatedUsed: number;
  /** Model context window (tokens). */
  window: number;
  /** Real input_tokens from the most recent model call, if recorded. */
  lastInputTokens?: number;
}

export function contextReport(args: {
  systemPrompt: string;
  /** Serialized tool schemas (e.g. JSON.stringify(tools.schemas())). */
  toolSchemas: string;
  messages: Message[];
  window: number;
  lastInputTokens?: number;
}): ContextReport {
  const system = estimateTokens(args.systemPrompt);
  const tools = estimateTokens(args.toolSchemas);
  const conversation = estimateMessagesTokens(args.messages);
  const segments: ContextSegment[] = [
    { label: "System prompt (incl. memory + env)", tokens: system },
    { label: "Tool definitions", tokens: tools },
    { label: "Conversation", tokens: conversation },
  ];
  return {
    segments,
    estimatedUsed: system + tools + conversation,
    window: args.window,
    lastInputTokens: args.lastInputTokens,
  };
}
