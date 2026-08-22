import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadSettings } from "../src/config/settings";

let home: string;
let cwd: string;

beforeEach(async () => {
  home = join(tmpdir(), `yodex-home-${crypto.randomUUID()}`);
  cwd = join(tmpdir(), `yodex-cwd-${crypto.randomUUID()}`);
  await mkdir(join(home, ".yodex"), { recursive: true });
  await mkdir(join(cwd, ".yodex"), { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

describe("loadSettings layering", () => {
  test("applies schema defaults when nothing is set", () => {
    const s = loadSettings({ home, cwd, env: {} });
    expect(s.model).toBe("claude-opus-5"); // pinned, harness-validated default
    expect(s.modelPinned).toBe(false); // schema default, not a user choice
    expect(s.effort).toBeUndefined(); // unset by default — we don't override the model's own reasoning
    expect(s.mode).toBe("autopilot"); // full autonomy by default; deterministic safety still guards
    expect(s.gateway.baseUrl).toBe("https://models.mlpal.ai");
    expect(s.maxTurns).toBe(200);
  });

  test("project file overrides global file", async () => {
    await writeFile(join(home, ".yodex", "config.json"), JSON.stringify({ model: "global-model", mode: "cruise" }));
    await writeFile(join(cwd, ".yodex", "settings.json"), JSON.stringify({ model: "project-model" }));
    const s = loadSettings({ home, cwd, env: {} });
    expect(s.model).toBe("project-model"); // project wins
    expect(s.mode).toBe("cruise"); // inherited from global
  });

  test("env overrides files; flags override env", async () => {
    await writeFile(join(cwd, ".yodex", "settings.json"), JSON.stringify({ model: "file-model" }));
    const s = loadSettings({
      home,
      cwd,
      env: { YODEX_MODEL: "env-model", YODEX_GATEWAY_URL: "https://gw.example" },
      flags: { model: "flag-model" },
    });
    expect(s.model).toBe("flag-model"); // flag beats env beats file
    expect(s.modelPinned).toBe(true); // any layer setting model = an explicit choice
    expect(s.gateway.baseUrl).toBe("https://gw.example"); // from env
  });

  test("permission rules merge from files", async () => {
    await writeFile(
      join(cwd, ".yodex", "settings.json"),
      JSON.stringify({ permissions: { deny: ["Bash(rm*)"], allow: ["Bash(git*)"] } }),
    );
    const s = loadSettings({ home, cwd, env: {} });
    expect(s.permissions.deny).toContain("Bash(rm*)");
    expect(s.permissions.allow).toContain("Bash(git*)");
  });

  test("invalid mode throws", () => {
    expect(() => loadSettings({ home, cwd, env: {}, flags: { mode: "nonsense" } })).toThrow();
  });

  test("accepts both stdio and streamable-HTTP MCP server configs", async () => {
    await writeFile(
      join(cwd, ".yodex", "settings.json"),
      JSON.stringify({
        mcpServers: {
          local: { command: "my-server", args: ["--stdio"] },
          websearch: {
            url: "https://mcp.mlpal.ai/s/8-web-search-mcp/mcp",
            headers: { Authorization: "Bearer ${MLPAL_MCP_KEY}" },
          },
        },
      }),
    );
    const s = loadSettings({ home, cwd, env: {} });
    expect(s.mcpServers.local).toMatchObject({ command: "my-server" });
    expect(s.mcpServers.websearch).toMatchObject({ url: expect.stringContaining("mcp.mlpal.ai") });
  });
});

describe("mcpServers scope handling", () => {
  test("same-named server: project REPLACES user whole-value (no cross-scope hybrid)", async () => {
    await writeFile(
      join(home, ".yodex", "config.json"),
      JSON.stringify({
        mcpServers: { search: { url: "https://user.example/mcp", headers: { A: "1" } } },
      }),
    );
    await writeFile(
      join(cwd, ".yodex", "settings.json"),
      JSON.stringify({ mcpServers: { search: { url: "https://project.example/mcp" } } }),
    );
    const s = loadSettings({ home, cwd, env: {} });
    // A deep merge would have paired the project url with the user's headers.
    expect(s.mcpServers.search).toEqual({ url: "https://project.example/mcp" });
  });

  test("mcpOrigins records every defining file; conflicts are visible", async () => {
    await writeFile(
      join(home, ".yodex", "config.json"),
      JSON.stringify({ mcpServers: { both: { url: "https://u.example" }, mine: { command: "x" } } }),
    );
    await writeFile(
      join(cwd, ".yodex", "settings.json"),
      JSON.stringify({ mcpServers: { both: { url: "https://p.example" }, theirs: { command: "y" } } }),
    );
    const s = loadSettings({ home, cwd, env: {} });
    expect(s.mcpOrigins.mine).toEqual([{ scope: "user", path: join(home, ".yodex", "config.json") }]);
    expect(s.mcpOrigins.theirs).toEqual([{ scope: "project", path: join(cwd, ".yodex", "settings.json") }]);
    expect(s.mcpOrigins.both?.map((o) => o.scope)).toEqual(["user", "project"]);
  });
});
