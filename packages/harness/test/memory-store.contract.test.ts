/**
 * The client against W5's P5 fixtures (test/fixtures/memory-store): every fixture of a route the engine calls is
 * answered to the client as recorded; a success must parse and an error must map to its class by code. Until W5's
 * fixture lands the replay is skipped (visibly) and the loader is pinned on a sample of its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStoreClient, MemoryStoreError, MemoryVersionConflictError, MemoryWriteTooLargeError } from "../src/store/memory-store";
import { loadMemoryStoreFixtures, type MemoryStoreFixture } from "./memory-store-fixtures";

const DIR = join(import.meta.dir, "fixtures", "memory-store");
const fixtures = loadMemoryStoreFixtures(DIR);
const att = { sid: "s", runId: "r" };

function replay(f: MemoryStoreFixture): Promise<unknown> {
  const client = new MemoryStoreClient({
    baseUrl: "http://memory.test/v1",
    tokenProvider: () => "t",
    fetch: async () => new Response(JSON.stringify(f.body), { status: f.status, headers: { "content-type": f.content_type ?? "application/json" } }),
  });
  const req = (f.request ?? {}) as Record<string, unknown>;
  switch (f.op) {
    case "checkpoint":
      return client.checkpoint(req as never, att);
    case "search":
      return client.search({ q: String(req.q ?? "") }, att);
    case "projection":
      return client.projection({ workspace: "w", hop: "h", inject: [], tokenBudget: 1500 }, att);
    case "promote":
      return client.promote("hop:p/c", "r", att);
    default:
      throw new Error(`no op for ${f.route}`);
  }
}

describe("P5 fixtures (W5)", () => {
  const ours = fixtures.filter((f) => f.op !== null);
  test.skipIf(ours.length === 0)("every engine-route fixture parses (2xx) or maps to its error class by code", async () => {
    for (const f of ours) {
      const out = await replay(f).then(
        (v) => ({ ok: true as const, v }),
        (e) => ({ ok: false as const, e }),
      );
      if (f.status < 300) expect({ name: f.name, ok: out.ok }).toEqual({ name: f.name, ok: true });
      else {
        expect({ name: f.name, ok: out.ok }).toEqual({ name: f.name, ok: false });
        const e = (out as { e: unknown }).e;
        expect(e).toBeInstanceOf(MemoryStoreError);
        expect({ name: f.name, code: (e as MemoryStoreError).code }).toEqual({ name: f.name, code: (f.body as { code: string }).code });
      }
    }
  });
});

describe("loadMemoryStoreFixtures", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("a missing directory is no fixtures; each file maps its route to the client op, sorted by name", () => {
    expect(loadMemoryStoreFixtures(join(tmpdir(), "no-such-p5-fixtures"))).toEqual([]);
    dir = join(tmpdir(), `p5-fixtures-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "promote-200-auto.json"), JSON.stringify({ route: "POST /v1/memory/stores/{store}/runs/{run_id}/promote", case: "auto", status: 200, body: { state: "promoted", store_version: 3, promoted: 2 } }));
    writeFileSync(join(dir, "checkpoint-409-version-conflict.json"), JSON.stringify({ route: "POST /v1/memory/checkpoint", case: "stale", status: 409, body: { code: "version_conflict", key: "owner", current_version: 4 } }));
    writeFileSync(join(dir, "checkpoint-413-write-too-large.json"), JSON.stringify({ route: "POST /v1/memory/checkpoint", case: "big", status: 413, body: { code: "write_too_large" } }));
    writeFileSync(join(dir, "decide-409.json"), JSON.stringify({ route: "POST /v1/memory/promotions/{proposal_id}/decide", case: "twice", status: 409, body: { code: "already_decided" } }));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const got = loadMemoryStoreFixtures(dir);
    expect(got.map((f) => [f.name, f.op])).toEqual([
      ["checkpoint-409-version-conflict", "checkpoint"],
      ["checkpoint-413-write-too-large", "checkpoint"],
      ["decide-409", null],
      ["promote-200-auto", "promote"],
    ]);
  });

  test("the replay maps a sample of each kind as the contract test will", async () => {
    const f = (route: string, status: number, body: unknown, op: MemoryStoreFixture["op"]): MemoryStoreFixture => ({ name: "x", route, case: "x", status, body, op });
    expect(await replay(f("", 200, { state: "promoted", store_version: 3, promoted: 2 }, "promote"))).toEqual({ state: "promoted", storeVersion: 3, promoted: 2 });
    const conflict = await replay(f("", 409, { code: "version_conflict", key: "owner", current_version: 4 }, "checkpoint")).catch((e) => e);
    expect(conflict).toBeInstanceOf(MemoryVersionConflictError);
    expect((conflict as MemoryVersionConflictError).currentVersion).toBe(4);
    expect(await replay(f("", 413, { code: "write_too_large" }, "checkpoint")).catch((e) => e)).toBeInstanceOf(MemoryWriteTooLargeError);
  });

  test("a file without route or status is refused, naming the file", () => {
    dir = join(tmpdir(), `p5-fixtures-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ case: "x" }));
    expect(() => loadMemoryStoreFixtures(dir!)).toThrow("bad.json");
  });
});
