import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LeaseLostError, SessionStoreClient, StoreUnreachableError } from "../src/store/remote/client";
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

/** Control leases (an engine token cannot); the keeper adopts the lease with its engine token. */
function handed(ttlS = 30): { keeper: LeaseKeeper; leaseId: string } {
  const g = store.grant("s1", { ttlS });
  const client = new SessionStoreClient({ baseUrl: store.url, tokenProvider: () => g.token });
  const keeper = new LeaseKeeper({ client, sid: "s1", ttlS, timers: clock });
  keeper.adopt({ leaseId: g.leaseId });
  return { keeper, leaseId: g.leaseId };
}

/** A client whose renew answers come from the test. */
function stubClient(renew: () => Promise<unknown>) {
  const calls = { renew: 0, release: 0 };
  return {
    calls,
    client: {
      renew: async () => (calls.renew++, renew().then(() => ({ leaseId: "L", expiresAt: 0, lastSeq: 0 }))),
      release: async () => void calls.release++,
    },
  };
}

describe("LeaseKeeper", () => {
  test("adopt holds the handed lease and renews it every ttl/3 with the engine token", async () => {
    const { keeper, leaseId } = handed(30);
    expect(keeper.leaseId).toBe(leaseId);
    expect(keeper.signal.aborted).toBe(false);
    for (let i = 0; i < 6; i++) {
      clock.advance(10_000);
      // Renewed in the store, and the keeper has scheduled the next renew.
      while (store.lease("s1")?.expiresAt !== clock.now() + 30_000 || clock.pending() === 0) await tick();
    }
    expect(store.lease("s1")!.id).toBe(leaseId);
    await keeper.release();
  });

  test("a lease that lapsed before the first renew is lost: the store never revives it", async () => {
    const { keeper } = handed(30);
    const seen: Error[] = [];
    keeper.onLost((e) => seen.push(e));
    clock.advance(31_000); // the renew at 10 s fires late, as after a stall
    while (seen.length === 0) await tick();
    expect(seen[0]).toBeInstanceOf(LeaseLostError);
    expect(keeper.signal.aborted).toBe(true);
  });

  test("renew cadence: nothing before ttl/3, then one renew per ttl/3", async () => {
    const stub = stubClient(async () => {});
    const keeper = new LeaseKeeper({ client: stub.client, sid: "s1", ttlS: 30, timers: clock });
    keeper.adopt({ leaseId: "L" });
    expect(keeper.leaseId).toBe("L");
    clock.advance(9_999);
    await tick();
    expect(stub.calls.renew).toBe(0);
    for (let i = 1; i <= 3; i++) {
      clock.advance(i === 1 ? 1 : 10_000);
      await tick();
      expect(stub.calls.renew).toBe(i);
    }
  });

  test("lease_lost on a renew: onLost fires once, the signal aborts with the error, renewing stops", async () => {
    const lost = new LeaseLostError("lost", 409, "lease_lost");
    const stub = stubClient(async () => {
      throw lost;
    });
    const keeper = new LeaseKeeper({ client: stub.client, sid: "s1", ttlS: 30, timers: clock });
    const seen: Error[] = [];
    keeper.onLost((e) => seen.push(e));
    keeper.adopt({ leaseId: "L" });
    clock.advance(10_000);
    await tick();
    expect(seen).toEqual([lost]);
    expect(keeper.signal.aborted).toBe(true);
    expect(keeper.signal.reason).toBe(lost);
    expect(clock.pending()).toBe(0);
    clock.advance(60_000);
    await tick();
    expect(stub.calls.renew).toBe(1);
    const late: Error[] = [];
    keeper.onLost((e) => late.push(e));
    expect(late).toEqual([lost]);
    await keeper.release();
    expect(stub.calls.release).toBe(0); // nothing to release: the lease is gone
    expect(seen).toHaveLength(1);
  });

  test("an unreachable store is tolerated until ttl since the last good renew, then the lease is lost", async () => {
    let up = true;
    const stub = stubClient(async () => {
      if (!up) throw new StoreUnreachableError("down", 1);
    });
    const keeper = new LeaseKeeper({ client: stub.client, sid: "s1", ttlS: 30, timers: clock });
    const seen: Error[] = [];
    keeper.onLost((e) => seen.push(e));
    keeper.adopt({ leaseId: "L" });
    clock.advance(10_000); // good renew at t=10s
    await tick();
    up = false;
    for (const t of [20_000, 30_000]) {
      clock.advance(10_000);
      await tick();
      expect(seen).toEqual([]);
    }
    clock.advance(10_000); // t=40s: 30 s since the last good renew
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(StoreUnreachableError);
    expect(keeper.signal.aborted).toBe(true);
  });

  test("release gives the lease back and stops renewing", async () => {
    const { keeper } = handed(30);
    await keeper.release();
    expect(store.lease("s1")).toBeNull();
    expect(clock.pending()).toBe(0);
    expect(keeper.signal.aborted).toBe(false);
    expect(() => keeper.leaseId).toThrow();
  });
});
