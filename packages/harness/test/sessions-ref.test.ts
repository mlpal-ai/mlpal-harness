import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/store/local";
import { resolveSessionRef } from "../src/store/sessions";
import type { SessionRecord } from "../src/store/types";

describe("session names", () => {
  let root: string;
  let store: LocalStore;
  const rec = (id: string, updatedAt: string, name?: string): SessionRecord => ({
    sessionId: id,
    agentId: "local",
    workspace: "repo",
    cwd: "/repo",
    status: "idle",
    head: "",
    model: "m",
    createdAt: updatedAt,
    updatedAt,
    ...(name ? { name } : {}),
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yodex-store-"));
    store = new LocalStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("a /rename'd name resolves like an id; prefixes need 8 chars and one match; the newest same-named session wins", async () => {
    const a = "aaaaaaaa-1111-4111-8111-111111111111";
    const b = "aaaaaaaa-2222-4222-8222-222222222222";
    const c = "cccccccc-3333-4333-8333-333333333333";
    await store.registry.putSession(rec(a, "2026-09-28T10:00:00.000Z"));
    await store.registry.putSession(rec(b, "2026-09-28T11:00:00.000Z"));
    await store.registry.putSession(rec(c, "2026-09-28T09:00:00.000Z"));
    await store.registry.patchSession(a, { name: "Auth Fix" });
    await store.registry.patchSession(b, { name: "auth fix" });
    expect((await store.registry.listSessions()).find((r) => r.sessionId === a)?.name).toBe("Auth Fix");
    expect(await resolveSessionRef(store, a)).toBe(a);
    expect(await resolveSessionRef(store, "auth fix")).toBe(b); // newest of the two
    expect(await resolveSessionRef(store, "AUTH FIX")).toBe(b);
    expect(await resolveSessionRef(store, "cccccccc")).toBe(c);
    expect(await resolveSessionRef(store, "aaaaaaaa")).toBeUndefined(); // ambiguous prefix
    expect(await resolveSessionRef(store, "ccc")).toBeUndefined(); // too short
    expect(await resolveSessionRef(store, "nothing")).toBeUndefined();
  });
});
