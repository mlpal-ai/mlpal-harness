import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { hooksModuleOf, PackPlanError, planPack } from "../src/plugins/plan";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function pack(files: Record<string, string>): string {
  const base = mkdtempSync(join(tmpdir(), "yodex-plan-"));
  roots.push(base);
  const dir = join(base, "voice");
  mkdirSync(dir);
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  return dir;
}

const from = { source: "https://github.com/acme/voice", commit: "abc123", fallbackName: "voice" };
const manifest = (m: Record<string, unknown>) => JSON.stringify({ name: "voice", version: "1.2.0", ...m });

describe("planPack (tools-admin T-3)", () => {
  test("the plan lists skills, agents, programs, remote servers and the hooks module", async () => {
    const dir = pack({
      ".claude-plugin/plugin.json": manifest({ description: "Speech", mcpServers: { api: { url: "https://api.example.com/mcp?x=1" } } }),
      ".mcp.json": JSON.stringify({ mcpServers: { tts: { command: "node", args: ["server.js"] } } }),
      "skills/speak/SKILL.md": "---\nname: speak\ndescription: say it\n---\nbody",
      "agents/narrator.md": "---\nname: narrator\ndescription: d\n---\nx",
      "hooks.ts": "export default () => {}",
      "commands/x.md": "x",
    });
    const { plan, sha256 } = await planPack(dir, from);
    expect(plan).toEqual({
      name: "voice",
      version: "1.2.0",
      description: "Speech",
      source: from.source,
      commit: "abc123",
      skills: ["voice:speak"],
      agents: ["voice:narrator"],
      programs: [{ server: "plugin:voice:tts", command: "node", args: ["server.js"] }],
      remoteServers: [{ server: "plugin:voice:api", url: "https://api.example.com/mcp", transport: "http" }],
      hooksModule: { file: "hooks.ts", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      ignored: ["commands"],
      warnings: [],
    });
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await planPack(dir, from)).sha256).toBe(sha256);
  });

  test("any change to any file, a server config included, changes the hash", async () => {
    const dir = pack({ ".mcp.json": JSON.stringify({ mcpServers: { tts: { command: "node", args: ["a.js"] } } }), "README.md": "hi" });
    const before = (await planPack(dir, from)).sha256;
    writeFileSync(join(dir, "README.md"), "hi!");
    const readme = (await planPack(dir, from)).sha256;
    expect(readme).not.toBe(before);
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { tts: { command: "node", args: ["b.js"] } } }));
    const after = await planPack(dir, from);
    expect(after.sha256).not.toBe(readme);
    expect(after.plan.programs[0]?.args).toEqual(["b.js"]);
  });

  test("a manifest path outside the plugin is refused", async () => {
    for (const m of [{ skills: "../../etc" }, { hooks: "/etc/passwd" }, { commands: ["./ok", "../escape"] }, { mcpServers: "${CLAUDE_PLUGIN_ROOT}/../x.json" }]) {
      const err = await planPack(pack({ ".claude-plugin/plugin.json": manifest(m) }), from).catch((e) => e);
      expect(err).toBeInstanceOf(PackPlanError);
      expect(err.code).toBe("plugin_path_outside");
    }
  });

  test("a link inside the plugin that leads outside it is refused", async () => {
    const dir = pack({ "skills/a/SKILL.md": "---\nname: a\ndescription: d\n---\n" });
    symlinkSync("/etc", join(dir, "skills", "etc"));
    const err = await planPack(dir, from).catch((e) => e);
    expect(err.code).toBe("plugin_path_outside");
  });

  test("a manifest name with path separators or dots, and unusable server names, are refused", async () => {
    for (const name of ["../evil", "a/b", "..", "", "x".repeat(65), "a\nb"]) {
      const err = await planPack(pack({ ".claude-plugin/plugin.json": JSON.stringify({ name }) }), from).catch((e) => e);
      expect(err.code).toBe("plugin_invalid");
    }
    for (const server of ["a/b", "a__b", "-x", "x\u0007"]) {
      const err = await planPack(pack({ ".mcp.json": JSON.stringify({ mcpServers: { [server]: { command: "x" } } }) }), from).catch((e) => e);
      expect(err.code).toBe("plugin_invalid");
    }
  });

  test("a string mcpServers in the manifest, bad JSON and a url with credentials are refused", async () => {
    expect((await planPack(pack({ ".claude-plugin/plugin.json": manifest({ mcpServers: "./servers.json" }) }), from).catch((e) => e)).code).toBe("plugin_invalid");
    expect((await planPack(pack({ ".claude-plugin/plugin.json": "{nope" }), from).catch((e) => e)).code).toBe("plugin_invalid");
    expect((await planPack(pack({ ".mcp.json": JSON.stringify({ mcpServers: { a: { url: "https://u:p@x.example/mcp" } } }) }), from).catch((e) => e)).code).toBe("plugin_invalid");
    expect((await planPack(pack({ ".mcp.json": JSON.stringify({ mcpServers: "abc" }) }), from).catch((e) => e)).code).toBe("plugin_invalid");
  });

  test("hooksModuleOf picks the file the engine would import", async () => {
    const dir = pack({ "hooks.js": "a", "hooks.mjs": "b" });
    expect((await hooksModuleOf(dir))?.file).toBe("hooks.js");
    expect(await hooksModuleOf(pack({ "README.md": "x" }))).toBeNull();
  });
});
