/**
 * Keeps the P1 lease an engine was handed (an engine token can renew, release and append under its
 * lease, never take one: leasing is control's). Renews every ttl/3 and fails closed: a renew
 * answered `lease_lost`, or no good renew for a whole ttl, is the loss of the session: `onLost` fires
 * once and `signal` aborts, so the host stops the run before another engine's writes could
 * interleave with this one's.
 */
import type { Logger } from "../../obs/logger";
import { silentLogger } from "../../obs/logger";
import { LeaseLostError, type SessionStoreClient } from "./client";
import { systemTimers, type Timers } from "./timers";

export interface LeaseKeeperOptions {
  client: Pick<SessionStoreClient, "renew" | "release">;
  sid: string;
  /** The lease's ttl, which sets the renew cadence; P1 caps it at 60. */
  ttlS?: number;
  timers?: Timers;
  logger?: Logger;
}

type State = { kind: "none" } | { kind: "held"; leaseId: string } | { kind: "lost"; err: Error } | { kind: "released" };

export class LeaseKeeper {
  private state: State = { kind: "none" };
  private readonly ttlMs: number;
  private readonly timers: Timers;
  private readonly log: Logger;
  private readonly controller = new AbortController();
  private readonly lostCallbacks: ((err: Error) => void)[] = [];
  private cancelRenew: (() => void) | null = null;
  private lastRenewOk = 0;

  constructor(private readonly opts: LeaseKeeperOptions) {
    this.ttlMs = (opts.ttlS ?? 60) * 1000;
    this.timers = opts.timers ?? systemTimers;
    this.log = opts.logger ?? silentLogger;
  }

  /** Aborts, with the error, when the lease is lost. The host wires it to the run. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get leaseId(): string {
    if (this.state.kind !== "held") throw new Error(`no lease held on session ${this.opts.sid} (${this.state.kind})`);
    return this.state.leaseId;
  }

  /** Keeps the lease the engine was handed: per turn in phase 1, at start in phase 2. */
  adopt(grant: { leaseId: string }): void {
    this.hold(grant.leaseId);
  }

  /** `cb` runs once when the lease is lost; at once if it already was. */
  onLost(cb: (err: Error) => void): void {
    if (this.state.kind === "lost") cb(this.state.err);
    else this.lostCallbacks.push(cb);
  }

  /** Stops renewing and gives the lease back, when one is still held. */
  async release(): Promise<void> {
    this.stopRenewing();
    const s = this.state;
    if (s.kind === "lost") return;
    this.state = { kind: "released" };
    if (s.kind === "held") await this.opts.client.release(this.opts.sid, s.leaseId);
  }

  private hold(leaseId: string): void {
    this.state = { kind: "held", leaseId };
    this.lastRenewOk = this.timers.now();
    this.scheduleRenew();
  }

  private scheduleRenew(): void {
    this.cancelRenew = this.timers.setTimeout(() => void this.renew(), this.ttlMs / 3);
  }

  private stopRenewing(): void {
    this.cancelRenew?.();
    this.cancelRenew = null;
  }

  private async renew(): Promise<void> {
    if (this.state.kind !== "held") return;
    const { leaseId } = this.state;
    try {
      await this.opts.client.renew(this.opts.sid, leaseId);
      this.lastRenewOk = this.timers.now();
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const silentFor = this.timers.now() - this.lastRenewOk;
      if (err instanceof LeaseLostError || silentFor >= this.ttlMs) return this.lose(err);
      this.log.warn("session store lease renew failed; retrying", { sid: this.opts.sid, error: err.message, silentForMs: silentFor });
    }
    if (this.state.kind === "held" && this.state.leaseId === leaseId) this.scheduleRenew();
  }

  private lose(err: Error): void {
    if (this.state.kind !== "held") return;
    this.stopRenewing();
    this.state = { kind: "lost", err };
    this.log.error("session store lease lost", { sid: this.opts.sid, error: err.message });
    this.controller.abort(err);
    for (const cb of this.lostCallbacks.splice(0)) cb(err);
  }
}
