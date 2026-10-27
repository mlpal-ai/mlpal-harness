/**
 * Keeps the P1 lease an engine was handed (an engine token can renew, release and append under its
 * lease, never take one: leasing is control's), and fails closed on its own clock. The lease is held
 * until a deadline, ttl − margin after the send time of the last renew that succeeded; a deadline
 * timer fires the loss whatever is in flight, and each renew's timeout ends at the deadline. Renews go
 * out at adopt and every ttl/3 after, each asking for `ttl_s` explicitly. The store's `expires_at` can
 * only bring the deadline forward (the store's clock is not ours). A renew answered `lease_lost`, or
 * the deadline, loses the lease: `onLost` fires once, `signal` aborts and `leaseId` throws the
 * LeaseLostError, so the host stops the run before another engine's writes could interleave.
 */
import type { Logger } from "../../obs/logger";
import { silentLogger } from "../../obs/logger";
import { LeaseLostError, type SessionStoreClient } from "./client";
import { systemTimers, type Timers } from "./timers";

export interface LeaseKeeperOptions {
  client: Pick<SessionStoreClient, "renew" | "release">;
  sid: string;
  /** The lease's ttl, sent on every renew; P1 caps it at 60. */
  ttlS?: number;
  timers?: Timers;
  logger?: Logger;
}

type State = { kind: "none" } | { kind: "held"; leaseId: string } | { kind: "lost"; err: LeaseLostError } | { kind: "released" };

export class LeaseKeeper {
  private state: State = { kind: "none" };
  private readonly ttlS: number;
  private readonly ttlMs: number;
  private readonly marginMs: number;
  private readonly timers: Timers;
  private readonly log: Logger;
  private controller = new AbortController();
  private readonly lostCallbacks: ((err: LeaseLostError) => void)[] = [];
  private cancelRenew: (() => void) | null = null;
  private cancelDeadline: (() => void) | null = null;
  private deadline = 0;
  /** Bumped by every adopt, loss and release, so an answer for an earlier holding is ignored. */
  private generation = 0;

  constructor(private readonly opts: LeaseKeeperOptions) {
    this.ttlS = opts.ttlS ?? 60;
    this.ttlMs = this.ttlS * 1000;
    this.marginMs = Math.max(1000, this.ttlMs / 6);
    this.timers = opts.timers ?? systemTimers;
    this.log = opts.logger ?? silentLogger;
  }

  /** Aborts, with the LeaseLostError, when the lease is lost. The host wires it to the run; each adopt
   *  makes a new one. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get leaseId(): string {
    if (this.state.kind === "lost") throw this.state.err;
    if (this.state.kind !== "held") throw new Error(`no lease held on session ${this.opts.sid} (${this.state.kind})`);
    return this.state.leaseId;
  }

  /** Keeps the lease the engine was handed: per turn in phase 1, at start in phase 2. A lease held
   *  before is dropped from this keeper (its renews stop; it is not released). A phase-1 grant
   *  carries no expiry, so the deadline starts now and the first renew goes out at once. */
  adopt(grant: { leaseId: string }): void {
    this.stopTimers();
    this.generation++;
    this.controller = new AbortController();
    this.state = { kind: "held", leaseId: grant.leaseId };
    this.armDeadline(this.timers.now() + this.ttlMs - this.marginMs);
    void this.renew(this.generation);
  }

  /** `cb` runs whenever a held lease is lost (once per adopt), and at once if the current one already was. */
  onLost(cb: (err: LeaseLostError) => void): void {
    this.lostCallbacks.push(cb);
    if (this.state.kind === "lost") cb(this.state.err);
  }

  /** Stops renewing and gives the lease back, when one is still held. */
  async release(): Promise<void> {
    this.stopTimers();
    this.generation++;
    const s = this.state;
    if (s.kind === "lost") return;
    this.state = { kind: "released" };
    if (s.kind === "held") await this.opts.client.release(this.opts.sid, s.leaseId);
  }

  private async renew(generation: number): Promise<void> {
    if (generation !== this.generation || this.state.kind !== "held") return;
    const { leaseId } = this.state;
    const sent = this.timers.now();
    try {
      const answer = await this.opts.client.renew(this.opts.sid, leaseId, this.ttlS, { timeoutMs: Math.max(1, this.deadline - sent) });
      if (generation !== this.generation) return;
      this.armDeadline(Math.min(sent + this.ttlMs - this.marginMs, answer.expiresAt - this.marginMs));
    } catch (e) {
      if (generation !== this.generation) return;
      if (e instanceof LeaseLostError) return this.lose(e);
      this.log.warn("session store lease renew failed; retrying before the deadline", {
        sid: this.opts.sid,
        error: e instanceof Error ? e.message : String(e),
        msToDeadline: this.deadline - this.timers.now(),
      });
    }
    this.cancelRenew = this.timers.setTimeout(() => void this.renew(generation), Math.max(0, sent + this.ttlMs / 3 - this.timers.now()));
  }

  private armDeadline(at: number): void {
    this.cancelDeadline?.();
    this.deadline = at;
    this.cancelDeadline = this.timers.setTimeout(
      () => this.lose(new LeaseLostError(`session store lease on ${this.opts.sid} not renewed within ${this.ttlS} s`, 0, "lease_lost")),
      Math.max(0, at - this.timers.now()),
    );
  }

  private stopTimers(): void {
    this.cancelRenew?.();
    this.cancelDeadline?.();
    this.cancelRenew = null;
    this.cancelDeadline = null;
  }

  private lose(err: LeaseLostError): void {
    if (this.state.kind !== "held") return;
    this.stopTimers();
    this.generation++;
    this.state = { kind: "lost", err };
    this.log.error("session store lease lost", { sid: this.opts.sid, error: err.message });
    this.controller.abort(err);
    for (const cb of this.lostCallbacks) cb(err);
  }
}
