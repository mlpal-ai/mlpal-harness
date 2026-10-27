import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LeaseHeldError, LeaseLostError, SessionStoreClient, StoreUnreachableError } from "../src/store/remote/client";
import { LeaseKeeper } from "../src/store/remote/lease";
import { FakeClock } from "./fake-clock";
import { type FakeSessionStore, startFakeSessionStore } from "./fake-session-store";

let clock: FakeClock;
let store: FakeSessionStore;
let client: SessionStoreClient;

beforeEach(() => {
  clock = new FakeClock();
  store = startFakeSessionStore({ clock: clock.now });
  store.createSession("s1");
  client = new SessionStoreClient({ baseUrl: store.url, tokenProvider: () => store.token });
});
afterEach(async () => {
  await store.stop();
});

const tick = () => new Promise((r) => setTimeout(r, 1));

/** Runs the manual clock forward one pending timer at a time until `p` settles. */
async function drive<T>(p: Promise<T>, step: number, between?: () => Promise<unknown>): Promise<T> {
  let settled = false;
  const done = p.finally(() => (settled = true));
  done.catch(() => {});
  while (!settled) {
    if (clock.pending() > 0) {
      clock.advance(step);
      await between?.();
    }
    await tick();
  }
  return done;
}

/** A client whose renew answers come from the test. */
function stubClient(renew: () => Promise<{ expiresAt: string }>) {
  const calls = { renew: 0, release: 0 };
  return {
    calls,
    client: {
      lease: async () => ({ leaseId: "L", expiresAt: "", lastSeq: 0 }),
      renew: async () => (calls.renew++, renew()),
      release: async () => void calls.release++,
    },
  };
}

describe("LeaseKeeper", () => {
  test("acquire takes the lease; the signal is live", async () => {
    const keeper = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    const got = await keeper.acquire("engine:test:1");
    expect(got).toEqual({ leaseId: store.lease("s1")!.id, lastSeq: 0 });
    expect(keeper.leaseId).toBe(got.leaseId);
    expect(store.lease("s1")!.holder).toBe("engine:test:1");
    expect(keeper.signal.aborted).toBe(false);
    await keeper.release();
  });

  test("a held lease is waited out, polling every ttl/6, and taken once the holder lapses", async () => {
    await client.lease("s1", { holder: "dead-engine", ttlS: 30 });
    const t0 = clock.now();
    const keeper = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    const got = await drive(keeper.acquire("engine:b:2"), 5_000);
    expect(clock.now() - t0).toBe(30_000);
    expect(store.lease("s1")).toMatchObject({ id: got.leaseId, holder: "engine:b:2" });
    await keeper.release();
  });

  test("a holder that keeps renewing outlasts the wait: acquire throws LeaseHeldError after ttl", async () => {
    const other = await client.lease("s1", { holder: "live-engine", ttlS: 30 });
    const t0 = clock.now();
    const keeper = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    const err = await drive(keeper.acquire("engine:b:2"), 5_000, () => client.renew("s1", other.leaseId)).catch((e) => e);
    expect(err).toBeInstanceOf(LeaseHeldError);
    expect(clock.now() - t0).toBe(30_000);
    expect(store.lease("s1")!.holder).toBe("live-engine");
  });

  test("renews every ttl/3 on the timer, against the real lease", async () => {
    const keeper = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    await keeper.acquire("engine:test:1");
    for (let i = 0; i < 6; i++) {
      clock.advance(10_000);
      while (store.lease("s1")?.expiresAt !== clock.now() + 30_000) await tick();
    }
    expect(store.lease("s1")!.id).toBe(keeper.leaseId);
    await keeper.release();
  });

  test("renew cadence: nothing before ttl/3, then one renew per ttl/3", async () => {
    const stub = stubClient(async () => ({ expiresAt: "" }));
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
      if (up) return { expiresAt: "" };
      throw new StoreUnreachableError("down", 1);
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
    const keeper = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    await keeper.acquire("engine:test:1");
    await keeper.release();
    expect(store.lease("s1")).toBeNull();
    expect(clock.pending()).toBe(0);
    expect(keeper.signal.aborted).toBe(false);
    expect(() => keeper.leaseId).toThrow();
  });
});
