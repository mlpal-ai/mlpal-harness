/**
 * W3 fix pass 2: a path the engine builds from HOP content or from a client's session id stays where the engine meant
 * it (an engine pod must not read, write or create anywhere else at a name it did not choose).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Catalog, loadCatalog } from "../src/catalog/catalog";
import { TaskStore } from "../src/tasks/tracker";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hop-content-paths-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sample: Catalog = {
  schema: 1,
  profile: "coding",
  updated: "2026-07-14",
  tiers: Object.fromEntries((["max", "frontier", "mid", "cheap"] as const).map((t) => [t, { model: `m-${t}`, provider: "p", rel_cost: 1, good_for: "x", caps: ["tools"], served_alternate: false, alternates: [] }])) as unknown as Catalog["tiers"],
};

describe("the catalog cache's name from a HOP's catalog.profile", () => {
  test("a profile with path characters never leaves the home's config dir", async () => {
    const home = join(root, "home");
    const fetchImpl = (async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => sample })) as unknown as typeof fetch;
    await loadCatalog({ baseUrl: "https://models.mlpal.ai", apiKey: "k", home, profile: "x/../../../escaped", fetchImpl, now: () => 1 });
    expect(existsSync(join(root, "escaped.json"))).toBe(false);
    expect(readdirSync(root)).toEqual(["home"]);
    expect(readdirSync(join(home, ".yodex")).length).toBe(1);
  });
});

describe("a task plan's file from a session id", () => {
  test("a session id with path characters is kept inside the store's directory", () => {
    const dir = join(root, "tasks");
    const t = new TaskStore(dir).for("../../escaped");
    t.create({ subject: "a", description: "b" } as never);
    t.flush();
    expect(existsSync(join(root, "escaped.json"))).toBe(false);
    expect(readdirSync(root)).toEqual(["tasks"]);
    expect(readdirSync(dir).length).toBe(1);
  });
});
