import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadMemoryFiles, memorySection } from "../src/memory/memory";

let home: string;
let proj: string;
let cwd: string;

beforeEach(async () => {
  home = join(tmpdir(), `yodex-mem-${crypto.randomUUID()}`);
  proj = join(home, "proj");
  cwd = join(proj, "sub");
  await mkdir(join(home, ".yodex"), { recursive: true });
  await mkdir(cwd, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("loadMemoryFiles", () => {
  test("loads user + project hierarchy, general→specific, both filenames", async () => {
    await writeFile(join(home, ".yodex", "CLAUDE.md"), "GLOBAL PREFS");
    await writeFile(join(proj, "CLAUDE.md"), "PROJ CONVENTIONS");
    await writeFile(join(cwd, "AGENTS.md"), "SUB AGENTS");
    await writeFile(join(cwd, "CLAUDE.md"), "SUB CLAUDE");

    const files = await loadMemoryFiles({ cwd, home, userDirs: [join(home, ".yodex")] });
    const contents = files.map((f) => f.content);
    expect(contents).toContain("GLOBAL PREFS");
    expect(contents).toContain("PROJ CONVENTIONS");
    expect(contents).toContain("SUB AGENTS");
    expect(contents).toContain("SUB CLAUDE");
    // user first, cwd last (most specific applied last)
    expect(files[0]!.content).toBe("GLOBAL PREFS");
    expect(files.at(-1)!.content).toBe("SUB CLAUDE");
    // AGENTS.md before CLAUDE.md at the same dir
    const subAgentsIdx = files.findIndex((f) => f.content === "SUB AGENTS");
    const subClaudeIdx = files.findIndex((f) => f.content === "SUB CLAUDE");
    expect(subAgentsIdx).toBeLessThan(subClaudeIdx);
  });

  test("resolves @-imports and ignores cycles/missing", async () => {
    await writeFile(join(cwd, "imported.md"), "IMPORTED BODY");
    await writeFile(join(cwd, "CLAUDE.md"), "before\n@./imported.md\n@./does-not-exist.md\nafter");
    const files = await loadMemoryFiles({ cwd, home });
    const body = files.find((f) => f.path.endsWith("sub/CLAUDE.md"))!.content;
    expect(body).toContain("IMPORTED BODY");
    expect(body).not.toContain("@./imported.md"); // replaced
    expect(body).toContain("@./does-not-exist.md"); // missing → literal kept
    expect(body).toContain("before");
    expect(body).toContain("after");
  });

  test("memorySection wraps files for the system prompt, empty when none", async () => {
    expect(memorySection([])).toBe("");
    await writeFile(join(cwd, "CLAUDE.md"), "X");
    const section = memorySection(await loadMemoryFiles({ cwd, home }));
    expect(section).toContain("# Project & user memory");
    expect(section).toContain("X");
  });
});
