/** Errors a store backend raises that the loop handles, whichever backend it runs on. */

/** One event is larger than the session store takes: refused alone, never fatal to the writer. */
export class EventTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
  ) {
    super(`session store event of ${bytes} bytes is over the store's limit of ${limit}`);
    this.name = "EventTooLargeError";
  }
}
