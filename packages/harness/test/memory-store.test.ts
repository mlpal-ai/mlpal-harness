/**
 * W3 P5: the engine's client for the memory store (contracts/P5-memory-store.md 1.2), against the fake: the grant at
 * the boundary, checkpoints to the run's staging with the session and run on every request, the bearer read per
 * request (rotation), one re-read on a 401, the `{detail: {code, …}}` envelope by class, preconditions against the
 * promoted store on keyed kinds only, reads overlaying staging and shared stores, and promotion in both modes,
 * idempotent per run, with its conflicts and limits.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MemoryGrantError,
  MemoryInvalidPreconditionError,
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
const learning = (key: string, value: string, extra: Record<string, unknown> = {}) => ({ kind: "learning", topic: "infra/learning", key, value, evidence_ids: ["run:sess-1"], ...extra });
const state = (key: string, value: string, extra: Record<string, unknown> = {}) => ({ kind: "state", topic: "infra/state", key, value, evidence_ids: ["run:sess-1"], ...extra });
const answering = (status: number, body: unknown) => new MemoryStoreClient({ baseUrl: fake.url, tokenProvider: () => token, fetch: async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }) });

beforeEach(() => {
  fake = startFakeMemoryStore();
  token = fake.mintEngine(claims());
});
afterEach(async () => {
  await fake.stop();
});

describe("parseMemoryGrant", () => {
  const wire = { url: "http://memory.harness/api/v1", org: "unit_root", store: STORE, shared: [{ scope_id: SHARED, access: "read" }], promotion: "review", limits: { max_nodes: 5000, max_bytes: 10485760, max_write_bytes: 65536 } };

  test("null is no memory policy; the wire shape becomes the typed grant, its url the full base", () => {
    expect(parseMemoryGrant(null)).toBeNull();
    expect(parseMemoryGrant(wire)).toEqual({ url: "http://memory.harness/api/v1", org: "unit_root", store: STORE, shared: [{ scopeId: SHARED, access: "read" }], promotion: "review", limits: { maxNodes: 5000, maxBytes: 10485760, maxWriteBytes: 65536 } });
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
    const answer = await client().checkpoint(ck("ck:sess-1:1", [learning("deploy", "Deploy via kubectl.")]), att);
    expect(answer.event_id).toBe("ck:sess-1:1");
    expect(answer.claims.accepted).toBe(1);
    expect(fake.staged(STORE, "run-1").map((n) => [n.key, n.scope_id, n.stamp.sid, n.stamp.run_id])).toEqual([["deploy", "infra/cust_7/run/run-1", "sess-1", "run-1"]]);
    expect(fake.promoted(STORE)).toEqual([]);
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe("/api/v1/memory/checkpoint");
    expect(req.headers).toMatchObject({ authorization: `Bearer ${token}`, "x-session-id": "sess-1", "x-run-id": "run-1", "x-hop": "infra@1.2.0", "x-origin": "api", "content-type": "application/json" });
    expect(req.body).toEqual(ck("ck:sess-1:1", [learning("deploy", "Deploy via kubectl.")]));
  });

  test("the bearer is read per request: a rotated token file is used by the next call", async () => {
    let current = token;
    const c = client(() => current);
    await c.checkpoint(ck("ck:1", [learning("a", "x")]), att);
    current = fake.mintEngine(claims());
    await c.checkpoint(ck("ck:2", [learning("b", "y")]), att);
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${token}`, `Bearer ${current}`]);
  });

  test("a 401 re-reads the token once: a token rotated meanwhile is taken, and the call succeeds", async () => {
    const fresh = fake.mintEngine(claims());
    let reads = 0;
    const c = client(() => (++reads === 1 ? "expired" : fresh));
    await c.checkpoint(ck("ck:1", [learning("a", "x")]), att);
    expect(reads).toBe(2);
    expect(fake.requests.map((r) => r.headers.authorization)).toEqual(["Bearer expired", `Bearer ${fresh}`]);
  });

  test("a second 401 gives up: MemoryUnauthenticatedError, after exactly two requests", async () => {
    let reads = 0;
    const c = client(() => {
      reads += 1;
      return "expired";
    });
    const e = await c.checkpoint(ck("ck:1", [learning("a", "x")]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnauthenticatedError);
    expect((e as MemoryStoreError).code).toBe("unauthenticated");
    expect(reads).toBe(2);
    expect(fake.requests).toHaveLength(2);
  });

  test("a checkpoint over max_write_bytes is 413 write_too_large {size, limit} and nothing is staged", async () => {
    const e = await client().checkpoint(ck("ck:big", [learning("big", "x".repeat(5000))]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryWriteTooLargeError);
    expect((e as MemoryWriteTooLargeError).limit).toBe(4096);
    expect((e as MemoryWriteTooLargeError).size).toBeGreaterThan(5000);
    expect(fake.staged(STORE, "run-1")).toEqual([]);
  });

  test("expected_version is checked against the promoted store, never the run's own staging", async () => {
    fake.seed(STORE, [{ kind: "state", topic: "infra/state", key: "owner", value: "ops" }]);
    const c = client();
    const e = await c.checkpoint(ck("ck:1", [state("owner", "sre", { expected_version: 0 }), learning("other", "z")]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryVersionConflictError);
    expect([(e as MemoryVersionConflictError).key, (e as MemoryVersionConflictError).currentVersion]).toEqual(["owner", 1]);
    expect(fake.staged(STORE, "run-1")).toEqual([]);
    await c.checkpoint(ck("ck:2", [state("owner", "sre", { expected_version: 1 })]), att);
    // Staged, the key is still at 1 in the store: a second precondition of this run checks the same.
    await c.checkpoint(ck("ck:3", [state("owner", "dev", { expected_version: 1 })]), att);
    expect(fake.staged(STORE, "run-1").map((n) => [n.key, n.value])).toEqual([["owner", "dev"]]);
  });

  test("expected_version: 0 means the key must not exist yet in the store", async () => {
    const c = client();
    await c.checkpoint(ck("ck:1", [state("fresh", "a", { expected_version: 0 })]), att);
    await c.checkpoint(ck("ck:2", [state("fresh", "b", { expected_version: 0 })]), att);
    expect(fake.staged(STORE, "run-1").map((n) => n.value)).toEqual(["b"]);
  });

  test("the version counts distinct values: re-observing the current value does not bump it", async () => {
    fake.seed(STORE, [{ kind: "state", topic: "infra/state", key: "region", value: "eu" }]);
    fake.seed(STORE, [{ kind: "state", topic: "infra/state", key: "region", value: "eu" }]);
    expect(fake.promoted(STORE).map((n) => [n.key, n.version])).toEqual([["region", 1]]);
    fake.seed(STORE, [{ kind: "state", topic: "infra/state", key: "region", value: "us" }]);
    expect(fake.promoted(STORE).map((n) => [n.key, n.version])).toEqual([["region", 2]]);
  });

  test("expected_version on a learning is 422 invalid_precondition {key}", async () => {
    const e = await client().checkpoint(ck("ck:1", [learning("k", "v", { expected_version: 0 })]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryInvalidPreconditionError);
    expect((e as MemoryInvalidPreconditionError).key).toBe("k");
  });

  test("note sections are not staged: 422 note_not_staged, nothing written", async () => {
    const e = await client().checkpoint({ event_id: "ck:1", workspace: "w", claims: [learning("a", "x")], note: { Now: "x" } }, att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryStoreError);
    expect([(e as MemoryStoreError).status, (e as MemoryStoreError).code]).toEqual([422, "note_not_staged"]);
    expect(fake.staged(STORE, "run-1")).toEqual([]);
  });

  test("a retried checkpoint (same event_id) is a duplicate, not a second write", async () => {
    const c = client();
    await c.checkpoint(ck("ck:1", [learning("a", "x")]), att);
    const again = await c.checkpoint(ck("ck:1", [learning("a", "x")]), att);
    expect(again.claims).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(fake.staged(STORE, "run-1")).toHaveLength(1);
  });

  test("errors map to their class by detail.code; an unreachable store is MemoryUnavailableError", async () => {
    const cases: Array<[number, string, new (...a: never[]) => MemoryStoreError]> = [
      [403, "scope_forbidden", MemoryScopeForbiddenError],
      [404, "unknown_store", MemoryUnknownError],
      [404, "unknown_run", MemoryUnknownError],
      [503, "store_unavailable", MemoryUnavailableError],
    ];
    for (const [status, code, cls] of cases) {
      fake.fail("checkpoint", status, code);
      const e = await client().checkpoint(ck(`ck:${code}`, [learning("a", "x")]), att).catch((x) => x);
      expect(e).toBeInstanceOf(cls);
      expect([(e as MemoryStoreError).status, (e as MemoryStoreError).code]).toEqual([status, code]);
    }
    const down = new MemoryStoreClient({ baseUrl: "http://127.0.0.1:9/api/v1", tokenProvider: () => token, timeoutMs: 2000 });
    const e = await down.checkpoint(ck("ck:x", [learning("a", "x")]), att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryUnavailableError);
    expect((e as MemoryStoreError).code).toBe("unreachable");
  });

  test("a body that is not the P5 envelope keeps its status as the code: no body, a string detail, pydantic's list", async () => {
    for (const [status, body, cls] of [
      [502, "bad gateway", MemoryUnavailableError],
      [400, { detail: "a legacy refusal" }, MemoryStoreError],
      [422, { detail: [{ loc: ["body", "event_id"], msg: "field required", type: "missing" }] }, MemoryStoreError],
      [409, { code: "version_conflict", key: "k", current_version: 3 }, MemoryStoreError],
    ] as const) {
      const e = await answering(status, body).checkpoint(ck("ck:1", [learning("a", "x")]), att).catch((x) => x);
      expect(e).toBeInstanceOf(cls);
      expect(e).not.toBeInstanceOf(MemoryVersionConflictError);
      expect((e as MemoryStoreError).code).toBe(`http_${status}`);
    }
  });
});

describe("MemoryStoreClient: reads", () => {
  test("search overlays the run's staging on the promoted store and includes the granted shared stores", async () => {
    fake.seed(STORE, [{ topic: "infra/learning", key: "deploy", value: "deploy with helm" }]);
    fake.seed(SHARED, [{ topic: "runbooks/learning", key: "pager", value: "deploy freeze on fridays" }]);
    fake.seed("hop:someone-else", [{ topic: "x", key: "secret", value: "deploy elsewhere" }]);
    const c = client();
    await c.checkpoint(ck("ck:1", [learning("deploy", "deploy with kubectl")]), att);
    const r = await c.search({ q: "deploy", limit: 10 }, att);
    expect(r.nodes.map((n) => [n.key, n.summary, n.scope_id])).toEqual([
      ["deploy", "deploy with kubectl", "infra/cust_7/run/run-1"],
      ["pager", "deploy freeze on fridays", "runbooks"],
    ]);
    const req = fake.requests.at(-1)!;
    expect(req.path).toBe("/api/v1/memory/search?q=deploy&limit=10");
    expect(req.headers).toMatchObject({ "x-session-id": "sess-1", "x-run-id": "run-1" });
  });

  test("search passes type and as_of through, and leaves out what is unset", async () => {
    await client().search({ q: "x", type: "state", asOf: "2026-10-01T00:00:00Z" }, att);
    expect(fake.requests.at(-1)!.path).toBe("/api/v1/memory/search?q=x&type=state&as_of=2026-10-01T00%3A00%3A00Z");
  });

  test("projection renders the same overlay as the prompt section's MemoryProjection", async () => {
    fake.seed(STORE, [{ kind: "state", topic: "infra/state", key: "region", value: "eu-west-1" }]);
    const p = await client().projection({ workspace: "infra", hop: "infra", inject: ["infra/state"], tokenBudget: 1500 }, att);
    expect(p.factCount).toBe(1);
    expect(p.markdown).toContain("eu-west-1");
    expect(p.truncated).toBe(false);
    expect(fake.requests.at(-1)!.path).toBe("/api/v1/memory/projection?workspace=infra&hop=infra&token_budget=1500&inject=infra%2Fstate");
  });
});

describe("MemoryStoreClient: promotion", () => {
  test("auto: the staged claims fold into the store, one store version; a repeat answers the same body; the path keeps the store's slash", async () => {
    const c = client();
    await c.checkpoint(ck("ck:1", [learning("a", "x"), state("b", "y")]), att);
    const r = await c.promote(STORE, "run-1", att);
    expect(r).toEqual({ state: "promoted", storeVersion: 1, promoted: 2, conflicts: [] });
    expect(fake.promoted(STORE).map((n) => n.key).sort()).toEqual(["a", "b"]);
    expect(await c.promote(STORE, "run-1", att)).toEqual(r);
    expect(fake.promotions()).toBe(1);
    expect(fake.storeVersion(STORE)).toBe(1);
    expect(fake.requests.at(-1)!.path).toBe("/api/v1/memory/stores/hop:infra/cust_7/runs/run-1/promote");
  });

  test("review: pending with its proposal id (200); nothing reaches the store until it is approved", async () => {
    token = fake.mintEngine(claims({ promotion: "review" }));
    const c = client();
    await c.checkpoint(ck("ck:1", [learning("a", "x")]), att);
    const r = await c.promote(STORE, "run-1", att);
    expect(r.state).toBe("pending");
    const id = (r as { proposalId: string }).proposalId;
    expect(id).toMatch(/^proposal:[0-9a-f]{40}$/);
    expect(fake.promoted(STORE)).toEqual([]);
    fake.decide(id, "approve");
    expect(fake.promoted(STORE).map((n) => n.key)).toEqual(["a"]);
  });

  test("a rejected proposal answers state rejected on the repeat", async () => {
    token = fake.mintEngine(claims({ promotion: "review" }));
    const c = client();
    await c.checkpoint(ck("ck:1", [learning("a", "x")]), att);
    const { proposalId } = (await c.promote(STORE, "run-1", att)) as { proposalId: string };
    fake.decide(proposalId, "reject");
    expect(await c.promote(STORE, "run-1", att)).toEqual({ state: "rejected", proposalId });
  });

  test("a run with nothing staged is empty, with the store's version", async () => {
    expect(await client().promote(STORE, "run-1", att)).toEqual({ state: "empty", storeVersion: 0 });
  });

  test("a key the store moved since it was staged is a conflict: left staged and reported, the rest promotes", async () => {
    fake.seed(STORE, [{ kind: "state", topic: "infra/state", key: "owner", value: "ops" }]);
    const c = client();
    await c.checkpoint(ck("ck:1", [state("owner", "sre"), learning("n", "note")]), att);
    fake.seed(STORE, [{ kind: "state", topic: "infra/state", key: "owner", value: "dev" }]);
    const r = await c.promote(STORE, "run-1", att);
    expect(r).toEqual({ state: "promoted", storeVersion: 3, promoted: 1, conflicts: [{ key: "owner", topic: "infra/state", seen_version: 1, current_version: 2, staged_event_id: "ck:1:claim:0" }] });
    expect(fake.staged(STORE, "run-1").map((n) => n.key)).toEqual(["owner"]);
    expect(fake.promoted(STORE).find((n) => n.key === "owner")!.value).toBe("dev");
  });

  test("not the token's run is 404 unknown_run; not its store is 404 unknown_store", async () => {
    const run = await client().promote(STORE, "run-9", att).catch((x) => x);
    expect([run instanceof MemoryUnknownError, run.code]).toEqual([true, "unknown_run"]);
    const store = await client().promote("hop:other/c", "run-1", att).catch((x) => x);
    expect([store instanceof MemoryUnknownError, store.code]).toEqual([true, "unknown_store"]);
  });

  test("a promotion past max_nodes or max_bytes is 413 store_full {nodes|bytes, limit}; nothing is promoted", async () => {
    token = fake.mintEngine(claims({ limits: { max_nodes: 1 } }));
    let c = client();
    await c.checkpoint(ck("ck:1", [learning("a", "x"), learning("b", "y")]), att);
    const nodes = await c.promote(STORE, "run-1", att).catch((x) => x);
    expect(nodes).toBeInstanceOf(MemoryStoreFullError);
    expect([(nodes as MemoryStoreFullError).measure, (nodes as MemoryStoreFullError).limit]).toEqual(["nodes", 1]);
    token = fake.mintEngine(claims({ runId: "run-2", limits: { max_bytes: 8 } }));
    c = client();
    await c.checkpoint(ck("ck:2", [learning("c", "a value longer than eight bytes")]), { ...att, runId: "run-2" });
    const bytes = await c.promote(STORE, "run-2", { ...att, runId: "run-2" }).catch((x) => x);
    expect([(bytes as MemoryStoreFullError).measure, (bytes as MemoryStoreFullError).limit]).toEqual(["bytes", 8]);
    expect(fake.promoted(STORE)).toEqual([]);
  });

  test("an answer the contract does not define is an error, never a guessed state", async () => {
    const e = await answering(200, { state: "maybe" }).promote(STORE, "run-1", att).catch((x) => x);
    expect(e).toBeInstanceOf(MemoryStoreError);
    expect((e as MemoryStoreError).code).toBe("invalid_response");
  });
});
