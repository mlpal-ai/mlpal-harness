import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createMemorizeTool,
  derivedMemorySection,
  listMemories,
  parseTopic,
  topicToEnvelope,
} from "../src/memory/derived";
import { LocalStore } from "../src/store/local";

let root: string;
let store: LocalStore;

beforeEach(() => {
  root = join(tmpdir(), `yodex-dmem-${crypto.randomUUID()}`);
  store = new LocalStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = { cwd: "/" };

describe("Memorize tool", () => {
  test("saves a project memory with sync-ready frontmatter", async () => {
    const tool = createMemorizeTool({ store, workspace: "myrepo", sessionId: "abcd1234-x" });
    const r = await tool.call(
      { slug: "deploy-process", content: "Deploys go through GitHub Actions, never manual.", type: "decision" },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    const raw = (await store.memory.readTopic("myrepo--deploy-process"))!;
    expect(raw).toContain("type: decision");
    expect(raw).toContain("scope: project");
    expect(raw).toMatch(/event_id: [0-9a-f-]{36}/);
    expect(raw).toMatch(/occurred: \d{4}-/);
    expect(raw).toContain("sessions: abcd1234");
    expect(raw).toContain("GitHub Actions");
  });

  test("stamps host-supplied provenance: hop, prompt_sha, origin (audit by prompt, not timestamp)", async () => {
    const tool = createMemorizeTool({
      store,
      workspace: "infra",
      provenance: () => ({ hop: "infra@0.1.1", promptSha: "0123abcd4567", origin: "routine:watch-web" }),
    });
    await tool.call({ slug: "alert-policy", content: "Alert once per breach; dedupe by memory." }, ctx);
    const raw = (await store.memory.readTopic("infra--alert-policy"))!;
    expect(raw).toContain("hop: infra@0.1.1");
    expect(raw).toContain("prompt_sha: 0123abcd4567");
    expect(raw).toContain("origin: routine:watch-web");
    // absent provenance => no empty keys
    const bare = createMemorizeTool({ store, workspace: "infra" });
    await bare.call({ slug: "plain", content: "x" }, ctx);
    const rawBare = (await store.memory.readTopic("infra--plain"))!;
    expect(rawBare).not.toContain("hop:");
    expect(rawBare).not.toContain("prompt_sha:");
  });

  test("updating a slug mints a new event_id and records supersedes", async () => {
    const tool = createMemorizeTool({ store, workspace: "w" });
    await tool.call({ slug: "db-choice", content: "We use SQLite." }, ctx);
    const first = (await store.memory.readTopic("w--db-choice"))!;
    const firstId = first.match(/event_id: (\S+)/)![1]!;
    const r2 = await tool.call({ slug: "db-choice", content: "We use Postgres now." }, ctx);
    expect(r2.content).toContain("updated");
    const second = (await store.memory.readTopic("w--db-choice"))!;
    expect(second).toContain(`supersedes: ${firstId}`);
    expect(second.match(/event_id: (\S+)/)![1]).not.toBe(firstId);
    expect(second).toContain("Postgres");
    expect(second).not.toContain("SQLite");
  });

  test("global scope + invalid slug rejected", async () => {
    const tool = createMemorizeTool({ store, workspace: "w" });
    await tool.call({ slug: "editor-pref", content: "User prefers vim keybindings.", scope: "global" }, ctx);
    expect(await store.memory.readTopic("global--editor-pref")).toContain("vim");
    const bad = await tool.call({ slug: "Not Valid!", content: "x" }, ctx);
    expect(bad.isError).toBe(true);
  });
});

describe("derivedMemorySection + listMemories", () => {
  test("injects global + this workspace only; other workspaces excluded", async () => {
    const mine = createMemorizeTool({ store, workspace: "alpha" });
    const other = createMemorizeTool({ store, workspace: "beta" });
    await mine.call({ slug: "a-fact", content: "Alpha uses bun." }, ctx);
    await other.call({ slug: "b-fact", content: "Beta uses node." }, ctx);
    await mine.call({ slug: "pref", content: "Short answers preferred.", scope: "global" }, ctx);

    const section = await derivedMemorySection(store, "alpha");
    expect(section).toContain("# Derived memories");
    expect(section).toContain("Alpha uses bun");
    expect(section).toContain("Short answers preferred");
    expect(section).not.toContain("Beta uses node");

    const list = await listMemories(store, "alpha");
    expect(list.map((m) => m.key).sort()).toEqual(["alpha--a-fact", "global--pref"]);
  });

  test("empty store renders nothing", async () => {
    expect(await derivedMemorySection(store, "w")).toBe("");
  });

  test("records the calling session's id as provenance (ctx.sessionId)", async () => {
    const tool = createMemorizeTool({ store, workspace: "alpha" });
    await tool.call({ slug: "a-fact", content: "a fact" }, { cwd: "/", sessionId: "deadbeef-1234" });
    const raw = (await store.memory.readTopic("alpha--a-fact"))!;
    expect(parseTopic(raw).meta.sessions).toContain("deadbeef");
  });
});

describe("topicToEnvelope (memory-graph sync mapper)", () => {
  test("maps a project topic onto a repo-scoped episode envelope", async () => {
    const tool = createMemorizeTool({ store, workspace: "backend" });
    await tool.call(
      { slug: "deploy", content: "Deploy via kubectl apply.", type: "decision" },
      { cwd: "/", sessionId: "sess1234" },
    );
    const raw = (await store.memory.readTopic("backend--deploy"))!;
    const env = topicToEnvelope("backend--deploy", parseTopic(raw));
    expect(env.scope).toBe("repo");
    expect(env.scope_id).toBe("backend");
    expect(env.content).toContain("kubectl apply");
    expect(env.action_type).toBe("decision");
    expect(env.event_id).toMatch(/[0-9a-f-]{36}/);
    expect(env.payload.sessions).toContain("sess1234");
  });

  test("maps a global topic onto a user-scoped envelope (no scope_id)", () => {
    const raw = "---\nevent_id: e1\nscope: global\ntype: preference\noccurred: 2026-01-01\n---\nShort answers.";
    const env = topicToEnvelope("global--pref", parseTopic(raw));
    expect(env.scope).toBe("user");
    expect(env.scope_id).toBeUndefined();
    expect(env.occurred_at).toBe("2026-01-01");
  });

  test("carries a supersedes chain through payload", () => {
    const raw = "---\nevent_id: e2\nsupersedes: e1\nscope: global\n---\nUpdated fact.";
    const env = topicToEnvelope("global--f", parseTopic(raw));
    expect(env.payload.supersedes).toBe("e1");
  });
});
