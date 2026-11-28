import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { AgentSession, SessionMemoryModeError } from "../src/loop/agent";
import { memorySection } from "../src/memory/memory";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";

const reply = (text: string) => ({ model: "test", message: { role: "assistant" as const, content: [{ type: "text" as const, text }] }, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: "end_turn" as const });

async function withStore(fn: (store: LocalStore, base: Omit<ConstructorParameters<typeof AgentSession>[0], "sessionId">) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yx-memory-mode-"));
  try {
    const store = new LocalStore(root);
    const base = { agentId: "a", workspace: "w", cwd: root, model: "test", systemPrompt: "t", tools: new ToolRegistry(), store, model_client: { async *stream() { return reply("ok"); } }, canUseTool: createPolicy({ mode: "autopilot" }) };
    await fn(store, base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const drain = async (s: AgentSession, text: string): Promise<void> => {
  for await (const _ of s.run({ text })) {
  }
};

describe("the session's memory mode on its record (protocol 0.26.5)", () => {
  test("incognito is written at creation and kept on a later turn", async () => {
    await withStore(async (store, base) => {
      await drain(new AgentSession({ ...base, sessionId: "s1", memory: "incognito" }), "go");
      expect((await store.registry.getSession("s1"))?.memory).toBe("incognito");
      await drain(new AgentSession({ ...base, sessionId: "s1", memory: "incognito" }), "more");
      expect((await store.registry.getSession("s1"))?.memory).toBe("incognito");
    });
  });

  test("a session with memory on carries no field: existing records read as before", async () => {
    await withStore(async (store, base) => {
      await drain(new AgentSession({ ...base, sessionId: "s2" }), "go");
      expect(await store.registry.getSession("s2")).not.toHaveProperty("memory");
    });
  });

  test("a sub-agent inherits incognito from its parent's record, even when its builder passes owner and origin", async () => {
    await withStore(async (store, base) => {
      await drain(new AgentSession({ ...base, sessionId: "p1", owner: "org:acme", origin: "ui", memory: "incognito" }), "go");
      await drain(new AgentSession({ ...base, sessionId: "c1", owner: "org:acme", origin: "ui", parent: { sessionId: "p1", toolUseId: "tu_1" } }), "study");
      expect((await store.registry.getSession("c1"))?.memory).toBe("incognito");
      await drain(new AgentSession({ ...base, sessionId: "p2" }), "go");
      await drain(new AgentSession({ ...base, sessionId: "c2", parent: { sessionId: "p2", toolUseId: "tu_2" } }), "study");
      expect(await store.registry.getSession("c2")).not.toHaveProperty("memory");
    });
  });
});

describe("the narrow waist: an incognito record never runs with memory on (protocol 0.26.5)", () => {
  test("a builder that did not say incognito is refused before its first model call; one that did runs", async () => {
    await withStore(async (store, base) => {
      await drain(new AgentSession({ ...base, sessionId: "s1", memory: "incognito" }), "go");
      let calls = 0;
      const counting = { async *stream() { calls++; return reply("ok"); } };
      const memoryOn = new AgentSession({ ...base, sessionId: "s1", model_client: counting });
      let thrown: unknown;
      try {
        await drain(memoryOn, "a wake with memory on");
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SessionMemoryModeError);
      expect(calls).toBe(0);
      expect((await store.registry.getSession("s1"))?.memory).toBe("incognito");
      await drain(new AgentSession({ ...base, sessionId: "s1", memory: "incognito", model_client: counting }), "an incognito wake");
      expect(calls).toBe(1);
    });
  });

  test("a sub-agent whose parent record cannot be read does not start (its mode cannot be known)", async () => {
    await withStore(async (store, base) => {
      const getSession = store.registry.getSession.bind(store.registry);
      store.registry.getSession = async (id: string) => {
        if (id === "p-unreadable") throw new Error("disk read failed");
        return getSession(id);
      };
      let thrown: unknown;
      try {
        await drain(new AgentSession({ ...base, sessionId: "c-unknown", parent: { sessionId: "p-unreadable", toolUseId: "tu" } }), "study");
      } catch (e) {
        thrown = e;
      }
      expect(String(thrown)).toContain("disk read failed");
      expect(await getSession("c-unknown")).toBeNull();
    });
  });
});

describe("the instruction files' heading", () => {
  const files = [{ path: "/w/AGENTS.md", content: "Use bun." }];
  test("memory on: 'Project & user memory'; incognito: 'Project instructions', the same files", () => {
    expect(memorySection(files)).toContain("# Project & user memory");
    const off = memorySection(files, "instructions");
    expect(off).toContain("# Project instructions");
    expect(off).not.toContain("memory\n");
    expect(off).toContain("Use bun.");
    expect(memorySection([], "instructions")).toBe("");
  });
});
