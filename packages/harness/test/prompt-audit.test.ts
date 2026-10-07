import { describe, expect, test } from "bun:test";
import { auditInstructionFiles, renderAuditReport, type AuditProbes, type InstructionFile } from "../src/doctor/prompt-audit";

const HOME = "/home/u";
const CWD = "/home/u/proj";

function probes(over: Partial<{ exists: string[]; which: string[]; scripts: string[]; make: string[] }> = {}): AuditProbes {
  const exists = new Set((over.exists ?? []).map((p) => p));
  const which = new Set(over.which ?? ["git", "bun", "npm", "kubectl", "ls", "make", "pnpm"]);
  return {
    exists: (p) => exists.has(p),
    which: (c) => which.has(c),
    scripts: () => ({ packageScripts: over.scripts ?? ["build", "test"], makeTargets: over.make ?? ["lint"] }),
  };
}

const mem = (path: string, content: string): InstructionFile => ({ path, role: "memory", content });
const opts = (p: AuditProbes) => ({ cwd: CWD, home: HOME, probes: p });

describe("prompt audit: stale references", () => {
  test("missing paths are named; routes, globs, urls, git refs and unknown bare slugs are left alone", () => {
    const f = mem(`${CWD}/CLAUDE.md`, [
      "Tracker lives at `~/work/tracker/ACTIVITY.md` and the script is `./scripts/run.sh`.",
      "Code: `/Users/me/code/app` (gone) and `/home/u/proj/src` (there).",
      "Routes: POST `/v1/messages`; glob `src/**/*.ts`; see https://example.com/a/b; branch `origin/main`; repo `mlpalOld/yodex-core`.",
      "Relative: `packages/cli/src/main.ts` (first segment exists, file does not) and `docs/README.md` (unknown root).",
      "@imports/missing.md",
      "@imports/present.md",
    ].join("\n"));
    const r = auditInstructionFiles([f], opts(probes({ exists: [`${CWD}/src`, `${CWD}/packages`, `${CWD}/imports/present.md`] })));
    const paths = r.findings.filter((x) => x.kind === "missing_path").map((x) => x.message);
    expect(paths).toEqual([
      "path does not exist: ~/work/tracker/ACTIVITY.md",
      "path does not exist: ./scripts/run.sh",
      "path does not exist: /Users/me/code/app",
      "path does not exist: packages/cli/src/main.ts",
    ]);
    const imports = r.findings.filter((x) => x.kind === "unresolved_import");
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ severity: "error", line: 5, message: `@imports/missing.md does not resolve (${CWD}/imports/missing.md)` });
  });

  test("commands: shell fences and invocation-shaped spans are checked; builtins, env prefixes, on-demand runners and prose spans are not", () => {
    const f = mem(`${CWD}/CLAUDE.md`, [
      "Run `bun test` before every commit and `kubectl get pods -n mlpal` to look.",
      "The old tool was `gradle build`; the name `main` and `Some phrase here` are not commands.",
      "```bash",
      "$ FOO=1 sudo terraform plan && git push   # comment",
      "npx cowsay hi | ls -la",
      "cd /tmp; export X=1",
      "npm run deploy && make lint && make release",
      "```",
      "```python",
      "subprocess.run(['terraform'])",
      "```",
    ].join("\n"));
    const r = auditInstructionFiles([f], opts(probes()));
    const cmds = r.findings.filter((x) => x.kind === "missing_command");
    expect(cmds.map((x) => [x.line, x.message])).toEqual([
      [2, "command not on PATH: gradle"],
      [4, "command not on PATH: terraform"],
    ]);
    const scripts = r.findings.filter((x) => x.kind === "missing_script").map((x) => x.message);
    expect(scripts).toEqual(['"npm run deploy": no script named deploy in package.json', '"make release": no such target in the Makefile']);
  });
});

describe("prompt audit: contradictions", () => {
  test("package manager across the chain, indentation within a file, always/never on the same phrase; comparative lines are self-consistent", () => {
    const user = mem(`${HOME}/.yodex/CLAUDE.md`, "- Always use npm for installs.\n- Use tabs for indentation.\n- Always run the full test suite before a commit.");
    const proj = mem(`${CWD}/AGENTS.md`, [
      "Use pnpm, never npm, in this repo.",      // comparative: names two → no stance
      "Prefer pnpm for installs.",                // stance pnpm vs user's npm
      "Indent with spaces.",                      // but no directive verb → not a directive
      "Use spaces, never tabs.",                  // comparative
      "Never run the full test suite before a commit.",
      "Always run `npm run lint` first.",        // a command in a span is not a package-manager stance
    ].join("\n"));
    const r = auditInstructionFiles([user, proj], opts(probes()));
    const c = r.findings.filter((x) => x.kind === "contradiction");
    expect(c.map((x) => [x.file, x.line, x.message.split(":")[0]])).toEqual([
      [`${CWD}/AGENTS.md`, 2, "package manager"],
      [`${CWD}/AGENTS.md`, 5, '"run the full test suite before a commit" is both always and never'],
    ]);
    expect(c[0]!.message).toContain(`${HOME}/.yodex/CLAUDE.md:1`);
  });

  test("a single alternative required in one place and forbidden in another", () => {
    const f = mem(`${CWD}/CLAUDE.md`, "Use prettier for formatting.\n\nDo not use prettier on generated files.");
    const r = auditInstructionFiles([f], opts(probes()));
    expect(r.findings.filter((x) => x.kind === "contradiction").map((x) => x.message.split(":")[0])).toEqual(["formatter"]);
  });
});

describe("prompt audit: model-generation patterns and weight", () => {
  test("retired model ids (once each), incantations, shouting, foreign-tool references, oversize and duplicates", () => {
    const body = "A".repeat(200);
    const a = mem(`${HOME}/.yodex/CLAUDE.md`, [
      "Default model: claude-3-5-sonnet-20241022. Fallback claude-3-5-sonnet-20241022 again; also gpt-3.5-turbo.",
      "Let's think step by step. You are a world-class engineer.",
      "IMPORTANT: NEVER EVER skip tests. ALWAYS run them.",
      "Config at ~/.claude/settings.json and CLAUDE_CODE_MAX_OUTPUT_TOKENS.",
      "",
      body,
    ].join("\n"));
    const b: InstructionFile = { path: `${CWD}/.yodex/agents/reviewer.md`, role: "agent", content: `---\nname: reviewer\nmodel: claude-3-opus-20240229\n---\nReview.\n\n${body}\n\n${"B".repeat(33 * 1024)}` };
    const r = auditInstructionFiles([a, b], opts(probes()));
    const kinds = (k: string) => r.findings.filter((x) => x.kind === k);
    expect(kinds("old_model").map((x) => x.message)).toEqual([
      "names a retired Claude model id: claude-3-5-sonnet-20241022",
      "names a retired OpenAI model id: gpt-3.5-turbo",
      "names a retired Claude model id: claude-3-opus-20240229",
    ]);
    expect(kinds("old_pattern").map((x) => x.message)).toEqual(["chain-of-thought incantation", "a persona superlative", "shouting: IMPORTANT NEVER EVER…"]);
    expect(kinds("foreign_tool").map((x) => x.message)).toEqual(["references ~/.claude/ paths (1 place)", "references CLAUDE_CODE_* variables (1 place)"]);
    expect(kinds("oversize")).toHaveLength(1);
    expect(kinds("oversize")[0]!.file).toBe(b.path);
    expect(kinds("duplicate")).toEqual([expect.objectContaining({ file: b.path, message: `paragraph duplicated from ${a.path}:6` })]);
    // code fences are not scanned for prose patterns, but model ids inside them still count
    const c = mem(`${CWD}/CLAUDE.md`, "```text\nthink step by step\nmodel=claude-instant-1.2\n```");
    const rc = auditInstructionFiles([c], opts(probes()));
    expect(rc.findings.map((x) => x.kind)).toEqual(["old_model"]);
  });

  test("the rendered report groups by file, sorts by severity, shortens the home dir, and says when nothing is wrong", () => {
    const f = mem(`${HOME}/.yodex/CLAUDE.md`, "Use `./missing.sh` to deploy.\n@nope.md");
    const r = auditInstructionFiles([f], opts(probes()));
    const text = renderAuditReport(r, { home: HOME });
    expect(text.split("\n")[0]).toBe("prompt audit: 1 file, 1 error, 1 warning, 0 notes");
    expect(text).toContain("✗ ~/.yodex/CLAUDE.md:2  @nope.md does not resolve");
    expect(text).toContain("! ~/.yodex/CLAUDE.md:1  path does not exist: ./missing.sh");
    expect(r.findings[0]!.severity).toBe("error");
    expect(renderAuditReport(auditInstructionFiles([mem(`${CWD}/CLAUDE.md`, "Run `bun test`.")], opts(probes())))).toContain("nothing stale, contradictory or outdated found");
  });
});
