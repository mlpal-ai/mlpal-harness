import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "../mcp/manager";
import { loadSkills, type Skill } from "../skills/skills";
import { host } from "../host";

/**
 * Packs: yodex's plugin format — a git repo bundling skills, agents, and MCP servers,
 * installed under ~/.yodex/plugins/<name>. The layout is Claude-Code-plugin-compatible
 * (manifest at .yodex-plugin/plugin.json or .claude-plugin/plugin.json, conventional
 * skills/ + agents/ dirs, .mcp.json at the root, mcpServers inline in the manifest), so
 * existing CC plugins install as-is. Manifest is optional: components auto-discover and
 * the name falls back to the directory name.
 *
 * Namespacing (the load-bearing provenance decision): skills and agents are exposed as
 * `<pack>:<name>`, MCP servers as `plugin:<pack>:<server>` — panels, permissions, and
 * trust all key off these names, and they can never collide with user content.
 */
export interface PackManifest {
  name?: string;
  version?: string;
  description?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface Pack {
  name: string;
  dir: string;
  version?: string;
  description?: string;
  /** Skills namespaced `<pack>:<name>`, source tagged `plugin:<pack>`. */
  skills: Skill[];
  /** agents/ dir if present — callers feed it to loadAgents (defs get namespaced there). */
  agentsDir?: string;
  agentsCount: number;
  /** Servers namespaced `plugin:<pack>:<server>`. */
  mcpServers: Record<string, McpServerConfig>;
  /** Component dirs the pack ships that yodex does not load (hooks, commands, …) —
   *  surfaced in /plugins rather than silently dropped. */
  unsupported: string[];
  /** Load problems worth showing (bad manifest JSON, unreadable .mcp.json). */
  errors: string[];
}

const UNSUPPORTED_DIRS = ["hooks", "commands", "outputStyles"];

async function readJson<T>(path: string, errors: string[], what: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    errors.push(`${what}: ${(e as Error).message}`);
    return undefined;
  }
}

export async function loadPack(dir: string, fallbackName: string): Promise<Pack> {
  const errors: string[] = [];
  const manifest =
    (await readJson<PackManifest>(join(dir, `${host().configDirName}-plugin`, "plugin.json"), errors, "plugin.json")) ??
    (await readJson<PackManifest>(join(dir, ".claude-plugin", "plugin.json"), errors, "plugin.json")) ??
    {};
  const name = manifest.name ?? fallbackName;

  const skills = (await loadSkills([join(dir, "skills")]))
    .filter((s) => s.source !== "builtin")
    .map((s) => ({ ...s, name: `${name}:${s.name}`, source: `plugin:${name}` }));

  // MCP servers: .mcp.json at the root (CC convention) plus manifest-inline entries.
  const mcpFile = await readJson<{ mcpServers?: Record<string, McpServerConfig> }>(
    join(dir, ".mcp.json"),
    errors,
    ".mcp.json",
  );
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [server, config] of Object.entries({
    ...mcpFile?.mcpServers,
    ...manifest.mcpServers,
  })) {
    mcpServers[`plugin:${name}:${server}`] = config;
  }

  const agentsDir = existsSync(join(dir, "agents")) ? join(dir, "agents") : undefined;
  const agentsCount = agentsDir
    ? (await readdir(agentsDir)).filter((f) => f.endsWith(".md")).length
    : 0;
  const unsupported = UNSUPPORTED_DIRS.filter((d) => existsSync(join(dir, d)));

  return {
    name,
    dir,
    version: manifest.version,
    description: manifest.description,
    skills,
    agentsDir,
    agentsCount,
    mcpServers,
    unsupported,
    errors,
  };
}

/** Load every installed pack (each subdirectory of `root` is one pack). Unreadable packs
 *  become entries with errors — never silently missing. */
export async function loadPacks(root: string): Promise<Pack[]> {
  if (!existsSync(root)) return [];
  const packs: Pack[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      packs.push(await loadPack(join(root, entry.name), entry.name));
    } catch (e) {
      packs.push({
        name: entry.name,
        dir: join(root, entry.name),
        skills: [],
        agentsCount: 0,
        mcpServers: {},
        unsupported: [],
        errors: [`failed to load: ${(e as Error).message}`],
      });
    }
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}
