import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadPack, loadPacks } from "../src/plugins/packs";

let root: string;

beforeEach(async () => {
  root = join(tmpdir(), `yodex-packs-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
});
afterEach(async () => rm(root, { recursive: true, force: true }));

async function makePack(
  name: string,
  opts: { manifest?: object | string; manifestDir?: string; skills?: string[]; mcp?: object; hooks?: boolean } = {},
) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  if (opts.manifest !== undefined) {
    const mdir = join(dir, opts.manifestDir ?? ".claude-plugin");
    await mkdir(mdir, { recursive: true });
    await writeFile(
      join(mdir, "plugin.json"),
      typeof opts.manifest === "string" ? opts.manifest : JSON.stringify(opts.manifest),
    );
  }
  for (const s of opts.skills ?? []) {
    await mkdir(join(dir, "skills", s), { recursive: true });
    await writeFile(
      join(dir, "skills", s, "SKILL.md"),
      `---\nname: ${s}\ndescription: does ${s}\n---\nBody of ${s}\n`,
    );
  }
  if (opts.mcp) await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: opts.mcp }));
  if (opts.hooks) await mkdir(join(dir, "hooks"), { recursive: true });
  return dir;
}

describe("loadPack", () => {
  test("CC-plugin layout: manifest name wins, skills namespaced, MCP servers plugin-keyed", async () => {
    const dir = await makePack("clone-dir", {
      manifest: { name: "toolkit", version: "1.2.0", description: "d" },
      skills: ["deploy", "review"],
      mcp: { search: { url: "https://s.example/mcp" } },
    });
    const p = await loadPack(dir, "clone-dir");
    expect(p.name).toBe("toolkit");
    expect(p.version).toBe("1.2.0");
    expect(p.skills.map((s) => s.name)).toEqual(["toolkit:deploy", "toolkit:review"]);
    expect(p.skills[0]!.source).toBe("plugin:toolkit");
    expect(Object.keys(p.mcpServers)).toEqual(["plugin:toolkit:search"]);
  });

  test("no manifest: auto-discovers, name from directory", async () => {
    const dir = await makePack("bare", { skills: ["one"] });
    const p = await loadPack(dir, "bare");
    expect(p.name).toBe("bare");
    expect(p.skills.map((s) => s.name)).toEqual(["bare:one"]);
  });

  test(".yodex-plugin manifest takes precedence over .claude-plugin", async () => {
    const dir = await makePack("dual", { manifest: { name: "cc-name" } });
    await mkdir(join(dir, ".yodex-plugin"), { recursive: true });
    await writeFile(join(dir, ".yodex-plugin", "plugin.json"), JSON.stringify({ name: "yodex-name" }));
    const p = await loadPack(dir, "dual");
    expect(p.name).toBe("yodex-name");
  });

  test("manifest-inline mcpServers merge with .mcp.json", async () => {
    const dir = await makePack("mix", {
      manifest: { name: "mix", mcpServers: { inline: { command: "x" } } },
      mcp: { file: { url: "https://f.example" } },
    });
    const p = await loadPack(dir, "mix");
    expect(Object.keys(p.mcpServers).sort()).toEqual(["plugin:mix:file", "plugin:mix:inline"]);
  });

  test("unsupported dirs are surfaced, not silently dropped; bad manifest is an error entry", async () => {
    const dir = await makePack("rough", { manifest: "{not json", skills: ["s"], hooks: true });
    const p = await loadPack(dir, "rough");
    expect(p.unsupported).toContain("hooks");
    expect(p.errors.some((e) => e.includes("plugin.json"))).toBe(true);
    expect(p.skills.map((s) => s.name)).toEqual(["rough:s"]); // still loads what it can
  });

  test("builtin skills never leak into a pack", async () => {
    const dir = await makePack("empty-skills", {});
    const p = await loadPack(dir, "empty-skills");
    expect(p.skills).toEqual([]);
  });
});

describe("loadPacks", () => {
  test("loads every subdirectory, sorted", async () => {
    await makePack("bbb", { skills: ["x"] });
    await makePack("aaa", { skills: ["y"] });
    const packs = await loadPacks(root);
    expect(packs.map((p) => p.name)).toEqual(["aaa", "bbb"]);
  });

  test("missing root → empty", async () => {
    expect(await loadPacks(join(root, "nope"))).toEqual([]);
  });
});
