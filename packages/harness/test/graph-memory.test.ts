import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemorizeTool } from "../src/memory/derived";
import { SyncingMemory, withMemory } from "../src/store/graph-memory";
import { LocalStore } from "../src/store/local";

let root: string;
let store: LocalStore;
beforeEach(() => {
  root = join(tmpdir(), `yodex-gmem-${crypto.randomUUID()}`);
  store = new LocalStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("SyncingMemory", () => {
  test("persists locally AND posts an episode envelope to the graph", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    const mem = new SyncingMemory({
      base: store.memory,
      endpoint: "https://memory.mlpal.ai/",
      apiKey: "k",
      post: async (url, body) => {
        posts.push({ url, body: JSON.parse(body) });
        return 202;
      },
    });
    const synced = withMemory(store, mem);
    const tool = createMemorizeTool({ store: synced, workspace: "backend" });
    await tool.call({ slug: "deploy", content: "Deploy via kubectl.", type: "decision" }, { cwd: "/", sessionId: "s1" });

    // local persisted
    expect(await store.memory.readTopic("backend--deploy")).toContain("kubectl");
    // graph received the mapped envelope at the episodes endpoint
    expect(posts.length).toBe(1);
    expect(posts[0]!.url).toBe("https://memory.mlpal.ai/api/v1/episodes");
    const env = posts[0]!.body as { scope: string; scope_id: string; content: string; action_type: string };
    expect(env.scope).toBe("repo");
    expect(env.scope_id).toBe("backend");
    expect(env.content).toContain("kubectl");
    expect(env.action_type).toBe("decision");
  });

  test("a sync failure never breaks the local write (best-effort)", async () => {
    const mem = new SyncingMemory({
      base: store.memory,
      endpoint: "https://memory.mlpal.ai",
      post: async () => {
        throw new Error("network down");
      },
    });
    // must not throw
    await mem.writeTopic("global--pref", "---\nevent_id: e\nscope: global\n---\nShort answers.");
    expect(await mem.readTopic("global--pref")).toContain("Short answers");
  });

  test("a non-2xx (e.g. 403 repo-scope gate) is tolerated", async () => {
    let called = false;
    const mem = new SyncingMemory({
      base: store.memory,
      endpoint: "https://memory.mlpal.ai",
      post: async () => {
        called = true;
        return 403;
      },
    });
    await mem.writeTopic("backend--x", "---\nevent_id: e\nscope: project\nworkspace: backend\n---\nfact");
    expect(called).toBe(true);
    expect(await mem.readTopic("backend--x")).toContain("fact");
  });

  test("reads delegate to the base store", async () => {
    await store.memory.writeTopic("global--a", "hello");
    const mem = new SyncingMemory({ base: store.memory, endpoint: "x", post: async () => 200 });
    expect(await mem.readTopic("global--a")).toBe("hello");
    expect(await mem.listTopics()).toContain("global--a");
  });
});
