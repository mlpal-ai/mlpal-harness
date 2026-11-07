/**
 * The prompt tells a session only about the memory tools it has. Which those are is known at session build, so the host
 * fits the HOP's prompt to them; with every tool present the prompt is the HOP's, byte for byte.
 */
import { describe, expect, test } from "bun:test";
import { fitPromptToMemoryTools, memoryToolsNamed } from "../src/memory/prompt-tools";
import { derivedMemorySection, createMemorizeTool } from "../src/memory/derived";
import { fillWorkspace } from "../src/profile/load";
import { CODING_PROFILE } from "../src/profile/builtins/coding";
import { LocalStore } from "../src/store/local";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SYSTEM = fillWorkspace(CODING_PROFILE, "workspace").prompts.system;
const MEMORY_SERVICE = ["memory_notes", "memory_answer", "memory_search", "memory_write", "memory_checkpoint", "memory_resolve", "memory_retract"];
const ALL = [...MEMORY_SERVICE, "Memorize"];
const having = (...names: string[]) => (name: string) => names.includes(name);

describe("fitPromptToMemoryTools", () => {
  test("every tool present: the prompt is unchanged", () => {
    expect(fitPromptToMemoryTools(SYSTEM, having(...ALL))).toBe(SYSTEM);
  });

  test("a local store only (a workspace box): Memorize is the memory, and nothing calls it scratch", () => {
    const fit = fitPromptToMemoryTools(SYSTEM, having("Memorize"));
    expect(fit).toContain("save it with the Memorize tool");
    expect(fit).not.toContain("memory_write");
    expect(fit).not.toContain("`memory` MCP");
    expect(fit).not.toContain("scratch store");
    expect(fit).not.toContain("<!-- module: work-memory -->");
    expect(fit).toContain("# Actions that are hard to undo");
  });

  test("a store grant (checkpoint and search): the two it has are named, the rest are not", () => {
    const fit = fitPromptToMemoryTools(SYSTEM, having("memory_checkpoint", "memory_search"));
    expect(memoryToolsNamed(fit).sort()).toEqual(["memory_checkpoint", "memory_search"]);
    expect(fit).not.toContain("save it with the Memorize tool");
  });

  test("no memory tool: the prompt names none", () => {
    expect(memoryToolsNamed(fitPromptToMemoryTools(SYSTEM, having()))).toEqual([]);
  });

  test("whatever a session has, the prompt names nothing else", () => {
    for (let bits = 0; bits < 2 ** ALL.length; bits++) {
      const has = having(...ALL.filter((_, i) => bits & (1 << i)));
      const named = memoryToolsNamed(fitPromptToMemoryTools(SYSTEM, has));
      expect(named.filter((n) => !has(n))).toEqual([]);
    }
  });

  test("the module ends at the next module, which stays", () => {
    const composed = `head\n\n<!-- module: work-memory -->\nmemory_write here\n\n<!-- module: other -->\nkept`;
    expect(fitPromptToMemoryTools(composed, having())).toBe("head\n\n<!-- module: other -->\nkept");
  });

  test("text a HOP wrote itself is left alone, and memoryToolsNamed finds it", () => {
    const own = "Record receipts with memory_write.";
    expect(fitPromptToMemoryTools(own, having())).toBe(own);
    expect(memoryToolsNamed(own)).toEqual(["memory_write"]);
  });

  test("the derived-memory section's Memorize hint goes with the tool", async () => {
    const root = join(tmpdir(), `yodex-fit-${crypto.randomUUID()}`);
    const store = new LocalStore(root);
    try {
      await createMemorizeTool({ store, workspace: "w" }).call({ slug: "a-fact", content: "a fact" }, { cwd: "/" });
      const section = await derivedMemorySection(store, "w");
      expect(memoryToolsNamed(section)).toEqual(["Memorize"]);
      expect(fitPromptToMemoryTools(section, having("Memorize"))).toBe(section);
      const fit = fitPromptToMemoryTools(section, having());
      expect(memoryToolsNamed(fit)).toEqual([]);
      expect(fit).toContain("a fact");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
