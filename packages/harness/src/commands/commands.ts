import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseFrontmatter } from "../skills/skills";

/**
 * Custom slash commands: user-defined `/name` commands from `.yodex/commands/<name>.md`
 * (and the user dir). Each file's body is a prompt template run through the agent loop when
 * you type `/name [args]`. `$ARGUMENTS` expands to everything after the command; `$1`..`$9`
 * to positional words. Frontmatter (description) powers the live menu. The model-facing
 * counterpart of skills — but user-triggered, not model-loaded. See docs/05.
 */
export interface SlashCommand {
  name: string;
  description: string;
  body: string;
  source: string;
}

async function loadFromDir(dir: string): Promise<SlashCommand[]> {
  if (!existsSync(dir)) return [];
  const out: SlashCommand[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const file = join(dir, entry.name);
      const { meta, body } = parseFrontmatter(await readFile(file, "utf8"));
      const name = (meta.name ?? basename(entry.name, ".md")).replace(/^\//, "");
      if (name) out.push({ name, description: meta.description ?? `custom command`, body, source: file });
    } catch {
      // skip an unreadable command file
    }
  }
  return out;
}

/** Load user (~/.yodex/commands) then project (./.yodex/commands); project overrides by name. */
export async function loadCommands(dirs: string[]): Promise<SlashCommand[]> {
  const byName = new Map<string, SlashCommand>();
  for (const dir of dirs) {
    for (const c of await loadFromDir(dir)) byName.set(c.name, c);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Expand a command template with the user's args: $ARGUMENTS (all) and $1..$9 (positional).
 *  Unfilled positionals collapse to empty; a template with no placeholders just appends args. */
export function expandCommand(cmd: SlashCommand, args: string): string {
  const words = args.trim().length ? args.trim().split(/\s+/) : [];
  let body = cmd.body;
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9]/.test(body);
  body = body.replace(/\$ARGUMENTS/g, args.trim());
  body = body.replace(/\$([1-9])/g, (_m, d: string) => words[Number(d) - 1] ?? "");
  // If the template took no placeholders but the user passed args, append them so they aren't lost.
  if (!hasPlaceholder && args.trim()) body = `${body}\n\n${args.trim()}`;
  return body.trim();
}
