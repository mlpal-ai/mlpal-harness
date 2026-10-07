/**
 * The store's background writer. The loop used to await every append on the disk, so each model
 * call and tool run paid a write on its critical path. Now a write is a push onto an in-memory
 * queue (microseconds) and a single drainer appends batches a few hundred milliseconds later.
 *
 * Bounds, so the loop never waits: the queue has a cap, and past it the oldest lines of the
 * fullest file are dropped and the gap is written INTO that file as a marker record, so a reader
 * sees where records are missing rather than a silent hole. A reader that needs its own writes
 * (resume, the usage panel, tests) calls flush() first; the store does that in its read paths.
 * On a clean exit the host flushes; on a crash at most one flush interval is lost.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../obs/logger";
import { silentLogger } from "../obs/logger";

export interface AppendQueueOptions {
  /** Delay before a pending batch is written (default 200 ms). */
  flushMs?: number;
  /** Lines pending across all files past which the oldest are dropped (default 20,000). */
  maxPending?: number;
  /** Bytes pending across all files past which the oldest are dropped (default 64 MiB). */
  maxPendingBytes?: number;
  logger?: Logger;
  /** Injectable for tests. */
  append?: (file: string, text: string) => Promise<void>;
  /** Injectable for tests: a whole-file write (a blob). */
  write?: (file: string, data: Uint8Array) => Promise<void>;
}

interface Pending {
  lines: string[];
  bytes: number;
}

export class AppendQueue {
  private readonly pending = new Map<string, Pending>();
  private readonly knownDirs = new Set<string>();
  private totalLines = 0;
  private totalBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining: Promise<void> | null = null;
  private readonly flushMs: number;
  private readonly maxPending: number;
  private readonly maxPendingBytes: number;
  private readonly log: Logger;
  private readonly appendImpl: (file: string, text: string) => Promise<void>;
  private readonly writeImpl: (file: string, data: Uint8Array) => Promise<void>;
  /** Whole files to write once (blobs), drained before the lines that reference them. */
  private readonly files = new Map<string, Uint8Array>();
  /** Lines dropped since construction, for the host's own health line. */
  dropped = 0;
  /** Write failures since construction; the lines are lost and the error is logged once per file. */
  failures = 0;
  private readonly failedFiles = new Set<string>();

  constructor(opts: AppendQueueOptions = {}) {
    this.flushMs = opts.flushMs ?? 200;
    this.maxPending = opts.maxPending ?? 20_000;
    this.maxPendingBytes = opts.maxPendingBytes ?? 64 * 1024 * 1024;
    this.log = opts.logger ?? silentLogger;
    this.appendImpl =
      opts.append ??
      (async (file, text) => {
        const dir = dirname(file);
        if (!this.knownDirs.has(dir)) {
          await mkdir(dir, { recursive: true });
          this.knownDirs.add(dir);
        }
        await appendFile(file, text, "utf8");
      });
    this.writeImpl =
      opts.write ??
      (async (file, data) => {
        const dir = dirname(file);
        if (!this.knownDirs.has(dir)) {
          await mkdir(dir, { recursive: true });
          this.knownDirs.add(dir);
        }
        await writeFile(file, data);
      });
  }

  /** Enqueue a whole file (a blob): written once, before any line queued after it. Blob bytes do
   *  not count against the line cap; they are bounded by what the model was sent anyway. */
  pushFile(file: string, data: Uint8Array): void {
    this.files.set(file, data);
    this.schedule();
  }

  /** Enqueue one line (without its newline). Never blocks, never throws. */
  push(file: string, line: string): void {
    const p = this.pending.get(file) ?? { lines: [], bytes: 0 };
    p.lines.push(line);
    p.bytes += line.length + 1;
    this.pending.set(file, p);
    this.totalLines += 1;
    this.totalBytes += line.length + 1;
    if (this.totalLines > this.maxPending || this.totalBytes > this.maxPendingBytes) this.shed();
    this.schedule();
  }

  /** Lines and files waiting to be written. */
  size(): number {
    return this.totalLines + this.files.size;
  }

  /** Write everything pending now and wait for it. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A drain in flight may have taken a snapshot before the latest push: wait for it, then drain again.
    if (this.draining) await this.draining;
    while (this.totalLines > 0 || this.files.size > 0) await this.drain();
  }

  private schedule(): void {
    if (this.timer || this.draining) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.flushMs);
    // The timer must not keep a finished process alive; the host flushes on exit.
    this.timer.unref?.();
  }

  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      const files = [...this.files.entries()];
      this.files.clear();
      for (const [file, data] of files) {
        try {
          await this.writeImpl(file, data);
        } catch (e) {
          this.failures += 1;
          this.log.warn("store blob write failed; attachment lost", { file, bytes: data.length, error: String((e as Error)?.message ?? e) });
        }
      }
      const batch = [...this.pending.entries()];
      this.pending.clear();
      this.totalLines = 0;
      this.totalBytes = 0;
      for (const [file, p] of batch) {
        try {
          await this.appendImpl(file, `${p.lines.join("\n")}\n`);
          this.failedFiles.delete(file);
        } catch (e) {
          this.failures += p.lines.length;
          if (!this.failedFiles.has(file)) {
            this.failedFiles.add(file);
            this.log.warn("store append failed; records lost", { file, lines: p.lines.length, error: String((e as Error)?.message ?? e) });
          }
        }
      }
    })().finally(() => {
      this.draining = null;
      if (this.totalLines > 0 || this.files.size > 0) this.schedule();
    });
    return this.draining;
  }

  /** Over the cap: drop the oldest half of the fullest file's lines and leave a marker in their place. */
  private shed(): void {
    let fullest: [string, Pending] | undefined;
    for (const e of this.pending) if (!fullest || e[1].lines.length > fullest[1].lines.length) fullest = e;
    if (!fullest) return;
    const [file, p] = fullest;
    const n = Math.max(1, Math.floor(p.lines.length / 2));
    const removed = p.lines.splice(0, n);
    const bytes = removed.reduce((a, l) => a + l.length + 1, 0);
    p.bytes -= bytes;
    this.totalLines -= n;
    this.totalBytes -= bytes;
    this.dropped += n;
    const marker = JSON.stringify({ ts: new Date().toISOString(), kind: "store.dropped", count: n, reason: "append queue over cap" });
    p.lines.unshift(marker);
    p.bytes += marker.length + 1;
    this.totalLines += 1;
    this.totalBytes += marker.length + 1;
    this.log.warn("store append queue over cap; oldest records dropped", { file, dropped: n });
  }
}
