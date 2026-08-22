import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "tinyglobby";
import { z } from "zod";
import { defineTool, err, ok, resolveInRoots } from "../types";

// Fallback ignore list — used only when ripgrep is unavailable (rg respects .gitignore
// natively, which covers these and more). Kept broad enough that a $HOME- or monorepo-rooted
// scan through the JS engine doesn't wander into machine/venv/build dirs.
const IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/.ruff_cache/**",
  "**/.tox/**",
  "**/target/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.svelte-kit/**",
  "**/coverage/**",
  "**/.gradle/**",
  "**/.idea/**",
  "**/.vscode/**",
  // giant machine dirs that make a $HOME-rooted scan pathological
  "**/Library/**",
  "**/.Trash/**",
  "**/.cache/**",
  "**/.bun/**",
  "**/.npm/**",
  "**/.cargo/**",
];
const MAX_MATCHES = 200;
const SCAN_TIMEOUT_MS = 20_000;
// 20MB: a wide match in a large monorepo can produce a lot of stdout; cap it rather than OOM.
const RG_MAX_BUFFER = 20_000_000;

interface RgResult {
  /** ripgrep stdout. */
  stdout: string;
  /** 0 = matches/files found, 1 = none. (2+ never returns here — it rejects.) */
  code: 0 | 1;
}

/**
 * Run ripgrep by command NAME ("rg", never a resolved path) so the OS resolves it on PATH —
 * a `./rg` planted in the cwd can't hijack the call. Returns null when rg isn't installed (the
 * caller falls back to the JS engine); rejects on timeout ("timeout") or a real rg error (exit ≥2,
 * e.g. an invalid regex — stderr surfaced). Exit 1 (no matches) is success, not an error.
 * We attempt rg every call rather than memoizing availability: a failed spawn (ENOENT) is
 * sub-millisecond, and not caching means rg installed mid-session is picked up immediately.
 */
function runRg(args: string[], cwd: string, timeoutMs: number): Promise<RgResult | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "rg",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: RG_MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, code: 0 });
          return;
        }
        // execFile sets `code` to the OS error string (ENOENT) on spawn failure, or the numeric
        // process exit code on a non-zero exit — hence the widened type.
        const e = error as Omit<NodeJS.ErrnoException, "code"> & { code?: string | number; killed?: boolean };
        if (e.code === "ENOENT") {
          resolve(null); // rg not installed — caller falls back
          return;
        }
        if (e.killed) {
          reject(new Error("timeout"));
          return;
        }
        // 1 = no matches (not an error).
        if (e.code === 1) {
          resolve({ stdout, code: 1 });
          return;
        }
        reject(new Error(stderr.trim() || `ripgrep exited with ${String(e.code)}`));
      },
    );
  });
}

/**
 * Common ripgrep flags. `--hidden` searches dotfiles but .gitignore is still honored;
 * `--no-require-git` makes rg honor a `.gitignore` even when the target isn't inside a git repo
 * (its default silently ignores .gitignore for bare dirs — the exact case that let a scan wander
 * into `.venv`). `.git`/`node_modules` are excluded unconditionally so even a repo with no
 * .gitignore stays clean.
 */
function baseRgArgs(): string[] {
  return ["--hidden", "--no-require-git", "--glob", "!.git", "--glob", "!node_modules"];
}

/** Bound a filesystem scan: tinyglobby has no abort support, so cap it by wall clock. The
 *  orphaned scan finishes in the background; the tool returns a clear error instead. */
function withScanTimeout<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((r) => setTimeout(() => r(null), SCAN_TIMEOUT_MS)),
  ]);
}

export const globTool = defineTool({
  name: "Glob",
  description:
    "Find files matching a glob pattern (e.g. '**/*.ts'). Respects .gitignore. Returns matching paths.",
  readOnly: true,
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional().describe("base dir (default cwd)"),
  }),
  async call(input, ctx) {
    const r = resolveInRoots(ctx, input.path ?? ".");
    if ("error" in r) return r.error;
    const base = r.path;

    try {
      const res = await runRg([...baseRgArgs(), "--files", "-g", input.pattern], base, SCAN_TIMEOUT_MS);
      if (res) {
        if (res.code === 1) return ok("No files matched");
        const files = res.stdout.split("\n").filter(Boolean).sort();
        return ok(files.length ? files.join("\n") : "No files matched");
      }
    } catch (e) {
      if ((e as Error).message === "timeout") {
        return err(
          `glob timed out after ${SCAN_TIMEOUT_MS / 1000}s — the tree under ${base} is too large; narrow the pattern or pass a subdirectory as path`,
        );
      }
      return err(`glob failed: ${(e as Error).message}`);
    }

    // rg unavailable (runRg returned null): JS fallback.
    const matches = await withScanTimeout(
      glob(input.pattern, { cwd: base, ignore: IGNORE, onlyFiles: true, dot: false }),
    );
    if (matches === null) {
      return err(
        `glob timed out after ${SCAN_TIMEOUT_MS / 1000}s — the tree under ${base} is too large; narrow the pattern or pass a subdirectory as path`,
      );
    }
    matches.sort();
    return ok(matches.length ? matches.join("\n") : "No files matched");
  },
});

export const grepTool = defineTool({
  name: "Grep",
  description:
    "Search file contents with a regular expression (ripgrep-backed; respects .gitignore). Returns file:line:match. Optionally scoped by a glob.",
  readOnly: true,
  schema: z.object({
    pattern: z.string(),
    path: z.string().optional().describe("base dir (default cwd)"),
    glob: z.string().optional().describe("file glob to scope the search"),
  }),
  async call(input, ctx) {
    const r = resolveInRoots(ctx, input.path ?? ".");
    if ("error" in r) return r.error;
    const base = r.path;

    const args = [...baseRgArgs(), "--line-number", "--max-columns", "500"];
    if (input.glob) args.push("-g", input.glob);
    // --regexp marks the pattern explicitly so a leading '-' isn't parsed as a flag.
    args.push("--regexp", input.pattern);
    try {
      const res = await runRg(args, base, SCAN_TIMEOUT_MS);
      if (res) {
        if (res.code === 1) return ok("No matches");
        const lines = res.stdout.split("\n").filter(Boolean);
        if (lines.length > MAX_MATCHES) {
          return ok([...lines.slice(0, MAX_MATCHES), `[truncated at ${MAX_MATCHES} matches]`].join("\n"));
        }
        return ok(lines.length ? lines.join("\n") : "No matches");
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "timeout") {
        return err(
          `grep timed out after ${SCAN_TIMEOUT_MS / 1000}s — the tree under ${base} is too large; narrow with a glob or subdirectory path`,
        );
      }
      // rg exit 2 on a bad pattern surfaces as its stderr ("regex parse error: ...").
      return err(`invalid pattern or search error: ${msg}`);
    }

    // rg unavailable (runRg returned null): JS fallback (validate the regex ourselves).
    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch (e) {
      return err(`invalid regex: ${(e as Error).message}`);
    }
    const files = await withScanTimeout(
      glob(input.glob ?? "**/*", { cwd: base, ignore: IGNORE, onlyFiles: true, dot: false }),
    );
    if (files === null) {
      return err(
        `grep timed out after ${SCAN_TIMEOUT_MS / 1000}s — the tree under ${base} is too large; narrow with a glob or subdirectory path`,
      );
    }
    const out: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = await readFile(join(base, f), "utf8");
      } catch {
        continue; // binary / unreadable
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          out.push(`${f}:${i + 1}:${lines[i]}`);
          if (out.length >= MAX_MATCHES) {
            out.push(`[truncated at ${MAX_MATCHES} matches]`);
            return ok(out.join("\n"));
          }
        }
      }
    }
    return ok(out.length ? out.join("\n") : "No matches");
  },
});

export const listTool = defineTool({
  name: "List",
  description: "List the entries of a directory. Directories are suffixed with '/'.",
  readOnly: true,
  schema: z.object({
    path: z.string().optional().describe("directory (default cwd)"),
  }),
  async call(input, ctx) {
    const r = resolveInRoots(ctx, input.path ?? ".");
    if ("error" in r) return r.error;
    const dir = r.path;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (e) {
      return err(`cannot list ${input.path ?? "."}: ${(e as Error).message}`);
    }
    const rows: string[] = [];
    for (const name of entries.sort()) {
      if (name === "node_modules" || name === ".git") continue;
      const s = await stat(join(dir, name)).catch(() => null);
      rows.push(s?.isDirectory() ? `${name}/` : name);
    }
    return ok(rows.join("\n") || "(empty)");
  },
});
