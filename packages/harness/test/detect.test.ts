import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectVerifyCommands, primaryVerifyCommand } from "../src/verify/detect";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yodex-detect-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, content: string): void => {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
};
const commands = (): string[] => detectVerifyCommands(dir).map((c) => c.command);

describe("detectVerifyCommands", () => {
  test("empty project => no commands", () => {
    expect(detectVerifyCommands(dir)).toEqual([]);
  });

  test("node package.json scripts, npm by default", () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest", typecheck: "tsc", lint: "eslint .", build: "tsc -b" } }));
    const cmds = commands();
    expect(cmds).toContain("npm test");
    expect(cmds).toContain("npm run typecheck");
    expect(cmds).toContain("npm run lint");
    expect(cmds).toContain("npm run build");
  });

  test("respects the lockfile-selected package manager", () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
    write("pnpm-lock.yaml", "");
    expect(commands()).toContain("pnpm test");
  });

  test("tsconfig without a typecheck script falls back to npx tsc", () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
    write("tsconfig.json", "{}");
    expect(commands()).toContain("npx tsc --noEmit");
  });

  test("python pyproject with pytest + mypy", () => {
    write("pyproject.toml", "[tool.pytest.ini_options]\n[tool.mypy]\n");
    const cmds = commands();
    expect(cmds).toContain("pytest");
    expect(cmds).toContain("mypy .");
  });

  test("rust and go", () => {
    write("Cargo.toml", "[package]\nname='x'\n");
    expect(commands()).toEqual(expect.arrayContaining(["cargo test", "cargo check"]));
    rmSync(join(dir, "Cargo.toml"));
    write("go.mod", "module x\n");
    expect(detectVerifyCommands(dir).map((c) => c.command)).toEqual(expect.arrayContaining(["go test ./...", "go build ./..."]));
  });

  test("Makefile fallback only when nothing more specific matched", () => {
    write("Makefile", "test:\n\techo hi\nlint:\n\techo l\n");
    expect(commands()).toContain("make test");
    // add a package.json => node wins, Makefile fallback suppressed
    write("package.json", JSON.stringify({ scripts: { test: "jest" } }));
    expect(commands()).not.toContain("make test");
  });

  test("primaryVerifyCommand prefers test over typecheck/build", () => {
    write("package.json", JSON.stringify({ scripts: { test: "jest", build: "tsc -b" } }));
    expect(primaryVerifyCommand(detectVerifyCommands(dir))).toBe("npm test");
    expect(primaryVerifyCommand([])).toBeUndefined();
  });
});
