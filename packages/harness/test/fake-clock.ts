import type { Timers } from "../src/store/remote/timers";

/** A manual clock: time moves only on advance(), which fires due timers in order. */
export class FakeClock implements Timers {
  private t: number;
  private queue: { at: number; fn: () => void }[] = [];

  constructor(start = 1_000_000) {
    this.t = start;
  }

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, fn };
    this.queue.push(timer);
    return () => {
      this.queue = this.queue.filter((x) => x !== timer);
    };
  };

  sleep = (ms: number): Promise<void> => new Promise((resolve) => this.setTimeout(resolve, ms));

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.queue.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.queue = this.queue.filter((x) => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = end;
  }

  /** Steps wall time back, as an NTP correction would; pending timers keep their remaining delay. */
  stepBack(ms: number): void {
    this.t -= ms;
    for (const timer of this.queue) timer.at -= ms;
  }

  pending(): number {
    return this.queue.length;
  }
}
