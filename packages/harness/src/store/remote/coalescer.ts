/**
 * Merges the loop's token deltas into one durable event per window, so the session log holds a
 * few events a second instead of one per token. Consecutive deltas of one kind share a window;
 * any other frame ends it (order is kept) and passes through unchanged. The caller flushes at
 * the turn's boundaries: a tool_use_start, an ask, a tool_result, the result.
 */
import type { EngineEvent } from "@mlpal/harness-protocol";
import { systemTimers, type Timers } from "./timers";

export interface DeltaCoalescerOptions {
  sink: (event: EngineEvent) => void;
  flushMs?: number;
  timers?: Pick<Timers, "setTimeout">;
}

type DeltaType = "text_delta" | "thinking_delta";

export class DeltaCoalescer {
  private open: { type: DeltaType; text: string } | null = null;
  private cancelTimer: (() => void) | null = null;
  private readonly flushMs: number;
  private readonly timers: Pick<Timers, "setTimeout">;

  constructor(private readonly opts: DeltaCoalescerOptions) {
    this.flushMs = opts.flushMs ?? 250;
    this.timers = opts.timers ?? systemTimers;
  }

  push(frame: EngineEvent): void {
    if (frame.type !== "text_delta" && frame.type !== "thinking_delta") {
      this.flush();
      this.opts.sink(frame);
      return;
    }
    if (this.open?.type === frame.type) {
      this.open.text += frame.text;
      return;
    }
    this.flush();
    this.open = { type: frame.type, text: frame.text };
    this.cancelTimer = this.timers.setTimeout(() => this.flush(), this.flushMs);
  }

  flush(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    const open = this.open;
    this.open = null;
    if (open) this.opts.sink(open);
  }
}
