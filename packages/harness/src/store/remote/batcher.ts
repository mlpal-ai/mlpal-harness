/**
 * The engine's single writer to the session store: one in-order queue, at most one batch in
 * flight. Whatever is queued when the store is free goes out as the next batch, cut at the event
 * limit and at the store's byte limit (summed over the events' `data` as sent), so appends group
 * under load and go out at once when idle. Every batch carries
 * `after_seq` = the last seq the store acknowledged; the client's retry of a batch is therefore
 * idempotent, and anything else that fails an append ends this writer (fail closed): a hole in
 * the durable log would contradict what the engine already holds in memory.
 */
import type { SessionStoreClient, StoreEvent, StoredEvent } from "./client";

export interface AppendBatcherOptions {
  client: Pick<SessionStoreClient, "append">;
  sid: string;
  /** Read at each send, so a renewed or adopted lease is used without rebuilding the batcher. */
  leaseId: () => string;
  /** The store's last seq when the batcher starts. */
  afterSeq: number;
  batchMaxEvents?: number;
  /** Over the events' `data` bytes, as the store counts them. */
  batchMaxBytes?: number;
  /** `ts_ms` for an event appended without one. */
  now?: () => number;
  onAck?: (events: StoredEvent[]) => void;
  /** Called once, with the error that stopped the writer. */
  onFatal?: (err: Error) => void;
}

interface Queued {
  event: StoreEvent;
  bytes: number;
  resolve: (seq: number) => void;
  reject: (err: Error) => void;
}

export class AppendBatcher {
  private readonly queue: Queued[] = [];
  private inFlight: Queued[] = [];
  private draining: Promise<void> | null = null;
  private acked: number;
  private fatalError: Error | null = null;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly now: () => number;

  constructor(private readonly opts: AppendBatcherOptions) {
    this.acked = opts.afterSeq;
    this.maxEvents = opts.batchMaxEvents ?? 256;
    this.maxBytes = opts.batchMaxBytes ?? 1024 * 1024;
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

  /** Queue one event; resolves to its seq once the store acknowledges its batch. */
  append(kind: string, data: unknown, tsMs = this.now()): Promise<number> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    const event: StoreEvent = { kind, data: data ?? null, ts_ms: tsMs };
    return new Promise<number>((resolve, reject) => {
      this.queue.push({ event, bytes: Buffer.byteLength(JSON.stringify(event.data)), resolve, reject });
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
      while (n < this.queue.length && n < this.maxEvents && (n === 0 || bytes + this.queue[n]!.bytes <= this.maxBytes)) {
        bytes += this.queue[n]!.bytes;
        n++;
      }
      this.inFlight = this.queue.splice(0, n);
      try {
        const { firstSeq, lastSeq } = await this.opts.client.append(this.opts.sid, {
          leaseId: this.opts.leaseId(),
          afterSeq: this.acked,
          events: this.inFlight.map((q) => q.event),
        });
        this.acked = lastSeq;
        const batch = this.inFlight;
        this.inFlight = [];
        batch.forEach((q, i) => q.resolve(firstSeq + i));
        this.opts.onAck?.(batch.map((q, i) => ({ seq: firstSeq + i, ...q.event })));
      } catch (e) {
        this.stop(e instanceof Error ? e : new Error(String(e)));
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
