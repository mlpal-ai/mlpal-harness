/** Time as the remote store's parts see it, injectable so tests run on a manual clock. */
export interface Timers {
  now(): number;
  /** Runs `fn` once after `ms`; the returned function cancels it. */
  setTimeout(fn: () => void, ms: number): () => void;
  sleep(ms: number): Promise<void>;
}

export const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms);
    // A renew or a delta flush must not keep a finished process alive; the host closes the store.
    t.unref?.();
    return () => clearTimeout(t);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
