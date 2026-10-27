import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LeaseGrant, LeaseLostError, SessionStoreClient, StoreUnreachableError } from "../src/store/remote/client";
import { LeaseKeeper } from "../src/store/remote/lease";
import { JsonLogger } from "../src/obs/logger";
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
  const logs: { level: string; msg: string; [k: string]: unknown }[] = [];
  const logger = new JsonLogger({ level: "debug", sink: (line) => void logs.push(JSON.parse(line)) });
  const k = new LeaseKeeper({ client, sid: "s1", ttlS, timers: clock, logger });
  const lost: Error[] = [];
  return { k, lost, logs, watch: () => k.onLost((e) => lost.push(e)) };
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
    expect(stub.renews[0]!.timeoutMs).toBe(10_000); // ttl/3: sooner than the 25 s to the deadline
    await run(25_000);
    expect(lost).toHaveLength(1);
  });

  test("one renew that answers only at its own timeout costs nothing: renews keep their cadence and the lease holds", async () => {
    let n = 0;
    const stub = stubClient((c) => (n++ === 1 ? failAfter(Number.MAX_SAFE_INTEGER)(c) : ok()));
    const { k, lost, watch } = keeper(stub.client);
    const t0 = clock.now();
    watch();
    k.adopt({ leaseId: "L" });
    await run(40_000);
    expect(lost).toEqual([]);
    expect(stub.renews.map((r) => r.at - t0)).toEqual([0, 10_000, 20_000, 30_000, 40_000]);
    expect(stub.renews[1]!.timeoutMs).toBe(10_000); // ttl/3, not the 15 s left to the deadline
    await k.release();
  });

  test("a renew that never answers at all does not hold back the next one", async () => {
    let n = 0;
    const stub = stubClient(() => (n++ === 1 ? never() : ok()));
    const { k, lost, watch } = keeper(stub.client);
    watch();
    k.adopt({ leaseId: "L" });
    await run(60_000);
    expect(lost).toEqual([]);
    expect(stub.renews).toHaveLength(7);
    await k.release();
  });

  test("a late success from an older renew never pulls back the deadline a newer one set", async () => {
    let n = 0;
    const stub = stubClient(() => (n++ === 1 ? after(15_000, () => ({})) : n <= 3 ? ok() : never()));
    const { k, lost, watch } = keeper(stub.client);
    const t0 = clock.now();
    watch();
    k.adopt({ leaseId: "L" }); // renews: 0 ok, 10 answers at 25, 20 ok; later ones hang
    await run(44_000);
    expect(lost).toEqual([]); // the renew sent at 20 holds the lease to 45
    await run(1_000);
    expect(lost).toHaveLength(1);
    expect(clock.now() - t0).toBe(45_000);
  });

  test("no renew attempt goes out after the loss, even one a busy store was making the client retry", async () => {
    const sent: number[] = [];
    const t0 = clock.now();
    const busy = async () => (sent.push(clock.now() - t0), Response.json({ code: "session_busy" }, { status: 503, headers: { "retry-after": "4" } }));
    const client = new SessionStoreClient({ baseUrl: "http://store/v1", tokenProvider: () => "t", fetch: busy, now: clock.now, sleep: clock.sleep });
    const k = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    const lost: Error[] = [];
    k.onLost((e) => lost.push(e));
    k.adopt({ leaseId: "L" });
    await run(60_000);
    expect(lost).toHaveLength(1);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((t) => t >= 25_000)).toEqual([]);
  });

  test("a store clock behind ours is logged once, and a loss on the deadline it brought forward names the skew", async () => {
    let n = 0;
    const stub = stubClient(async (c) => (n++ < 2 ? { expiresAt: c.at + 20_000 } : never()));
    const { k, lost, logs, watch } = keeper(stub.client);
    watch();
    k.adopt({ leaseId: "L" });
    await run(24_000);
    expect(lost).toEqual([]);
    await run(1_000); // 10 s + (20 s − the 5 s margin)
    expect(lost).toHaveLength(1);
    expect(lost[0]!.message).toContain("-10000 ms");
    const skew = logs.filter((l) => l.msg === "store.lease_clock_skew");
    expect(skew).toHaveLength(1);
    expect(skew[0]).toMatchObject({ level: "warn", skewMs: -10_000 });
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

  test("a wall-clock step back never loses a healthy lease", async () => {
    const stub = stubClient(ok);
    const { k, lost, watch } = keeper(stub.client, 60);
    watch();
    k.adopt({ leaseId: "L" });
    await run(30_000);
    clock.stepBack(45_000);
    await run(180_000);
    expect(lost).toEqual([]);
    await k.release();
  });

  test("the skew is logged once per adopt", async () => {
    const stub = stubClient(async (c) => ({ expiresAt: c.at + 20_000 }));
    const { k, logs } = keeper(stub.client);
    k.adopt({ leaseId: "L1" });
    await run(20_000);
    k.adopt({ leaseId: "L2" });
    await run(20_000);
    expect(logs.filter((l) => l.msg === "store.lease_clock_skew")).toHaveLength(2);
    await k.release();
  });

  /** A real client whose renews the store keeps answering busy; `sent` records each renew attempt. */
  function busyStore() {
    const sent: { at: number; leaseId: string }[] = [];
    const t0 = clock.now();
    const fetch = async (url: string) => {
      const m = /\/lease\/([^/]+)\/renew$/.exec(new URL(url).pathname);
      if (!m) return new Response(null, { status: 204 });
      sent.push({ at: clock.now() - t0, leaseId: m[1]! });
      return Response.json({ code: "session_busy" }, { status: 503, headers: { "retry-after": "4" } });
    };
    const client = new SessionStoreClient({ baseUrl: "http://store/v1", tokenProvider: () => "t", fetch, now: clock.now, sleep: clock.sleep });
    return { sent, client };
  }

  test("no renew attempt goes out after release(), even one a busy store was making the client retry", async () => {
    const { sent, client } = busyStore();
    const k = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    k.adopt({ leaseId: "L" });
    await run(2_000); // the first renew is in its Retry-After sleep
    const before = sent.length;
    await k.release();
    await run(60_000);
    expect(sent).toHaveLength(before);
  });

  test("a second adopt stops the first lease's renew still retrying", async () => {
    const { sent, client } = busyStore();
    const k = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    k.adopt({ leaseId: "L1" });
    await run(2_000);
    k.adopt({ leaseId: "L2" });
    const at = sent.length;
    await run(20_000);
    expect(sent.slice(at).map((s) => s.leaseId).filter((id) => id === "L1")).toEqual([]);
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
