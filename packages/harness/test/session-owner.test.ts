import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";

const reply = (text: string) => ({ model: "test", message: { role: "assistant" as const, content: [{ type: "text" as const, text }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" as const });

describe("owner and origin on the session record (0.21)", () => {
  test("written at creation and kept on a resume that omits them", async () => {
    const root = mkdtempSync(join(tmpdir(), "yx-owner-"));
    try {
      const store = new LocalStore(root);
      const base = { agentId: "a", workspace: "w", cwd: root, model: "test", systemPrompt: "t", tools: new ToolRegistry(), store, model_client: { async *stream() { return reply("ok"); } }, canUseTool: createPolicy({ mode: "autopilot" }) };
      const session = new AgentSession({ ...base, sessionId: "s1", owner: "org:acme", origin: "api" });
      for await (const _ of session.run({ text: "go" })) {
      }
      expect(await store.registry.getSession("s1")).toMatchObject({ owner: "org:acme", origin: "api" });
      const again = new AgentSession({ ...base, sessionId: "s1" });
      for await (const _ of again.run({ text: "more" })) {
      }
      expect(await store.registry.getSession("s1")).toMatchObject({ owner: "org:acme", origin: "api" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a sub-agent's session inherits owner and origin from its parent's record", async () => {
    const root = mkdtempSync(join(tmpdir(), "yx-owner-child-"));
    try {
      const store = new LocalStore(root);
      const base = { agentId: "a", workspace: "w", cwd: root, model: "test", systemPrompt: "t", tools: new ToolRegistry(), store, model_client: { async *stream() { return reply("ok"); } }, canUseTool: createPolicy({ mode: "autopilot" }) };
      for await (const _ of new AgentSession({ ...base, sessionId: "parent-1", owner: "org:acme", origin: "schedule:01J" }).run({ text: "go" })) {
      }
      for await (const _ of new AgentSession({ ...base, sessionId: "child-1", parent: { sessionId: "parent-1", toolUseId: "tu_1" } }).run({ text: "study" })) {
      }
      expect(await store.registry.getSession("child-1")).toMatchObject({ owner: "org:acme", origin: "schedule:01J", parent: { sessionId: "parent-1", toolUseId: "tu_1" } });
      // An explicit owner on the child wins over the parent's.
      for await (const _ of new AgentSession({ ...base, sessionId: "child-2", owner: "org:other", parent: { sessionId: "parent-1", toolUseId: "tu_2" } }).run({ text: "study" })) {
      }
      expect((await store.registry.getSession("child-2"))?.owner).toBe("org:other");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
