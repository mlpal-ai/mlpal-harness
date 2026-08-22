import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HUMAN } from "@mlpal/harness-protocol";
import { LocalStore } from "../src/store/local";

let root: string;
let store: LocalStore;

beforeEach(() => {
  root = join(tmpdir(), `yodex-test-${crypto.randomUUID()}`);
  store = new LocalStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("conversation store (DAG)", () => {
  test("append builds a parentUuid chain", async () => {
    const sid = "s1";
    const e1 = await store.conversation.append(
      sid,
      { type: "user", message: { role: "user", content: "hi" }, author: HUMAN, ts: "t" },
      null,
    );
    const e2 = await store.conversation.append(
      sid,
      {
        type: "assistant",
        message: { role: "assistant", content: "yo" },
        usage: { input_tokens: 1, output_tokens: 1 },
        stopReason: "end_turn",
        model: "m",
        ts: "t",
      },
      e1.uuid,
    );
    expect(e1.parentUuid).toBeNull();
    expect(e2.parentUuid).toBe(e1.uuid);

    const entries = await store.conversation.read(sid);
    expect(entries).toHaveLength(2);
    expect(await store.conversation.head(sid)).toBe(e2.uuid);
  });

  test("sessions are isolated", async () => {
    await store.conversation.append(
      "a",
      { type: "user", message: { role: "user", content: "x" }, author: HUMAN, ts: "t" },
      null,
    );
    expect(await store.conversation.read("b")).toHaveLength(0);
  });
});

describe("bifurcation: logs are separate from conversation", () => {
  test("logs land in their own channel files, not in conversation", async () => {
    const sid = "s1";
    await store.conversation.append(
      sid,
      { type: "user", message: { role: "user", content: "hi" }, author: HUMAN, ts: "t" },
      null,
    );
    await store.logs.write(sid, "exec", { tool: "Bash", exit: 0 });
    await store.logs.write(sid, "model", { model: "m", input_tokens: 10 });

    expect(await store.logs.read(sid, "exec")).toHaveLength(1);
    expect(await store.logs.read(sid, "model")).toHaveLength(1);
    // conversation untouched by logging
    expect(await store.conversation.read(sid)).toHaveLength(1);
  });
});

describe("memory store", () => {
  test("write and read a topic; list excludes the index", async () => {
    await store.memory.writeTopic("project-x", "# fact\nsomething durable");
    expect(await store.memory.readTopic("project-x")).toContain("durable");
    expect(await store.memory.listTopics()).toEqual(["project-x"]);
    expect(await store.memory.readIndex()).toBe("");
  });
});

describe("registry", () => {
  test("register and patch a session", async () => {
    await store.registry.putAgent({
      agentId: "ag1",
      displayName: "lead",
      createdAt: "t",
      lastSeen: "t",
    });
    await store.registry.putSession({
      sessionId: "s1",
      agentId: "ag1",
      workspace: "w",
      cwd: "/w",
      status: "active",
      head: null,
      model: "m",
      createdAt: "t",
      updatedAt: "t",
    });
    await store.registry.patchSession("s1", { status: "done", head: "u9" });

    const s = await store.registry.getSession("s1");
    expect(s?.status).toBe("done");
    expect(s?.head).toBe("u9");
    expect(await store.registry.listAgents()).toHaveLength(1);
    expect(await store.registry.listSessions()).toHaveLength(1);
  });
});
