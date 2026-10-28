/**
 * The engine's single writer to the session store: one in-order queue, at most one batch in
 * flight. Whatever is queued when the store is free goes out as the next batch, cut at the event
 * limit and at the store's byte limit (summed over the events' `data` as sent), so appends group
 * under load and go out at once when idle; an event over that limit goes alone. Every batch
 * carries `after_seq` = the last seq the store acknowledged, so the client's retry of a batch is
 * idempotent.
 *
 * One event over the store's `max_event_bytes` is refused on its own (EventTooLargeError) and the
 * writer carries on; the limit comes from the host's settings or is learned from the store's
 * `413 event_too_large`. Anything else that fails an append ends this writer (fail closed): a hole
 * in the durable log would contradict what the engine already holds in memory.
 */
import { EventTooLargeError } from "../errors";
import { BatchTooLargeError, type EncodedEvent, encodeEvent, type SessionStoreClient, type StoredEvent } from "./client";

export { EventTooLargeError };

export interface AppendBatcherOptions {
  client: Pick<SessionStoreClient, "appendEncoded">;
  sid: string;
  /** Read at each send, so a renewed or adopted lease is used without rebuilding the batcher. */
  leaseId: () => string;
  /** The store's last seq when the batcher starts. */
  afterSeq: number;
  batchMaxEvents?: number;
  /** Over the events' `data` bytes, as the store counts them. */
  batchMaxBytes?: number;
  /** The store's `max_event_bytes`, when the host knows it (`sessionStore.maxEventBytes`); else it is
   *  learned from the first `413 event_too_large`, and nothing is refused locally before that. */
  maxEventBytes?: number;
  /** `ts_ms` for an event appended without one. */
  now?: () => number;
  onAck?: (events: StoredEvent[]) => void;
  /** Called once, with the error that stopped the writer. */
  onFatal?: (err: Error) => void;
}

interface Queued {
  event: EncodedEvent;
  resolve: (seq: number) => void;
  reject: (err: Error) => void;
}

export class AppendBatcher {
  private readonly queue: Queued[] = [];
  private inFlight: Queued[] = [];
  private draining: Promise<void> | null = null;
  private acked: number;
  private fatalError: Error | null = null;
  private eventLimit: number | undefined;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(private readonly opts: AppendBatcherOptions) {
    this.acked = opts.afterSeq;
    this.maxEvents = opts.batchMaxEvents ?? 256;
    this.maxBytes = opts.batchMaxBytes ?? 1024 * 1024;
    this.eventLimit = opts.maxEventBytes;
    this.now = opts.now ?? Date.now;
  }

  /** The last seq the store acknowledged. */
  get lastSeq(): number {
    return this.acked;
  }

  /** The error that stopped this writer, if one did. */
  get fatal(): Error | null {
    return this.fatalError;
  }

  /** The batch size in `data` bytes; an event over it goes out alone. */
  get batchMaxBytes(): number {
    return this.maxBytes;
  }

  /** The store's per-event limit, as configured or learned; undefined while unknown. */
  get maxEventBytes(): number | undefined {
    return this.eventLimit;
  }

  /** Queues one event; resolves to its seq once the store acknowledges its batch. Throws at once
   *  when `data` cannot be serialized or is over the known per-event limit. */
  append(kind: string, data: unknown, tsMs = this.now()): Promise<number> {
    return this.push(encodeEvent(kind, data, tsMs));
  }

  /** `append` for an event already encoded. */
  push(event: EncodedEvent): Promise<number> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.eventLimit !== undefined && event.bytes > this.eventLimit) throw new EventTooLargeError(event.bytes, this.eventLimit);
    return new Promise<number>((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
      // A microtask, so the appends of one synchronous burst share a batch.
      queueMicrotask(() => this.kick());
    });
  }

  /** Resolves when everything queued so far is acknowledged; rejects with the fatal error. */
  async flush(): Promise<void> {
    this.kick();
    while (this.draining) await this.draining;
    if (this.fatalError) throw this.fatalError;
  }

  private kick(): void {
    if (this.draining || this.fatalError || this.queue.length === 0) return;
    this.draining = this.drain().finally(() => {
      this.draining = null;
      // An append made while the last batch was unwinding saw a drain in progress and did not kick.
      this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.fatalError) {
      let bytes = 0;
      let n = 0;
      while (n < this.queue.length && n < this.maxEvents && (n === 0 || bytes + this.queue[n]!.event.bytes <= this.maxBytes)) {
        bytes += this.queue[n]!.event.bytes;
        n++;
      }
      this.inFlight = this.queue.splice(0, n);
      try {
        const { firstSeq, lastSeq } = await this.opts.client.appendEncoded(this.opts.sid, {
          leaseId: this.opts.leaseId(),
          afterSeq: this.acked,
          events: this.inFlight.map((q) => q.event),
        });
        this.acked = lastSeq;
        const batch = this.inFlight;
        this.inFlight = [];
        batch.forEach((q, i) => q.resolve(firstSeq + i));
        this.opts.onAck?.(batch.map((q, i) => ({ seq: firstSeq + i, kind: q.event.kind, data: JSON.parse(q.event.json), ts_ms: q.event.ts_ms })));
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        const [only] = this.inFlight;
        if (err instanceof BatchTooLargeError && err.code === "event_too_large" && this.inFlight.length === 1 && only) {
          // Nothing was written: drop this one event, keep its limit, and go on with the next batch.
          this.eventLimit = err.maxEventBytes ?? only.event.bytes - 1;
          this.inFlight = [];
          only.reject(new EventTooLargeError(only.event.bytes, this.eventLimit));
          continue;
        }
        this.stop(err);
      }
    }
  }

  private stop(err: Error): void {
    this.fatalError = err;
    for (const q of [...this.inFlight, ...this.queue.splice(0)]) q.reject(err);
    this.inFlight = [];
    this.opts.onFatal?.(err);
  }
}
