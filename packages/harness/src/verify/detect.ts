import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Project-aware verification detection. The agent is told to "verify your work" but often doesn't
 * know *what command* to run — so it guesses or skips. This inspects the working directory and
 * returns the project's likely checks (test / typecheck / lint / build) by ecosystem, which the
 * harness surfaces in the system prompt. It only reads a handful of manifest files; it never runs
 * anything (the agent decides when to verify, via Bash) — so it adds no cost to tasks that don't.
 */
export type VerifyKind = "test" | "typecheck" | "lint" | "build";
export interface VerifyCommand {
  kind: VerifyKind;
  command: string;
}

export function detectVerifyCommands(cwd: string): VerifyCommand[] {
  const has = (f: string): boolean => existsSync(join(cwd, f));
  const read = (f: string): string => {
    try {
      return readFileSync(join(cwd, f), "utf8");
    } catch {
      return "";
    }
  };
  const out: VerifyCommand[] = [];

  // Node / TypeScript
  if (has("package.json")) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(read("package.json")).scripts as Record<string, unknown>) ?? {};
    } catch {
      // malformed package.json — fall through with no scripts
    }
    const pm = has("pnpm-lock.yaml")
      ? "pnpm"
      : has("yarn.lock")
        ? "yarn"
        : has("bun.lockb") || has("bun.lock")
          ? "bun"
          : "npm";
    const run = (name: string): string => (pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`);
    const direct = (name: string): string => (pm === "npm" ? `npm ${name}` : `${pm} ${name}`); // `test` is a lifecycle script
    if (scripts.test) out.push({ kind: "test", command: direct("test") });
    if (scripts.typecheck) out.push({ kind: "typecheck", command: run("typecheck") });
    else if (has("tsconfig.json")) out.push({ kind: "typecheck", command: "npx tsc --noEmit" });
    if (scripts.lint) out.push({ kind: "lint", command: run("lint") });
    if (scripts.build) out.push({ kind: "build", command: run("build") });
  }

  // Python
  if (has("pyproject.toml") || has("setup.py") || has("setup.cfg") || has("tox.ini") || has("pytest.ini")) {
    const cfg = read("pyproject.toml") + read("setup.cfg") + read("tox.ini") + read("pytest.ini");
    if (has("tox.ini")) out.push({ kind: "test", command: "tox" });
    else if (/pytest/.test(cfg) || has("tests") || has("test")) out.push({ kind: "test", command: "pytest" });
    else out.push({ kind: "test", command: "python -m pytest" });
    if (/\bmypy\b/.test(cfg)) out.push({ kind: "typecheck", command: "mypy ." });
    if (/\bruff\b/.test(cfg)) out.push({ kind: "lint", command: "ruff check ." });
  }

  // Rust
  if (has("Cargo.toml")) {
    out.push({ kind: "test", command: "cargo test" });
    out.push({ kind: "typecheck", command: "cargo check" });
  }

  // Go
  if (has("go.mod")) {
    out.push({ kind: "test", command: "go test ./..." });
    out.push({ kind: "build", command: "go build ./..." });
  }

  // Makefile fallback (only if nothing more specific matched)
  if (out.length === 0 && has("Makefile")) {
    const mk = read("Makefile");
    if (/^test:/m.test(mk)) out.push({ kind: "test", command: "make test" });
    if (/^check:/m.test(mk)) out.push({ kind: "test", command: "make check" });
    if (/^lint:/m.test(mk)) out.push({ kind: "lint", command: "make lint" });
  }

  // Dedup by command; cap so the prompt stays lean.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.command) ? false : (seen.add(c.command), true))).slice(0, 5);
}

/** The single command the agent should most likely run to verify a change (test > typecheck > build). */
export function primaryVerifyCommand(cmds: VerifyCommand[]): string | undefined {
  const order: VerifyKind[] = ["test", "typecheck", "build", "lint"];
  for (const k of order) {
    const hit = cmds.find((c) => c.kind === k);
    if (hit) return hit.command;
  }
  return undefined;
}
