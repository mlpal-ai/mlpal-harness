import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync } from "node:fs";
import { hooksModuleOf, PackPlanError, planPack, treeSha256 } from "../src/plugins/plan";
import { vendoredTree } from "../src/plugins/vendored";

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
      programs: [{ server: "plugin:voice:tts", command: "node", args: ["server.js"], variables: [] }],
      remoteServers: [{ server: "plugin:voice:api", url: "https://api.example.com/mcp", transport: "http", variables: [] }],
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

describe("REVIEW-1 RQ-3/RQ-4: what a plan and a consent bind to", () => {
  test("RQ-4: the plan lists every variable each server asks for (secrets and the engine's keys included)", async () => {
    const dir = pack({
      ".claude-plugin/plugin.json": manifest({ mcpServers: { t: { type: "http", url: "https://tele.example/mcp", headers: { "X-A": "${MLPAL_SECRET_ELEVEN_KEY}", "X-B": "Bearer ${YODEX_API_KEY}" } } } }),
      ".mcp.json": JSON.stringify({ mcpServers: { p: { command: "node", args: ["s.js"], env: { K: "${OPENAI_API_KEY:-}" } } } }),
    });
    const { plan } = await planPack(dir, from);
    expect(plan.remoteServers[0]?.variables).toEqual(["MLPAL_SECRET_ELEVEN_KEY", "YODEX_API_KEY"]);
    expect(plan.programs[0]?.variables).toEqual(["OPENAI_API_KEY"]);
  });

  test("RQ-3(c): a directory named hooks.ts is never the module; the regular hooks.js is", async () => {
    const dir = pack({ "hooks.js": "export default () => {}", "hooks.ts/index.ts": "throw 1" });
    expect((await hooksModuleOf(dir))?.file).toBe("hooks.js");
    expect((await planPack(dir, from)).plan.hooksModule?.file).toBe("hooks.js");
  });

  test("treeSha256 is the workspace image's tree_sha256: one sorted line per entry, links not followed, .git included", async () => {
    const dir = pack({ "a.txt": "hi", "d/b.sh": "x", ".git/HEAD": "ref" });
    chmodSync(join(dir, "d", "b.sh"), 0o755);
    symlinkSync("a.txt", join(dir, "l"));
    const sha = (b: string) => createHash("sha256").update(b).digest("hex");
    const lines = [`f\0a.txt\0-\0${sha("hi")}\n`, "d\0d\n", `f\0d/b.sh\0x\0${sha("x")}\n`, "d\0.git\n", `f\0.git/HEAD\0-\0${sha("ref")}\n`, "l\0l\0a.txt\n"]
      .map((l) => Buffer.from(l))
      .sort(Buffer.compare);
    const h = createHash("sha256");
    for (const l of lines) h.update(l);
    const pinned = h.digest("hex");
    expect(await treeSha256(dir)).toBe(pinned);
    writeFileSync(join(dir, "d", "b.sh"), "y");
    expect(await treeSha256(dir)).not.toBe(pinned);
  });
});

describe("REVIEW-1 RQ-2: vendored by the image is the file-ownership fact, never a default", () => {
  test("root-owned and writable by no group or other: vendored; the person's own, or group-writable, or as root: not", () => {
    const dir = pack({ "a.txt": "x" });
    const root = { uid: 0, mode: 0o40755 };
    expect(vendoredTree(dir, { uid: 1000, stat: () => root })).toEqual({ vendored: true });
    expect(vendoredTree(dir, { uid: 1000, stat: () => ({ uid: 1000, mode: 0o40755 }) }).vendored).toBe(false);
    expect(vendoredTree(dir, { uid: 1000, stat: (p) => (p.endsWith("a.txt") ? { uid: 0, mode: 0o100664 } : root) }).vendored).toBe(false);
    expect(vendoredTree(dir, { uid: 0, stat: () => root }).vendored).toBe(false);
    expect(vendoredTree(dir).vendored).toBe(false);
  });
});
