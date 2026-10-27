/**
 * Keeps the P1 lease an engine was handed (an engine token can renew, release and append under its
 * lease, never take one: leasing is control's), and fails closed on its own clock. The lease is held
 * until a deadline, ttl − margin after the send time of the newest renew that succeeded; a deadline
 * timer fires the loss whatever is in flight. Renews go out at adopt and every ttl/3 after on their
 * own cadence, so one renew that never answers does not hold back the next; each asks for `ttl_s`
 * explicitly and gives up after ttl/3 or at the deadline, whichever is sooner. The store's
 * `expires_at` can only bring the deadline forward (the store's clock is not ours; the skew is logged).
 * A renew answered `lease_lost`, or the deadline, loses the lease: `onLost` fires, `signal` aborts and
 * `leaseId` throws the LeaseLostError, so the host stops the run before another engine's writes could
 * interleave. A loss, a release or a new adopt abandons every renew still in flight, so none lands after.
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
  /** Ends every renew of the current holding (in flight or in a retry's wait): aborted on adopt,
   *  release and loss. Separate from `signal`, which only a loss aborts. */
  private renews = new AbortController();
  private readonly lostCallbacks: ((err: LeaseLostError) => void)[] = [];
  private cancelRenew: (() => void) | null = null;
  private cancelDeadline: (() => void) | null = null;
  private deadline = 0;
  /** The store's `expires_at` minus ours, when it brought the current deadline forward. */
  private deadlineSkewMs: number | null = null;
  /** Renews are numbered as sent; only an answer newer than the last good one moves the deadline (a
   *  count, not a send time, so a wall-clock step back cannot make a fresh renew look old). */
  private renewsSent = 0;
  private lastGoodRenew = 0;
  private skewLogged = false;
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
    this.endHolding();
    this.controller = new AbortController();
    this.state = { kind: "held", leaseId: grant.leaseId };
    this.lastGoodRenew = this.renewsSent;
    this.skewLogged = false;
    this.armDeadline(this.timers.now() + this.ttlMs - this.marginMs, null);
    this.renew(this.generation);
  }

  /** `cb` runs whenever a held lease is lost (once per adopt), and at once if the current one already was. */
  onLost(cb: (err: LeaseLostError) => void): void {
    this.lostCallbacks.push(cb);
    if (this.state.kind === "lost") cb(this.state.err);
  }

  /** Stops renewing and gives the lease back, when one is still held. */
  async release(): Promise<void> {
    this.endHolding();
    const s = this.state;
    if (s.kind === "lost") return;
    this.state = { kind: "released" };
    if (s.kind === "held") await this.opts.client.release(this.opts.sid, s.leaseId);
  }

  /** Sends one renew and schedules the next on the cadence, whether or not this one answers. */
  private renew(generation: number): void {
    if (generation !== this.generation || this.state.kind !== "held") return;
    this.cancelRenew = this.timers.setTimeout(() => this.renew(generation), this.ttlMs / 3);
    void this.renewOnce(generation, this.state.leaseId, this.timers.now(), ++this.renewsSent);
  }

  private async renewOnce(generation: number, leaseId: string, sent: number, n: number): Promise<void> {
    try {
      const timeoutMs = Math.max(1, Math.min(this.deadline - sent, this.ttlMs / 3));
      const answer = await this.opts.client.renew(this.opts.sid, leaseId, this.ttlS, { timeoutMs, signal: this.renews.signal });
      if (generation !== this.generation || n <= this.lastGoodRenew) return;
      this.lastGoodRenew = n;
      const ours = sent + this.ttlMs;
      if (answer.expiresAt >= ours) return this.armDeadline(ours - this.marginMs, null);
      const skewMs = answer.expiresAt - ours;
      if (!this.skewLogged) {
        this.skewLogged = true;
        this.log.warn("store.lease_clock_skew", { sid: this.opts.sid, skewMs, note: "the store's expires_at is earlier than ours; the lease deadline follows it" });
      }
      this.armDeadline(answer.expiresAt - this.marginMs, skewMs);
    } catch (e) {
      if (generation !== this.generation) return;
      if (e instanceof LeaseLostError) return this.lose(e);
      this.log.warn("session store lease renew failed; the next one goes out on cadence", {
        sid: this.opts.sid,
        error: e instanceof Error ? e.message : String(e),
        msToDeadline: this.deadline - this.timers.now(),
      });
    }
  }

  private armDeadline(at: number, skewMs: number | null): void {
    this.cancelDeadline?.();
    this.deadline = at;
    this.deadlineSkewMs = skewMs;
    this.cancelDeadline = this.timers.setTimeout(() => {
      const skew = this.deadlineSkewMs === null ? "" : `; the deadline was brought forward by the store's expires_at, ${this.deadlineSkewMs} ms from ours (clock skew?)`;
      this.lose(new LeaseLostError(`session store lease on ${this.opts.sid} not renewed within ${this.ttlS} s${skew}`, 0, "lease_lost"));
    }, Math.max(0, at - this.timers.now()));
  }

  /** Ends the current holding's renew chain: its timers, every renew in flight, and late answers. */
  private endHolding(): void {
    this.cancelRenew?.();
    this.cancelDeadline?.();
    this.cancelRenew = null;
    this.cancelDeadline = null;
    this.generation++;
    this.renews.abort(new Error("the lease holding ended"));
    this.renews = new AbortController();
  }

  private lose(err: LeaseLostError): void {
    if (this.state.kind !== "held") return;
    this.endHolding();
    this.state = { kind: "lost", err };
    this.log.error("session store lease lost", { sid: this.opts.sid, error: err.message });
    this.controller.abort(err);
    for (const cb of this.lostCallbacks) cb(err);
  }
}
