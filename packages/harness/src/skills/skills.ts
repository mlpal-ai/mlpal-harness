import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { z } from "zod";
import { defineTool, type Tool } from "../tools/types";
import { BUILTIN_SKILLS } from "./builtin";

/**
 * Skills: model-agnostic, progressively-disclosed capabilities. Each skill is a
 * markdown body with frontmatter (name, description). The system prompt lists only the
 * names + descriptions; the model calls the Skill tool to load a skill's full body when
 * it needs it — keeping context small. A portable, on-demand skill-loading design.
 */
export interface Skill {
  name: string;
  description: string;
  body: string;
  source: string; // "builtin" | a path
  /** For directory-form skills: the skill's folder, which may bundle scripts/reference
   *  files alongside SKILL.md. The model reads/runs those on demand via the Skill tool.
   *  Undefined for built-ins and bare `.md` skills (body-only). */
  dir?: string;
}

export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) {
      meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: m[2]!.trim() };
}

function toSkill(text: string, source: string, fallbackName: string, dir?: string): Skill | null {
  const { meta, body } = parseFrontmatter(text);
  const name = meta.name ?? fallbackName;
  if (!name) return null;
  return { name, description: meta.description ?? name, body, source, dir };
}

async function loadFromDir(dir: string): Promise<Skill[]> {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    try {
      if (entry.isDirectory()) {
        const skillDir = join(dir, entry.name);
        const file = join(skillDir, "SKILL.md");
        if (existsSync(file)) {
          // Directory form carries `dir` so bundled resources (scripts/refs) are reachable.
          const s = toSkill(await readFile(file, "utf8"), file, entry.name, skillDir);
          if (s) out.push(s);
        }
      } else if (entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        const file = join(dir, entry.name);
        const s = toSkill(await readFile(file, "utf8"), file, basename(entry.name, ".md"));
        if (s) out.push(s);
      }
    } catch {
      // skip unreadable skill
    }
  }
  return out;
}

/** Bundled files in a skill directory (recursive), relative to the dir, excluding SKILL.md. */
async function bundledFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? join(dir, rel) : dir;
    for (const e of await readdir(abs, { withFileTypes: true })) {
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(r);
      else if (r !== "SKILL.md") out.push(r);
    }
  }
  try {
    await walk("");
  } catch {
    // unreadable — no bundle
  }
  return out.sort();
}

/** Built-ins (embedded, work in the compiled binary) + user skills from dirs.
 *  Later sources override earlier ones by name. */
export async function loadSkills(dirs: string[]): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const s of BUILTIN_SKILLS) byName.set(s.name, { ...s, source: "builtin" });
  for (const dir of dirs) {
    for (const s of await loadFromDir(dir)) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Listing entries are for discovery only — full content loads on invoke — so a runaway
 *  description can't crowd the prompt. */
const CATALOG_ENTRY_MAX = 250;

/** The catalog appended to the system prompt (progressive disclosure). The phrasing is
 *  deliberate: "before", "never claim without calling", and the already-loaded guard are
 *  the nudges that make invocation reliable rather than optional-feeling. */
export function skillsCatalog(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills
    .map((s) => {
      const d = s.description.replace(/\s+/g, " ");
      return `- ${s.name}: ${d.length > CATALOG_ENTRY_MAX ? `${d.slice(0, CATALOG_ENTRY_MAX - 1)}…` : d}`;
    })
    .join("\n");
  return (
    `\n\n# Skills\n` +
    `When a task matches one of these, call the Skill tool with its name to load the full ` +
    `instructions BEFORE doing the task — do not answer from the summary line alone. Never ` +
    `say you used a skill without actually calling the tool. If a skill's instructions are ` +
    `already loaded in this conversation, follow them instead of loading it again:\n${lines}`
  );
}

export function createSkillTool(
  skills: Skill[],
  opts?: { isEnabled?: (name: string) => boolean },
): Tool<{ name: string; file?: string }> {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const names = skills.map((s) => s.name).join(", ") || "(none)";
  const isEnabled = opts?.isEnabled ?? (() => true);
  return defineTool({
    name: "Skill",
    description:
      `Load a skill's full instructions by name. Some skills bundle scripts/reference files — ` +
      `pass \`file\` to read one of the bundled files listed when you load the skill. Available skills: ${names}`,
    readOnly: true,
    schema: z.object({
      name: z.string().describe("the skill name to load"),
      file: z.string().optional().describe("a bundled file to read (relative path from the skill's listing)"),
    }),
    async call(input) {
      const s = byName.get(input.name);
      if (!s) return { content: `Unknown skill "${input.name}". Available: ${names}`, isError: true };
      if (!isEnabled(s.name)) {
        return {
          content: `Skill "${s.name}" is disabled (the user turned it off in /skills). Proceed without it.`,
          isError: true,
        };
      }

      // Reading a specific bundled file (traversal-guarded to the skill's own dir).
      if (input.file) {
        if (!s.dir) return { content: `Skill "${s.name}" bundles no files.`, isError: true };
        const abs = resolve(s.dir, input.file);
        if (abs !== s.dir && !abs.startsWith(s.dir + sep)) {
          return { content: `Refusing to read outside the skill directory: ${input.file}`, isError: true };
        }
        try {
          return { content: await readFile(abs, "utf8") };
        } catch (e) {
          return { content: `Could not read "${input.file}": ${(e as Error).message}`, isError: true };
        }
      }

      // Loading the skill: body + a manifest of bundled files (with absolute paths so the
      // model can run scripts via Bash or read refs via Skill(file:…)).
      let body = s.body;
      if (s.dir) {
        const files = await bundledFiles(s.dir);
        if (files.length > 0) {
          body +=
            `\n\n## Bundled resources\nThis skill ships these files in ${s.dir}:\n` +
            files.map((f) => `- ${f}  →  ${join(s.dir!, f)}`).join("\n") +
            `\n\nRun scripts by absolute path with Bash (e.g. \`python <path>\`); read a reference with Skill(name:"${s.name}", file:"<relative path>").`;
        }
      }
      return { content: body };
    },
  });
}
