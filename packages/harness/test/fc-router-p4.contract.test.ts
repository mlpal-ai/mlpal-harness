import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FC_ROUTER_P4_DIR, loadRouterCases, pinnedSha } from "./fc-router-fixture";

/**
 * The P4 seam's fixture (contracts/README.md, the D-3 rule): W2 generates
 * `mlpal-fc-router/tests/contract/p4/` from the router's real code path, and it is copied here with
 * its SHA in the README. Until it lands the replay is skipped by name, and the engine's tests run on
 * the contract's shapes (yodex `test/fake-sandbox-router.ts`).
 */
const cases = loadRouterCases(FC_ROUTER_P4_DIR);

describe("the fc-router P4 fixture loader", () => {
  test("loads every case file by path, sorted, and names a malformed one", () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-p4-"));
    try {
      writeFileSync(join(dir, "b-create.json"), JSON.stringify({ route: "create", request: { method: "POST", path: "/v1/sandboxes", body: {} }, status: 201, body: { sbx_id: "sbx_1", state: "ready" } }));
      writeFileSync(join(dir, "a-lookup.json"), JSON.stringify({ route: "list", request: { method: "GET", path: "/v1/sandboxes?label=sid:s1&limit=1" }, status: 200, body: { items: [], next: null } }));
      writeFileSync(join(dir, "README.md"), "Pinned: 0123abc\n");
      expect(loadRouterCases(dir).map((c) => c.name)).toEqual(["a-lookup", "b-create"]);
      expect(pinnedSha(dir)).toBe("0123abc");
      writeFileSync(join(dir, "c-bad.json"), JSON.stringify({ route: "create", status: "201" }));
      expect(() => loadRouterCases(dir)).toThrow("c-bad.json: not a router case (route, request {method, path}, status, body)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the pinned directory says the fixture has not landed, and holds no cases", () => {
    expect(pinnedSha(FC_ROUTER_P4_DIR)).toBeNull();
    expect(cases).toEqual([]);
  });
});

describe("replay against W2's router fixture", () => {
  test.skipIf(cases.length === 0)("not yet landed: W2's mlpal-fc-router/tests/contract/p4/ does not exist (router a321eb6); pin it here with its SHA, then this runs", () => {
    for (const c of cases) {
      if (c.status >= 400) expect(c.body).toMatchObject({ error: { reason: expect.any(String), message: expect.any(String) } });
      if (c.route === "create" && c.status === 201) expect(c.body).toMatchObject({ sbx_id: expect.any(String), state: expect.any(String) });
      if (c.route === "volume.ensure" && c.status < 300) expect(c.body).toMatchObject({ vol_id: expect.any(String), name: expect.any(String) });
    }
  });
});
