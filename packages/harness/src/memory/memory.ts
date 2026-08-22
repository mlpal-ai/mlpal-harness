import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { host } from "../host";

/**
 * Project & user memory: AGENTS.md / CLAUDE.md files that give the agent project
 * conventions, commands, and preferences without the user repeating them. Loaded from
 * user dirs + walked up from cwd to home, with @-imports for composition.
 *
 * Design note: the result is injected into the
 * SYSTEM PROMPT, not a user turn — the system prompt carries a cache_control breakpoint,
 * so memory is paid for once and read from cache on every subsequent turn. Putting it in
 * a user message would re-bill it and break that cache window. We support YODEX.md (our own)
 * and AGENTS.md (the emerging cross-tool standard) in addition to CLAUDE.md. When more
 * than one is present in a directory, all are loaded in this order.
 */

export interface MemoryFile {
  path: string;
  content: string;
}

/** Host's own file first (e.g. YODEX.md), then the cross-tool conventions. Resolved
 *  lazily so configureHost() applies. */
export function defaultMemoryNames(): string[] {
  return [`${host().name.toUpperCase()}.md`, "AGENTS.md", "CLAUDE.md"];
}

export interface LoadMemoryOptions {
  cwd: string;
  home: string;
  /** Global memory dirs, general → specific (e.g. ~/.yodex, ~/.claude). */
  userDirs?: string[];
  filenames?: string[];
  maxImportDepth?: number;
}

/** Dirs from the topmost ancestor (home, or fs root if cwd is outside home) down to cwd,
 *  so the most specific (cwd) file is applied last. */
function ancestorsDownToCwd(cwd: string, home: string): string[] {
  const out: string[] = [];
  const stop = resolve(home);
  let cur = resolve(cwd);
  for (let guard = 0; guard < 64; guard++) {
    out.push(cur);
    if (cur === stop) break;
    const parent = dirname(cur);
    if (parent === cur) break; // filesystem root
    cur = parent;
  }
  return out.reverse();
}

async function resolveImports(
  content: string,
  baseDir: string,
  depth: number,
  seen: Set<string>,
  maxDepth: number,
): Promise<string> {
  if (depth >= maxDepth) return content;
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*@(\S+)\s*$/);
    if (m) {
      const importPath = resolve(baseDir, m[1]!);
      if (existsSync(importPath) && !seen.has(importPath)) {
        seen.add(importPath);
        try {
          const imported = await readFile(importPath, "utf8");
          out.push(await resolveImports(imported, dirname(importPath), depth + 1, seen, maxDepth));
          continue;
        } catch {
          // unreadable import — keep the literal line
        }
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

export async function loadMemoryFiles(opts: LoadMemoryOptions): Promise<MemoryFile[]> {
  const names = opts.filenames ?? defaultMemoryNames();
  const maxDepth = opts.maxImportDepth ?? 5;
  const seen = new Set<string>();
  const files: MemoryFile[] = [];

  const addFile = async (path: string): Promise<void> => {
    const abs = resolve(path);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      return;
    }
    if (!content.trim()) return;
    files.push({ path: abs, content: await resolveImports(content, dirname(abs), 0, seen, maxDepth) });
  };

  // user/global (general) first, then project hierarchy (specific) last
  for (const dir of opts.userDirs ?? []) {
    for (const n of names) await addFile(join(dir, n));
  }
  for (const dir of ancestorsDownToCwd(opts.cwd, opts.home)) {
    for (const n of names) await addFile(join(dir, n));
  }
  return files;
}

/** Format loaded memory for appending to the system prompt. */
export function memorySection(files: MemoryFile[]): string {
  if (files.length === 0) return "";
  const blocks = files.map((f) => `## ${f.path}\n${f.content.trim()}`).join("\n\n");
  return `\n\n# Project & user memory\nThese files define project conventions, commands, and the user's preferences. Treat them as authoritative.\n\n${blocks}`;
}
