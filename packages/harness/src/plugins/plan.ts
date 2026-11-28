import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PluginPlan } from "@mlpal/harness-protocol";
import { host } from "../host";
import type { McpServerConfig } from "../mcp/manager";
import { mcpServerNameProblem } from "../tools/tool-name";
import { loadPack, type Pack } from "./packs";

/**
 * A plugin's install plan (tools-admin, T-3): what the pack will be able to run, read from its files before it is
 * installed, and a hash over the plan and every file, so an approval names exactly what was shown. Refuses a pack
 * that reaches outside itself (a manifest path, a symbolic link) or whose names cannot be used safely as a directory,
 * a tool prefix or a config key. Reading a pack runs none of it.
 */

export type PackPlanCode = "plugin_invalid" | "plugin_path_outside";

export class PackPlanError extends Error {
  override name = "PackPlanError";
  constructor(
    readonly code: PackPlanCode,
    message: string,
  ) {
    super(message);
  }
}

/** A pack's name: a directory under plugins/, the `<pack>:` of its skills and the `plugin:<pack>:` of its servers. */
export const PACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SERVER_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
export const HOOKS_MODULE_FILES = ["hooks.ts", "hooks.js", "hooks.mjs"] as const;
/** Claude-Code manifest fields that name paths inside the plugin. */
const PATH_FIELDS = ["commands", "agents", "skills", "hooks", "mcpServers", "outputStyles", "lspServers"] as const;
const IGNORED_DIRS = ["hooks", "commands", "outputStyles"];
export const PACK_LIMITS = { files: 20_000, bytes: 200 * 1024 * 1024 } as const;

const outside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/** Every file and link under `root` (not `.git`), hashed; a link that resolves outside the pack refuses it. */
export async function packTreeHash(root: string): Promise<string> {
  const real = await realpath(root);
  const rows: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (dir === real && e.name === ".git") continue;
      const p = join(dir, e.name);
      const rel = relative(real, p);
      if (++files > PACK_LIMITS.files) throw new PackPlanError("plugin_invalid", `the plugin has more than ${PACK_LIMITS.files} files`);
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        const target = await realpath(p).catch(() => null);
        if (target === null || outside(real, target)) throw new PackPlanError("plugin_path_outside", `${rel} links outside the plugin`);
        rows.push(`L\0${rel}\0${await readlink(p)}`);
      } else if (st.isDirectory()) {
        rows.push(`D\0${rel}`);
        await walk(p);
      } else if (st.isFile()) {
        bytes += st.size;
        if (bytes > PACK_LIMITS.bytes) throw new PackPlanError("plugin_invalid", `the plugin is larger than ${PACK_LIMITS.bytes / 1024 / 1024} MB`);
        rows.push(`F\0${rel}\0${(st.mode & 0o111) !== 0 ? "x" : "-"}\0${createHash("sha256").update(await readFile(p)).digest("hex")}`);
      } else {
        throw new PackPlanError("plugin_invalid", `${rel} is not a file, a directory or a link`);
      }
    }
  };
  await walk(real);
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

async function readManifest(root: string): Promise<Record<string, unknown> | undefined> {
  for (const d of [`${host().configDirName}-plugin`, ".claude-plugin"]) {
    const raw = await readFile(join(root, d, "plugin.json"), "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new PackPlanError("plugin_invalid", `${d}/plugin.json is not valid JSON: ${(e as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PackPlanError("plugin_invalid", `${d}/plugin.json must hold an object`);
    return parsed as Record<string, unknown>;
  }
  return undefined;
}

/** A manifest's path fields must stay inside the pack (a string or a list of strings; an object is inline config). */
function checkManifestPaths(root: string, manifest: Record<string, unknown>): void {
  for (const field of PATH_FIELDS) {
    const v = manifest[field];
    const paths = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
    for (const p of paths) {
      if (typeof p !== "string") throw new PackPlanError("plugin_invalid", `plugin.json ${field} must name paths as strings`);
      const expanded = p.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root);
      if (/[\0\r\n]/.test(p) || outside(root, resolve(root, expanded))) throw new PackPlanError("plugin_path_outside", `plugin.json ${field} names a path outside the plugin`);
    }
  }
  if (manifest.mcpServers !== undefined && (typeof manifest.mcpServers !== "object" || manifest.mcpServers === null || Array.isArray(manifest.mcpServers))) {
    throw new PackPlanError("plugin_invalid", "plugin.json mcpServers must be an object of servers (a path to a file is not supported)");
  }
}

function isStdio(c: McpServerConfig): c is Extract<McpServerConfig, { command: string }> {
  return typeof (c as { command?: unknown }).command === "string";
}

function serverRows(pack: Pack): Pick<PluginPlan, "programs" | "remoteServers" | "warnings"> {
  const programs: PluginPlan["programs"] = [];
  const remoteServers: PluginPlan["remoteServers"] = [];
  const warnings: string[] = [];
  for (const [key, cfg] of Object.entries(pack.mcpServers)) {
    const server = key.slice(`plugin:${pack.name}:`.length);
    if (!SERVER_KEY.test(server) || mcpServerNameProblem(server) !== null) throw new PackPlanError("plugin_invalid", `server name ${JSON.stringify(server.slice(0, 64))} is not usable: 1–48 of A-Z a-z 0-9 _ -`);
    if (!cfg || typeof cfg !== "object") throw new PackPlanError("plugin_invalid", `server ${server} has no config`);
    if (isStdio(cfg)) {
      const args = cfg.args ?? [];
      if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new PackPlanError("plugin_invalid", `server ${server}: args must be strings`);
      programs.push({ server: key, command: cfg.command, args });
      continue;
    }
    const url = (cfg as { url?: unknown }).url;
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      throw new PackPlanError("plugin_invalid", `server ${server} has neither a command nor a valid url`);
    }
    if (!/^https?:$/.test(parsed.protocol)) throw new PackPlanError("plugin_invalid", `server ${server}: the url must be http(s)`);
    if (parsed.username || parsed.password) throw new PackPlanError("plugin_invalid", `server ${server}: the url carries credentials`);
    if (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) warnings.push(`${server} talks plain http to ${parsed.host}`);
    remoteServers.push({ server: key, url: `${parsed.origin}${parsed.pathname}`, transport: (cfg as { type?: string }).type === "sse" ? "sse" : "http" });
  }
  return { programs, remoteServers, warnings };
}

export interface PackPlanResult {
  plan: PluginPlan;
  /** sha256 over the plan and the tree hash: what an approval must name. */
  sha256: string;
  pack: Pack;
}

/** Read the pack at `dir` (a staging copy, never an installed one) into its plan. Throws PackPlanError. */
export async function planPack(dir: string, from: { source: string; commit?: string; fallbackName: string }): Promise<PackPlanResult> {
  const root = await realpath(dir);
  const tree = await packTreeHash(root);
  const manifest = await readManifest(root);
  if (manifest) {
    checkManifestPaths(root, manifest);
    if (manifest.name !== undefined && (typeof manifest.name !== "string" || !PACK_NAME.test(manifest.name) || manifest.name.includes(".."))) {
      throw new PackPlanError("plugin_invalid", "plugin.json name must be 1–64 of A-Z a-z 0-9 . _ -, starting with a letter or digit");
    }
  }
  if (!PACK_NAME.test(from.fallbackName) || from.fallbackName.includes("..")) throw new PackPlanError("plugin_invalid", "the plugin's directory name is not usable");
  const pack = await loadPack(root, from.fallbackName);
  if (pack.errors.length) throw new PackPlanError("plugin_invalid", pack.errors.join("; "));
  const hooksModule = await hooksModuleOf(root);
  const agents = pack.agentsDir
    ? (await readdir(pack.agentsDir)).filter((f) => f.endsWith(".md")).sort().map((f) => `${pack.name}:${f.slice(0, -3)}`)
    : [];
  const rows = serverRows(pack);
  const plan: PluginPlan = {
    name: pack.name,
    ...(pack.version !== undefined ? { version: String(pack.version) } : {}),
    ...(pack.description !== undefined ? { description: String(pack.description).slice(0, 500) } : {}),
    source: from.source,
    ...(from.commit ? { commit: from.commit } : {}),
    skills: pack.skills.map((s) => s.name).sort(),
    agents,
    programs: rows.programs,
    remoteServers: rows.remoteServers,
    hooksModule,
    ignored: IGNORED_DIRS.filter((d) => pack.unsupported.includes(d)),
    warnings: rows.warnings,
  };
  const sha256 = createHash("sha256").update(`${JSON.stringify(plan)}\n${tree}`).digest("hex");
  return { plan, sha256, pack };
}

/** The root hooks module the engine would import (the first of HOOKS_MODULE_FILES present, as main.ts picks it), with
 *  the sha256 of its content: what a terminal consent (`yodex plugin approve --hooks`) is recorded against. */
export async function hooksModuleOf(root: string): Promise<{ file: string; sha256: string } | null> {
  for (const file of HOOKS_MODULE_FILES) {
    const content = await readFile(join(root, file)).catch(() => null);
    if (content !== null) return { file, sha256: createHash("sha256").update(content).digest("hex") };
  }
  return null;
}
