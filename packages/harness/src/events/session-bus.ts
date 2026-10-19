import { isPersisted, type SubagentEvent, type SubagentStreamEvent } from "@mlpal/harness-protocol";
import type { Store } from "../store/types";

/** An event a tool raises on its session's stream from outside the loop's own flow: today the
 *  Agent tool's sub-agent lifecycle and the child's forwarded events. */
export type SideEvent = SubagentEvent | SubagentStreamEvent;

type Listener = (e: SideEvent) => void;
type IdleListener = (sessionId: string, e: SideEvent & { uuid?: string }) => void;

/**
 * Routes side events to the session they belong to. While that session's loop runs it has
 * subscribed and yields the event on its stream (persisting the persisted kinds in the
 * conversation's parent chain). While it is idle, a persisted event is appended at the
 * conversation head here, so a background child's `end` lands in the transcript even though no
 * run is open, and idle listeners (a server with a client attached) are told either way.
 */
export class SessionEventBus {
  private readonly subscribers = new Map<string, Listener>();
  private readonly idleListeners = new Set<IdleListener>();
  /** Persist-then-notify is serialised per session so two idle events keep their order. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly store: Store) {}

  /** The running loop's seam: exactly one subscriber per session; the newest wins. */
  subscribe(sessionId: string, listener: Listener): () => void {
    this.subscribers.set(sessionId, listener);
    return () => {
      if (this.subscribers.get(sessionId) === listener) this.subscribers.delete(sessionId);
    };
  }

  /** Called with events of sessions that have no running loop at that moment. */
  onIdle(listener: IdleListener): () => void {
    this.idleListeners.add(listener);
    return () => void this.idleListeners.delete(listener);
  }

  isSubscribed(sessionId: string): boolean {
    return this.subscribers.has(sessionId);
  }

  emit(sessionId: string, e: SideEvent): void {
    const live = this.subscribers.get(sessionId);
    if (live) {
      live(e);
      return;
    }
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      let out: SideEvent & { uuid?: string } = e;
      if (isPersisted(e)) {
        const head = await this.store.conversation.head(sessionId);
        const entry = await this.store.conversation.append(sessionId, e as SubagentEvent, head);
        await this.store.registry.patchSession(sessionId, { head: entry.uuid }).catch(() => undefined);
        out = { ...e, uuid: entry.uuid };
      }
      for (const l of this.idleListeners) l(sessionId, out);
    });
    this.queues.set(sessionId, next.catch(() => undefined));
  }

  /** Resolves when every idle event emitted so far has been persisted and delivered. */
  async settled(): Promise<void> {
    await Promise.all([...this.queues.values()]);
  }
}

/** The loop's in-run buffer: side events pushed while a tool runs are yielded on the stream as
 *  they arrive, not when the tool returns. */
export class SideQueue {
  private readonly items: SideEvent[] = [];
  private wake: (() => void) | null = null;

  push(e: SideEvent): void {
    this.items.push(e);
    this.wake?.();
  }

  size(): number {
    return this.items.length;
  }

  drain(): SideEvent[] {
    return this.items.splice(0);
  }

  /** Yields queued events while `work` is pending, then whatever arrived before it settled.
   *  Never throws for `work`; the caller awaits it afterwards. */
  async *until<T>(work: Promise<T>): AsyncGenerator<SideEvent, void, void> {
    let settled = false;
    const done = work.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      await Promise.race([done, new Promise<void>((r) => (this.wake = r))]);
      this.wake = null;
    }
    while (this.items.length) yield this.items.shift()!;
  }
}
