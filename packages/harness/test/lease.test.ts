import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LeaseGrant, LeaseLostError, SessionStoreClient, StoreUnreachableError } from "../src/store/remote/client";
import { LeaseKeeper } from "../src/store/remote/lease";
import { FakeClock } from "./fake-clock";
import { type FakeSessionStore, startFakeSessionStore } from "./fake-session-store";

let clock: FakeClock;
let store: FakeSessionStore;

beforeEach(() => {
  clock = new FakeClock();
  store = startFakeSessionStore({ clock: clock.now });
  store.createSession("s1");
});
afterEach(async () => {
  await store.stop();
});

const tick = () => new Promise((r) => setTimeout(r, 1));

/** Advances the clock one second at a time, letting promises settle between steps. */
async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1000) {
    clock.advance(Math.min(1000, ms - t));
    await tick();
  }
}

interface RenewCall {
  at: number;
  leaseId: string;
  ttlS?: number;
  timeoutMs?: number;
}

/** A client whose renews are answered by `answer` (a promise on the manual clock). */
function stubClient(answer: (call: RenewCall) => Promise<Partial<LeaseGrant>>) {
  const renews: RenewCall[] = [];
  let releases = 0;
  return {
    renews,
    releases: () => releases,
    client: {
      renew: async (_sid: string, leaseId: string, ttlS?: number, opts: { timeoutMs?: number } = {}) => {
        const call = { at: clock.now(), leaseId, ttlS, timeoutMs: opts.timeoutMs };
        renews.push(call);
        return { leaseId, expiresAt: Number.MAX_SAFE_INTEGER, lastSeq: 0, ...(await answer(call)) };
      },
      release: async () => void releases++,
    },
  };
}

const ok = async () => ({});
const after = <T>(ms: number, fn: () => T) => new Promise<T>((resolve) => clock.setTimeout(() => resolve(fn()), ms));
const failAfter = (ms: number) => (c: RenewCall) =>
  new Promise<never>((_, reject) => clock.setTimeout(() => reject(new StoreUnreachableError("down", 1)), Math.min(ms, c.timeoutMs ?? ms)));
const never = () => new Promise<never>(() => {});

function keeper(client: ReturnType<typeof stubClient>["client"], ttlS = 30) {
  const k = new LeaseKeeper({ client, sid: "s1", ttlS, timers: clock });
  const lost: Error[] = [];
  return { k, lost, watch: () => k.onLost((e) => lost.push(e)) };
}

describe("LeaseKeeper", () => {
  test("adopt renews at once with ttl_s, then every ttl/3 from each renew's send time", async () => {
    const stub = stubClient(ok);
    const { k } = keeper(stub.client);
    const t0 = clock.now();
    k.adopt({ leaseId: "L" });
    await tick();
    await run(30_000);
    expect(stub.renews.map((r) => [r.at - t0, r.ttlS, r.leaseId])).toEqual([
      [0, 30, "L"],
      [10_000, 30, "L"],
      [20_000, 30, "L"],
      [30_000, 30, "L"],
    ]);
    await k.release();
  });

  test("against the store: the handed lease stays alive under the engine token", async () => {
    const g = store.grant("s1", { ttlS: 30 });
    const client = new SessionStoreClient({ baseUrl: store.url, tokenProvider: () => g.token });
    const k = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    k.adopt({ leaseId: g.leaseId });
    for (let i = 0; i < 6; i++) {
      // Renewed in the store, and the keeper has scheduled the next renew.
      while (store.lease("s1")?.expiresAt !== clock.now() + 30_000 || clock.pending() < 2) await tick();
      clock.advance(10_000);
    }
    expect(store.lease("s1")!.id).toBe(g.leaseId);
    expect(k.signal.aborted).toBe(false);
    await k.release();
    expect(store.lease("s1")).toBeNull();
  });

  test("slow failing renews: the lease is lost before ttl of silence, once, and each renew's timeout stops at the deadline", async () => {
    const stub = stubClient(failAfter(8_000));
    const { k, lost, watch } = keeper(stub.client);
    const t0 = clock.now();
    watch();
    k.adopt({ leaseId: "L" });
    await run(24_000);
    expect(lost).toEqual([]);
    await run(1_000);
    expect(lost).toHaveLength(1);
    expect(clock.now() - t0).toBe(25_000); // ttl − max(1 s, ttl/6)
    expect(lost[0]).toBeInstanceOf(LeaseLostError);
    expect(k.signal.aborted).toBe(true);
    for (const r of stub.renews) expect(r.at - t0 + r.timeoutMs!).toBeLessThanOrEqual(25_000);
    await run(60_000);
    expect(lost).toHaveLength(1);
  });

  test("a renew that never answers cannot hold the lease past the deadline", async () => {
    const stub = stubClient(never);
    const { k, lost, watch } = keeper(stub.client);
    watch();
    k.adopt({ leaseId: "L" });
    await tick();
    expect(stub.renews[0]!.timeoutMs).toBe(25_000);
    await run(25_000);
    expect(lost).toHaveLength(1);
  });

  test("the deadline counts from when a renew was sent, not when it was answered", async () => {
    let n = 0;
    const stub = stubClient(() => (n++ === 0 ? after(4_000, () => ({})) : never()));
    const { k, lost, watch } = keeper(stub.client);
    watch();
    k.adopt({ leaseId: "L" });
    await run(24_000);
    expect(lost).toEqual([]);
    await run(1_000);
    expect(lost).toHaveLength(1);
  });

  test("the store's expires_at can only bring the deadline forward", async () => {
    const shorter = stubClient(async () => ({ expiresAt: clock.now() + 12_000 }));
    const a = keeper(shorter.client);
    a.watch();
    a.k.adopt({ leaseId: "L" });
    await run(6_000);
    expect(a.lost).toEqual([]);
    await run(1_000); // 12 s − the 5 s margin
    expect(a.lost).toHaveLength(1);

    let first = true;
    const longer = stubClient(async () => (first ? ((first = false), { expiresAt: clock.now() + 120_000 }) : never()));
    const b = keeper(longer.client);
    b.watch();
    b.k.adopt({ leaseId: "M" });
    await run(25_000);
    expect(b.lost).toHaveLength(1);
  });

  test("lease_lost on a renew: onLost once, the signal aborts with it, leaseId throws it, renewing stops", async () => {
    const gone = new LeaseLostError("lost", 409, "lease_lost");
    const stub = stubClient(async () => {
      throw gone;
    });
    const { k, lost, watch } = keeper(stub.client);
    watch();
    k.adopt({ leaseId: "L" });
    await tick();
    expect(lost).toEqual([gone]);
    expect(k.signal.reason).toBe(gone);
    expect(() => k.leaseId).toThrow(gone);
    await run(60_000);
    expect(stub.renews).toHaveLength(1);
    const late: Error[] = [];
    k.onLost((e) => late.push(e));
    expect(late).toEqual([gone]);
    await k.release();
    expect(stub.releases()).toBe(0);
  });

  test("a lease lost to its deadline surfaces as a LeaseLostError too", async () => {
    const { k } = keeper(stubClient(never).client);
    k.adopt({ leaseId: "L" });
    await run(25_000);
    let err: unknown;
    try {
      void k.leaseId;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LeaseLostError);
    expect(k.signal.reason).toBe(err);
  });

  test("an unreachable store is tolerated while a later renew lands before the deadline", async () => {
    let n = 0;
    const stub = stubClient(async () => {
      if (n++ < 2) throw new StoreUnreachableError("down", 1);
      return {};
    });
    const { k, lost, watch } = keeper(stub.client);
    watch();
    k.adopt({ leaseId: "L" });
    await run(60_000);
    expect(lost).toEqual([]);
    await k.release();
  });

  test("adopt while holding: the old renew chain stops, and the new lease gets a fresh signal", async () => {
    const stub = stubClient(ok);
    const { k } = keeper(stub.client);
    k.adopt({ leaseId: "L1" });
    const first = k.signal;
    await run(10_000);
    const before = stub.renews.length;
    k.adopt({ leaseId: "L2" });
    const second = k.signal;
    expect(second).not.toBe(first);
    await run(30_000);
    expect(stub.renews.slice(before).map((r) => r.leaseId)).toEqual(["L2", "L2", "L2", "L2"]);
    expect(clock.pending()).toBe(2); // one renew and one deadline: the old chain is gone
    expect(first.aborted).toBe(false);
    await k.release();
  });

  test("release gives the lease back and stops every timer", async () => {
    const stub = stubClient(ok);
    const { k } = keeper(stub.client);
    k.adopt({ leaseId: "L" });
    await tick();
    await k.release();
    expect(stub.releases()).toBe(1);
    expect(clock.pending()).toBe(0);
    expect(k.signal.aborted).toBe(false);
    expect(() => k.leaseId).toThrow();
  });
});
