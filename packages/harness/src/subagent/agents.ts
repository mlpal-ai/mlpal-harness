import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../skills/skills";

/**
 * Custom agent definitions: reusable specialized sub-agents, defined as markdown files
 * in `~/.yodex/agents/` and `./.yodex/agents/` (project wins on name collision). The
 * frontmatter carries name/description plus optional model and tool allowlist; the body
 * is the sub-agent's system prompt. The Task tool lists them so the model can delegate
 * to e.g. a "code-reviewer" or "test-writer" persona with scoped tools.
 */
export interface AgentDef {
  name: string;
  description: string;
  /** The sub-agent's system prompt (markdown body). */
  prompt: string;
  /** Optional model tag or meta-model for this agent. */
  model?: string;
  /** Optional tool allowlist (names); unset = all base tools. */
  tools?: string[];
  source: string;
}

function toAgent(text: string, source: string, fallbackName: string): AgentDef | null {
  const { meta, body } = parseFrontmatter(text);
  const name = meta.name ?? fallbackName;
  if (!name || !body) return null;
  return {
    name,
    description: meta.description ?? name,
    prompt: body,
    model: meta.model || undefined,
    tools: meta.tools
      ? meta.tools.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined,
    source,
  };
}

/** Load agent definitions from dirs; later dirs override earlier ones by name. */
export async function loadAgents(dirs: string[]): Promise<AgentDef[]> {
  const byName = new Map<string, AgentDef>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".md")) continue;
      try {
        const file = join(dir, entry.name);
        const a = toAgent(await readFile(file, "utf8"), file, basename(entry.name, ".md"));
        if (a) byName.set(a.name, a);
      } catch {
        // skip unreadable definition
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
