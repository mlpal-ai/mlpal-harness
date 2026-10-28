/**
 * W3 P5: the engine's client for the memory store (contracts/P5-memory-store.md), against the fake: the grant at
 * the boundary, checkpoints to the run's staging with the session and run on every request, the bearer read per
 * request (rotation), one re-read on a 401, the error classes by code, reads overlaying staging and shared stores,
 * and promotion in both modes, idempotent per run.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MemoryGrantError,
  MemoryScopeForbiddenError,
  MemoryStoreClient,
  MemoryStoreError,
  MemoryStoreFullError,
  MemoryUnauthenticatedError,
  MemoryUnavailableError,
  MemoryUnknownError,
  MemoryVersionConflictError,
  MemoryWriteTooLargeError,
  parseMemoryGrant,
} from "../src/store/memory-store";
import { type FakeEngineClaims, type FakeMemoryStore, startFakeMemoryStore } from "./fake-memory-store";

const STORE = "hop:infra/cust_7";
const SHARED = "hop:runbooks";
const att = { sid: "sess-1", runId: "run-1", hop: "infra@1.2.0", origin: "api" };

let fake: FakeMemoryStore;
let token: string;
const claims = (over: Partial<FakeEngineClaims> = {}): FakeEngineClaims => ({ sid: "sess-1", runId: "run-1", store: STORE, shared: [{ scope_id: SHARED, access: "read" }], promotion: "auto", limits: { max_write_bytes: 4096, max_nodes: 50 }, ...over });
const client = (tokenProvider: () => string = () => token) => new MemoryStoreClient({ baseUrl: fake.url, tokenProvider });
const ck = (event_id: string, items: Array<Record<string, unknown>>) => ({ event_id, workspace: "infra", claims: items });
const claim = (key: string, value: string, extra: Record<string, unknown> = {}) => ({ kind: "learning", topic: "infra/learning", key, value, evidence_ids: ["run:sess-1"], ...extra });

beforeEach(() => {
  fake = startFakeMemoryStore();
  token = fake.mintEngine(claims());
});
afterEach(async () => {
  await fake.stop();
});

describe("parseMemoryGrant", () => {
  const wire = { url: "http://memory.harness/v1", org: "unit_root", store: STORE, shared: [{ scope_id: SHARED, access: "read" }], promotion: "review", limits: { max_nodes: 5000, max_bytes: 10485760, max_write_bytes: 65536 } };

  test("null is no memory policy; the wire shape becomes the typed grant", () => {
    expect(parseMemoryGrant(null)).toBeNull();
    expect(parseMemoryGrant(wire)).toEqual({ url: "http://memory.harness/v1", org: "unit_root", store: STORE, shared: [{ scopeId: SHARED, access: "read" }], promotion: "review", limits: { maxNodes: 5000, maxBytes: 10485760, maxWriteBytes: 65536 } });
  });

  test("unknown fields are ignored; a missing shared list is none", () => {
    const { shared: _s, ...rest } = wire;
    expect(parseMemoryGrant({ ...rest, extra: 1 })?.shared).toEqual([]);
  });

  test("a grant the engine cannot act on is refused at the boundary, naming the field", () => {
    for (const [bad, field] of [
      [{ ...wire, url: "ftp://x" }, "url"],
      [{ ...wire, store: "" }, "store"],
      [{ ...wire, promotion: "sometimes" }, "promotion"],
      [{ ...wire, shared: [{ scope_id: SHARED, access: "write" }] }, "shared[0].access"],
      [{ ...wire, limits: { ...wire.limits, max_write_bytes: -1 } }, "limits.max_write_bytes"],
      ["grant", "memory"],
    ] as const) {
      expect(() => parseMemoryGrant(bad)).toThrow(MemoryGrantError);
      try {
        parseMemoryGrant(bad);
      } catch (e) {
        expect((e as MemoryGrantError).field).toBe(field);
      }
    }
  });
});

describe("MemoryStoreClient: checkpoints", () => {
  test("a checkpoint lands in the run's staging, carrying the sid and the run id, under the engine bearer", async () => {
    const answer = await client().checkpoint(ck("ck:sess-1:1", [claim("deploy", "Deploy via kubectl.")]), att);
    expect(answer.event_id).toBe("ck:sess-1:1");
    expect(answer.claims.accepted).toBe(1);
    expect(fake.staged(STORE, "run-1").map((n) => [n.key, n.stamp.sid, n.stamp.run_id])).toEqual([["deploy", "sess-1", "run-1"]]);
    expect(fake.promoted(STORE)).toEqual([]);
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe("/v1/memory/checkpoint");
    expect(req.headers).toMatchObject({ authorization: `Bearer ${token}`, "x-session-id": "sess-1", "x-run-id": "run-1", "x-hop": "infra@1.2.0", "x-origin": "api", "content-type": "application/json" });
    expect(req.body).toEqual(ck("ck:sess-1:1", [claim("deploy", "Deploy via kubectl.")]));
  });

  test("the bearer is read per request: a rotated token file is used by the next call", async () => {
    let current = token;
    const c = client(() => current);
    await c.checkpoint(ck("ck:1", [claim("a", "x")]), att);
    current = fake.mintEngine(claims());
    await c.checkpoint(ck("ck:2", [claim("b", "y")]), att);
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${token}`, `Bearer ${current}`]);
  });

  test("a 401 re-reads the token once: a token rotated meanwhile is taken, and the call succeeds", async () => {
    const fresh = fake.mintEngine(claims());
    let reads = 0;
    const c = client(() => (++reads === 1 ? "expired" : fresh));
    await c.checkpoint(ck("ck:1", [claim("a", "x")]), att);
    expect(reads).toBe(2);
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual(["Bearer expired", `Bearer ${fresh}`]);
  });

  test("a second 401 gives up: MemoryUnauthenticatedError, after exactly two requests", async () => {
    let reads = 0;
    const c = client(() => {
      reads += 1;
      return "expired";
    });
    const e = await c.checkpoint(ck("ck:1", [claim("a", "x")]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnauthenticatedError);
    expect((e as MemoryStoreError).code).toBe("unauthenticated");
    expect(reads).toBe(2);
    expect(fake.requests).toHaveLength(2);
  });

  test("a checkpoint over max_write_bytes is 413 write_too_large and nothing is staged", async () => {
    const e = await client().checkpoint(ck("ck:big", [claim("big", "x".repeat(5000))]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryWriteTooLargeError);
    expect((e as MemoryStoreError).status).toBe(413);
    expect(fake.staged(STORE, "run-1")).toEqual([]);
  });

  test("expected_version: 0 creates; a stale version is 409 version_conflict with the current version, nothing written", async () => {
    const c = client();
    await c.checkpoint(ck("ck:1", [claim("owner", "ops", { expected_version: 0 })]), att);
    const e = await c.checkpoint(ck("ck:2", [claim("owner", "sre", { expected_version: 0 }), claim("other", "z")]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryVersionConflictError);
    expect((e as MemoryVersionConflictError).key).toBe("owner");
    expect((e as MemoryVersionConflictError).currentVersion).toBe(1);
    expect(fake.staged(STORE, "run-1").map((n) => [n.key, n.value])).toEqual([["owner", "ops"]]);
    await c.checkpoint(ck("ck:3", [claim("owner", "sre", { expected_version: 1 })]), att);
    expect(fake.staged(STORE, "run-1").map((n) => [n.key, n.value, n.version])).toEqual([["owner", "sre", 2]]);
  });

  test("a retried checkpoint (same event_id) is a duplicate, not a second write", async () => {
    const c = client();
    await c.checkpoint(ck("ck:1", [claim("a", "x")]), att);
    const again = await c.checkpoint(ck("ck:1", [claim("a", "x")]), att);
    expect(again.claims).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(fake.staged(STORE, "run-1")).toHaveLength(1);
  });

  test("errors map to their class by code; an unreachable store is MemoryUnavailableError", async () => {
    const cases: Array<[number, string, new (...a: never[]) => MemoryStoreError]> = [
      [403, "scope_forbidden", MemoryScopeForbiddenError],
      [404, "unknown_store", MemoryUnknownError],
      [404, "unknown_run", MemoryUnknownError],
      [503, "store_unavailable", MemoryUnavailableError],
    ];
    for (const [status, code, cls] of cases) {
      fake.fail("checkpoint", status, code);
      const e = await client().checkpoint(ck(`ck:${code}`, [claim("a", "x")]), att).catch((x) => x);
      expect(e).toBeInstanceOf(cls);
      expect([(e as MemoryStoreError).status, (e as MemoryStoreError).code]).toEqual([status, code]);
    }
    const down = new MemoryStoreClient({ baseUrl: "http://127.0.0.1:9/v1", tokenProvider: () => token, timeoutMs: 2000 });
    const e = await down.checkpoint(ck("ck:x", [claim("a", "x")]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnavailableError);
    expect((e as MemoryStoreError).code).toBe("unreachable");
  });

  test("a 5xx without the envelope keeps its status as the code", async () => {
    const c = new MemoryStoreClient({ baseUrl: fake.url, tokenProvider: () => token, fetch: async () => new Response("bad gateway", { status: 502 }) });
    const e = await c.checkpoint(ck("ck:1", [claim("a", "x")]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnavailableError);
    expect((e as MemoryStoreError).code).toBe("http_502");
  });
});

describe("MemoryStoreClient: reads", () => {
  test("search overlays the run's staging on the promoted store and includes the granted shared stores", async () => {
    fake.seed(STORE, [{ topic: "infra/learning", key: "deploy", value: "deploy with helm" }]);
    fake.seed(SHARED, [{ topic: "runbooks/learning", key: "pager", value: "deploy freeze on fridays" }]);
    fake.seed("hop:someone-else", [{ topic: "x", key: "secret", value: "deploy elsewhere" }]);
    const c = client();
    await c.checkpoint(ck("ck:1", [claim("deploy", "deploy with kubectl")]), att);
    const r = await c.search({ q: "deploy", limit: 10 }, att);
    expect(r.nodes.map((n) => [n.key, n.summary, n.scope_id])).toEqual([
      ["deploy", "deploy with kubectl", `${STORE}/run/run-1`],
      ["pager", "deploy freeze on fridays", SHARED],
    ]);
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe("/v1/memory/search?q=deploy&limit=10");
    expect(req.headers).toMatchObject({ "x-session-id": "sess-1", "x-run-id": "run-1" });
  });

  test("search passes type and as_of through, and leaves out what is unset", async () => {
    await client().search({ q: "x", type: "state", asOf: "2026-10-01T00:00:00Z" }, att);
    expect(fake.requests.at(-1)!.path).toBe("/v1/memory/search?q=x&type=state&as_of=2026-10-01T00%3A00%3A00Z");
  });

  test("projection renders the same overlay as the prompt section's MemoryProjection", async () => {
    fake.seed(STORE, [{ topic: "infra/state", key: "region", value: "eu-west-1" }]);
    const p = await client().projection({ workspace: "infra", hop: "infra", inject: ["infra/state"], tokenBudget: 1500 }, att);
    expect(p.factCount).toBe(1);
    expect(p.markdown).toContain("eu-west-1");
    expect(p.truncated).toBe(false);
    expect(fake.requests.at(-1)!.path).toBe("/v1/memory/projection?workspace=infra&hop=infra&token_budget=1500&inject=infra%2Fstate");
  });
});

describe("MemoryStoreClient: promotion", () => {
  test("auto: the staged nodes move into the store, one store version, and a repeat answers the same body", async () => {
    const c = client();
    await c.checkpoint(ck("ck:1", [claim("a", "x"), claim("b", "y")]), att);
    const before = fake.storeVersion(STORE);
    const r = await c.promote(STORE, "run-1", att);
    expect(r).toEqual({ state: "promoted", storeVersion: before + 1, promoted: 2 });
    expect(fake.promoted(STORE).map((n) => n.key).sort()).toEqual(["a", "b"]);
    expect(await c.promote(STORE, "run-1", att)).toEqual(r);
    expect(fake.promotions()).toBe(1);
    expect(fake.storeVersion(STORE)).toBe(before + 1);
    expect(fake.requests.at(-1)!.path).toBe(`/v1/memory/stores/${encodeURIComponent(STORE)}/runs/run-1/promote`);
  });

  test("review: a proposal is pending with its id; nothing reaches the store until it is approved", async () => {
    token = fake.mintEngine(claims({ promotion: "review" }));
    const c = client();
    await c.checkpoint(ck("ck:1", [claim("a", "x")]), att);
    const r = await c.promote(STORE, "run-1", att);
    expect(r).toEqual({ state: "pending", proposalId: "prop_1" });
    expect(fake.promoted(STORE)).toEqual([]);
    fake.decide("prop_1", "approve");
    expect(fake.promoted(STORE).map((n) => n.key)).toEqual(["a"]);
  });

  test("a run with nothing staged is empty", async () => {
    expect(await client().promote(STORE, "run-1", att)).toEqual({ state: "empty" });
  });

  test("a promotion past max_nodes is 413 store_full and nothing is promoted", async () => {
    token = fake.mintEngine(claims({ limits: { max_nodes: 1 } }));
    const c = client();
    await c.checkpoint(ck("ck:1", [claim("a", "x"), claim("b", "y")]), att);
    const e = await c.promote(STORE, "run-1", att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryStoreFullError);
    expect(fake.promoted(STORE)).toEqual([]);
  });

  test("an answer the contract does not define is an error, never a guessed state", async () => {
    const c = new MemoryStoreClient({ baseUrl: fake.url, tokenProvider: () => token, fetch: async () => Response.json({ state: "maybe" }) });
    const e = await c.promote(STORE, "run-1", att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryStoreError);
    expect((e as MemoryStoreError).code).toBe("invalid_response");
  });
});
