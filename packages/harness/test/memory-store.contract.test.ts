/**
 * The client and the fake against W5's P5 fixture (test/fixtures/memory-store/fixture.json, memory-graph e9b18ab,
 * contract 1.3). Every error in it goes through MemoryStoreClient and must map to its class with its fields; the
 * checkpoint and promotion answers must parse; and the fake, driven through the fixture's own flow, must answer
 * with the same bodies (ids and messages aside) under the same mount and paths.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  MemoryInvalidPreconditionError,
  MemoryScopeForbiddenError,
  MemoryStoreClient,
  MemoryStoreError,
  MemoryUnauthenticatedError,
  MemoryUnknownError,
  MemoryVersionConflictError,
  MemoryWriteTooLargeError,
} from "../src/store/memory-store";
import { type FakeEngineClaims, type FakeMemoryStore, startFakeMemoryStore } from "./fake-memory-store";
import { loadMemoryStoreFixture } from "./memory-store-fixtures";

const fx = loadMemoryStoreFixture(join(import.meta.dir, "fixtures", "memory-store", "fixture.json"))!;
const att = { sid: "sess-1", runId: "run-1" };

/** What each fixture error must become in the client: [class, the error's own fields]. */
const EXPECTED: Record<string, [abstract new (...a: never[]) => MemoryStoreError, Record<string, unknown>]> = {
  "401 unauthenticated": [MemoryUnauthenticatedError, {}],
  "403 scope_forbidden": [MemoryScopeForbiddenError, {}],
  "404 unknown_run": [MemoryUnknownError, {}],
  "409 already_decided": [MemoryStoreError, {}],
  "409 version_conflict": [MemoryVersionConflictError, { key: "queue-owner", currentVersion: 1 }],
  "413 write_too_large": [MemoryWriteTooLargeError, { size: 506, limit: 64 }],
  "422 invalid_precondition": [MemoryInvalidPreconditionError, { key: "k" }],
  // §f rollback's, a control token's route: the engine never sees it, and it maps to the base class.
  "422 invalid_version": [MemoryStoreError, {}],
  "422 note_not_staged": [MemoryStoreError, {}],
};

const answering = (status: number, body: unknown) => new MemoryStoreClient({ baseUrl: `http://memory.test${fx.mount}`, tokenProvider: () => "t", fetch: async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) });

describe("W5's fixture through the client", () => {
  test("the fixture is contract P5 and mounts at /api/v1", () => {
    expect(fx.contract).toBe("P5-memory-store");
    expect(fx.mount).toBe("/api/v1");
  });

  test("every error maps to its class, its code and its fields (an error with no expectation fails)", async () => {
    expect(fx.errors.map((e) => e.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const e of fx.errors) {
      const [cls, fields] = EXPECTED[e.name]!;
      const got = await answering(e.status, e.body).checkpoint({ event_id: "e", workspace: "w" }, att).catch((x) => x);
      expect({ name: e.name, isClass: got instanceof cls, status: got.status, code: got.code }).toEqual({ name: e.name, isClass: true, status: e.status, code: (e.body as { detail: { code: string } }).detail.code });
      for (const [k, v] of Object.entries(fields)) expect({ name: e.name, [k]: (got as unknown as Record<string, unknown>)[k] }).toEqual({ name: e.name, [k]: v });
    }
  });

  test("the checkpoint answer parses", async () => {
    const got = await answering(200, fx.checkpoint.response).checkpoint(fx.checkpoint.request as never, att);
    expect(got).toEqual(fx.checkpoint.response as never);
  });

  test("the promotion answers parse: auto, its repeat, review", async () => {
    const auto = await answering(200, fx.promote.auto).promote("hop:5/acme", "run-1", att);
    expect(auto).toEqual({ state: "promoted", storeVersion: 1, promoted: 2, conflicts: [] });
    expect(await answering(200, fx.promote.repeat).promote("hop:5/acme", "run-1", att)).toEqual(auto);
    expect(await answering(200, fx.promote.review).promote("hop:5/acme", "run-1", att)).toEqual({ state: "pending", proposalId: fx.promote.review.proposal_id as string });
  });
});

describe("the fake against W5's fixture", () => {
  let fake: FakeMemoryStore;
  let token: string;
  const tok = fx.engineToken as { sid: string; run_id: string; store: string; promotion: "auto"; shared: FakeEngineClaims["shared"]; limits: FakeEngineClaims["limits"]; customer: string; hop: { version: string } };
  const claims = (over: Partial<FakeEngineClaims> = {}): FakeEngineClaims => ({ sid: tok.sid, runId: tok.run_id, store: tok.store, shared: tok.shared, promotion: tok.promotion, limits: tok.limits, customer: tok.customer, hopVersion: tok.hop.version, ...over });
  const send = (method: string, path: string, body?: unknown, bearer = token) =>
    fetch(`${fake.url}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  /** A body with its ids, messages and serializer-dependent byte counts masked, as the fixture's own `<uuid>`s are. */
  const shape = (b: unknown): unknown => JSON.parse(JSON.stringify(b, (k, v) => (k === "message" ? "<text>" : k === "size" && typeof v === "number" ? "<bytes>" : k === "proposal_id" && typeof v === "string" ? "<proposal>" : v)));
  const promotePath = new URL(`http://x${fx.promote.request.split(" ")[1]}`).pathname.slice(fx.mount.length);

  beforeEach(() => {
    fake = startFakeMemoryStore();
    token = fake.mintEngine(claims());
  });
  afterEach(async () => {
    await fake.stop();
  });

  test("the mount and the promote path are the fixture's", async () => {
    expect(new URL(fake.url).pathname).toBe(fx.mount);
    expect(promotePath).toBe("/memory/stores/hop:5/acme/runs/run-1/promote");
    await new MemoryStoreClient({ baseUrl: fake.url, tokenProvider: () => token }).promote(tok.store, tok.run_id, att);
    expect(`POST ${fake.requests.at(-1)!.path}`).toBe(fx.promote.request);
  });

  test("the fixture's checkpoint request: the fixture's answer, staged under the fixture's scope", async () => {
    const res = await send("POST", "/memory/checkpoint", fx.checkpoint.request);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fx.checkpoint.response);
    expect(fake.staged(tok.store, tok.run_id).map((n) => n.scope_id)).toEqual([fx.checkpoint.stagingScope.scope_id, fx.checkpoint.stagingScope.scope_id]);
  });

  test("then promote: the fixture's auto body, and a repeat is the same body", async () => {
    await send("POST", "/memory/checkpoint", fx.checkpoint.request);
    const first = await send("POST", promotePath, {});
    expect([first.status, await first.json()]).toEqual([200, fx.promote.auto]);
    const again = await send("POST", promotePath, {});
    expect(await again.json()).toEqual(fx.promote.repeat);
  });

  test("a percent-encoded store id is the same promotion: the fixture's request, the fixture's answer", async () => {
    await send("POST", "/memory/checkpoint", fx.checkpoint.request);
    const res = await send("POST", fx.promote.encoded.request.split(" ")[1]!.slice(fx.mount.length), {});
    expect([res.status, await res.json()]).toEqual([200, fx.promote.encoded.response]);
  });

  test("review: the fixture's pending body", async () => {
    token = fake.mintEngine(claims({ promotion: "review" }));
    await send("POST", "/memory/checkpoint", fx.checkpoint.request);
    const res = await send("POST", promotePath, {});
    const body = (await res.json()) as { proposal_id: string };
    expect(res.status).toBe(200);
    expect(shape(body)).toEqual(shape(fx.promote.review));
    expect(body.proposal_id).toMatch(/^proposal:[0-9a-f]{40}$/);
  });

  /** The fake's own way to each fixture error it can produce. scope_forbidden (a write outside staging) and
   *  already_decided (the control queue) have no engine route on the fake; the client maps them above. */
  const scenarios: Record<string, () => Promise<Response>> = {
    "401 unauthenticated": () => send("POST", "/memory/checkpoint", fx.checkpoint.request, "not-a-token"),
    "404 unknown_run": () => send("POST", "/memory/stores/hop:5/acme/runs/run-9/promote", {}),
    "409 version_conflict": async () => {
      await send("POST", "/memory/checkpoint", fx.checkpoint.request);
      await send("POST", promotePath, {});
      token = fake.mintEngine(claims({ runId: "run-2" }));
      return send("POST", "/memory/checkpoint", { ...fx.checkpoint.request, event_id: "ck:sess-1:run-2:1" });
    },
    "413 write_too_large": () => {
      token = fake.mintEngine(claims({ limits: { ...tok.limits, max_write_bytes: 64 } }));
      return send("POST", "/memory/checkpoint", fx.checkpoint.request);
    },
    "422 invalid_precondition": () => send("POST", "/memory/checkpoint", { event_id: "ck:x", workspace: "w", claims: [{ kind: "learning", topic: "t", key: "k", value: "v", evidence_ids: ["e"], expected_version: 0 }] }),
    "422 note_not_staged": () => send("POST", "/memory/checkpoint", { event_id: "ck:x", workspace: "w", note: { Now: "x" } }),
  };

  for (const e of fx.errors.filter((x) => x.name in scenarios)) {
    test(`${e.name}: the fake answers the fixture's status and body (message aside)`, async () => {
      const res = await scenarios[e.name]!();
      expect([res.status, shape(await res.json())]).toEqual([e.status, shape(e.body)]);
    });
  }
});
