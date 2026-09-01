import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CODING_PROFILE,
  codingAntiChurnNudge,
  codingClassifierSystem,
  codingSelfCheckNudge,
  CODING_ENV_BROKEN_RE,
  CODING_VERIFY_CMD_RE,
} from "../src/profile/builtins/coding";
import { REVIEWER_PROFILE } from "../src/profile/builtins/reviewer";
import { assertSettingsRespectLocks, builtinProfiles, loadProfile } from "../src/profile/load";
import { bashTool } from "../src/tools/builtin/bash";
import { editTool, writeTool } from "../src/tools/builtin/files";

/**
 * GOLDEN: the coding profile must reproduce the pre-split (0.8.0) strings byte-for-byte.
 * The expected values below are built with the ORIGINAL 0.8.0 source expressions, copied
 * verbatim from loop/agent.ts / routing/classifier.ts before the extraction. If one of
 * these fails, the split changed behavior — fix the profile, not the test.
 */
describe("golden: coding profile reproduces 0.8.0 strings", () => {
  test("self-check nudge, no hint (original inline expression)", () => {
    const editsMade = 4;
    const how = "run the project's tests, build, or typecheck";
    const original =
      `[Self-check] You made ${editsMade} edit(s) this session but ran no test, build, or ` +
      `typecheck. If you can verify the change, ${how} now and fix anything that fails. If you ` +
      "genuinely can't verify in this environment, say so in one line and finish. Do not " +
      "re-edit code you've already changed without new evidence.";
    expect(codingSelfCheckNudge(4)).toBe(original);
  });

  test("self-check nudge, with detected check", () => {
    const editsMade = 3;
    const how = "run \`pytest\` (this project's detected check)".replace(/\\`/g, "`");
    const original =
      `[Self-check] You made ${editsMade} edit(s) this session but ran no test, build, or ` +
      `typecheck. If you can verify the change, ${how} now and fix anything that fails. If you ` +
      "genuinely can't verify in this environment, say so in one line and finish. Do not " +
      "re-edit code you've already changed without new evidence.";
    expect(codingSelfCheckNudge(3, "pytest")).toBe(original);
  });

  test("anti-churn nudge (original inline expression)", () => {
    const path = "src/app/main.py";
    const n = 6;
    const original =
      `[Anti-churn] You've edited ${path} ${n} times this session. If you're cycling between ` +
      "versions you can't tell apart, stop: reason from the code, keep the single version " +
      "you're most confident is correct, and finish. Don't revert a viable change without " +
      "new evidence it's wrong. If you're genuinely still making progress, continue.";
    expect(codingAntiChurnNudge(path, n)).toBe(original);
  });

  test("classifier system prompt (original inline expression)", () => {
    const top = 3;
    const original =
      `You route a coding task to the cheapest model that can plausibly do it. Rate the task's ` +
      `intrinsic difficulty on an integer scale from 0 to ${top}, where 0 = trivial/mechanical ` +
      `(rename, one-line fix, obvious boilerplate) and ${top} = very hard (subtle algorithms, ` +
      `tricky correctness/edge cases, deep multi-file reasoning). Bias LOW — a capable small ` +
      `model with test feedback handles most tasks; reserve high rungs for genuinely hard work. ` +
      `Reply ONLY with JSON: {"rung": <int 0..${top}>, "why": "<≤8 words>"}.`;
    expect(codingClassifierSystem(3)).toBe(original);
  });

  test("summarizer system prompt (original inline expression)", () => {
    const original =
      "You compress a coding session so work can continue seamlessly with full context. Write these sections, each concise but complete:\n" +
      "1. Intent — what the user is trying to accomplish, in their words where possible.\n" +
      "2. Tech — stack, frameworks, versions, and conventions in play.\n" +
      "3. Files — every file created/modified/examined that matters, with the key changes (include short code snippets only where essential to continue).\n" +
      "4. Errors & fixes — problems hit and how they were resolved (or not).\n" +
      "5. Decisions — choices made and why, including approaches rejected.\n" +
      "6. User messages — instructions, corrections, and preferences the user stated.\n" +
      "7. Pending — asked-for work not yet done.\n" +
      "8. Current state & next step — exactly where things stand and the immediate next action.\n" +
      "Output only the summary.";
    expect(CODING_PROFILE.loop.summarizerSystem).toBe(original);
  });

  test("condenser system prompt (original inline expression)", () => {
    const original =
      "You condense a large tool output for a coding agent so it fits in context without losing " +
      "what matters. PRESERVE VERBATIM: error messages, stack traces, failing test names, and any " +
      "lines directly relevant to making a fix. Summarize or drop boilerplate, repetition, and " +
      "irrelevant bulk. Begin with a one-line note like '[condensed from N lines]'. Never invent " +
      "content; if unsure whether a line matters, keep it.";
    expect(CODING_PROFILE.loop.condenserSystem).toBe(original);
  });

  test("verify-command regex behavior table (original semantics)", () => {
    const verifies = [
      "pytest tests/test_x.py",
      "npm run test",
      "bun test",
      "cargo check",
      "./gradlew subproject:test",
      "tsc -p tsconfig.json --noEmit",
      "make lint",
    ];
    const notVerifies = [
      "python -c 'import x'", // bare reproduction, deliberately excluded
      "git diff",
      "ls -la",
      "echo test", // "test" alone isn't a runner invocation
    ];
    for (const c of verifies) expect(CODING_VERIFY_CMD_RE.test(c)).toBe(true);
    for (const c of notVerifies) expect(CODING_VERIFY_CMD_RE.test(c)).toBe(false);
    expect(CODING_ENV_BROKEN_RE.test("ModuleNotFoundError: No module named 'foo'")).toBe(true);
    expect(CODING_ENV_BROKEN_RE.test("collected 0 items")).toBe(true);
    expect(CODING_ENV_BROKEN_RE.test("3 passed in 0.12s")).toBe(false);
  });

  test("coding profile defaults mirror 0.8.0 policy values", () => {
    expect(CODING_PROFILE.loop.churnThreshold).toBe(6);
    expect(CODING_PROFILE.verification.selfCheck).toEqual({ enabled: true, minEdits: 3 });
    expect(CODING_PROFILE.verification.agent.riskGateMinChangedLines).toBe(6);
    expect(CODING_PROFILE.verification.agent.failMode).toBe("open");
    expect(CODING_PROFILE.budgets.maxTurns).toBe(200);
    expect(CODING_PROFILE.tools.include).toEqual([]); // empty = all tools, pre-split behavior
    expect(CODING_PROFILE.permissions.defaultMode).toBe("autopilot");
  });
});

describe("capability tags", () => {
  test("Bash carries executes; Write/Edit carry edits (loop keys off tags, not names)", () => {
    expect(bashTool.executes).toBe(true);
    expect(bashTool.edits ?? false).toBe(false);
    expect(writeTool.edits).toBe(true);
    expect(editTool.edits).toBe(true);
    expect(writeTool.executes ?? false).toBe(false);
  });
});

describe("reviewer profile (generality proof)", () => {
  test("meaningfully different loop policy, not a prompt swap", () => {
    expect(REVIEWER_PROFILE.loop.verifyCommandRe).toBeNull();
    expect(REVIEWER_PROFILE.verification.selfCheck.enabled).toBe(false);
    expect(REVIEWER_PROFILE.verification.agent.enabled).toBe(true);
    expect(REVIEWER_PROFILE.verification.agent.failMode).toBe("closed");
    expect(REVIEWER_PROFILE.tools.include).not.toContain("Write");
    expect(REVIEWER_PROFILE.tools.include).not.toContain("Edit");
    expect(REVIEWER_PROFILE.permissions.defaultMode).toBe("recon");
    expect(REVIEWER_PROFILE.locked).toContain("permissions.defaultMode");
    expect(REVIEWER_PROFILE.telemetry.taskType).toBe("review");
  });
});

describe("profile loading", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yodex-profile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const opts = () => ({ cwd: dir, home: join(dir, "home") });

  function writeProfile(rel: string, yaml: string, files: Record<string, string> = {}) {
    const pdir = join(dir, rel);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "hop.yaml"), yaml);
    for (const [name, content] of Object.entries(files)) {
      const abs = join(pdir, name);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return pdir;
  }

  test("undefined ref loads the coding builtin", () => {
    const p = loadProfile(undefined, opts());
    expect(p.name).toBe("coding");
    expect(p.source).toBe("builtin");
  });

  test("builtins are discoverable by name", () => {
    expect(Object.keys(builtinProfiles()).sort()).toEqual(["coding", "reviewer"]);
    expect(loadProfile("reviewer", opts()).name).toBe("reviewer");
  });

  test("YAML profile extends a builtin, overrides leaves, inherits the rest", () => {
    const pdir = writeProfile("p/data-eng", [
      "spec: mlpal/hop-v1",
      "name: data-eng",
      "version: 0.1.0",
      "description: Data engineering",
      "extends: coding",
      "verification:",
      "  selfCheck: { minEdits: 5 }",
      "budgets: { maxTurns: 80 }",
      "telemetry: { taskType: data-eng }",
    ].join("\n"));
    const p = loadProfile(pdir, opts());
    expect(p.name).toBe("data-eng");
    expect(p.extendsChain).toEqual(["coding"]);
    expect(p.verification.selfCheck).toEqual({ enabled: true, minEdits: 5 }); // enabled inherited
    expect(p.budgets.maxTurns).toBe(80);
    expect(p.loop.taskType).toBe("data-eng");
    expect(p.prompts.system).toBe(CODING_PROFILE.prompts.system); // inherited
    expect(p.loop.verifyCommandRe).toBe(CODING_VERIFY_CMD_RE); // observe inherited
  });

  test("file: prompt refs resolve against the profile dir", () => {
    const pdir = writeProfile(
      "p/custom",
      [
        "spec: mlpal/hop-v1",
        "name: custom",
        "version: 0.1.0",
        "extends: coding",
        "prompts: { system: 'file:prompts/system.md' }",
      ].join("\n"),
      { "prompts/system.md": "You are a custom agent.\n" },
    );
    const p = loadProfile(pdir, opts());
    expect(p.prompts.system).toBe("You are a custom agent.");
  });

  test("named discovery: project .yodex/profiles beats user, both beat unknown", () => {
    writeProfile(".yodex/hops/team", [
      "spec: mlpal/hop-v1",
      "name: team",
      "version: 1.0.0",
      "extends: coding",
    ].join("\n"));
    const p = loadProfile("team", opts());
    expect(p.source).toBe("project");
    expect(() => loadProfile("ghost", opts())).toThrow(/unknown HOP "ghost".*coding, reviewer/s);
  });

  test("missing spec field is refused with the migration-rationale error", () => {
    const pdir = writeProfile("p/nospec", ["name: nospec", "version: 0.1.0"].join("\n"));
    expect(() => loadProfile(pdir, opts())).toThrow(/spec: mlpal\/hop-v1/);
  });

  test("unknown top-level keys are a loud error", () => {
    const pdir = writeProfile("p/junk", [
      "spec: mlpal/hop-v1",
      "name: junk",
      "version: 0.1.0",
      "sandbox: { mode: strict }",
    ].join("\n"));
    expect(() => loadProfile(pdir, opts())).toThrow(/junk|unrecognized/i);
  });

  test("a child may not override a parent-locked path; error names the parent", () => {
    const pdir = writeProfile("p/sneaky", [
      "spec: mlpal/hop-v1",
      "name: sneaky",
      "version: 0.1.0",
      "extends: reviewer",
      "permissions: { defaultMode: autopilot }",
    ].join("\n"));
    expect(() => loadProfile(pdir, opts())).toThrow(/locked by its parent "reviewer"/);
  });

  test("deny lists concatenate down the chain (one-way ratchet)", () => {
    const pdir = writeProfile("p/stricter", [
      "spec: mlpal/hop-v1",
      "name: stricter",
      "version: 0.1.0",
      "extends: reviewer",
      "permissions: { deny: ['Bash(curl*)'] }",
    ].join("\n"));
    const p = loadProfile(pdir, opts());
    expect(p.permissions.deny).toContain("Write"); // parent's
    expect(p.permissions.deny).toContain("Bash(curl*)"); // own
  });

  // A complete tuning HOP with an eval of each gating role. `human` promote avoids the auto-gate
  // requirement so these fixtures isolate one rule at a time.
  const tunedYaml = (over: Record<string, string> = {}) =>
    [
      "spec: mlpal/hop-v1",
      "name: tuned",
      "version: 1.0.0",
      "extends: coding",
      "evals:",
      "  - { name: gold, tasks: 'e/gold', scorer: 'pytest -q', role: golden }",
      "  - { name: front, tasks: 'e/front', scorer: 'measure', role: frontier }",
      "tuning:",
      `  cadence: ${over.cadence ?? "daily"}`,
      "  minRunsSinceLast: 200",
      "  canaryFraction: 0.1",
      "  canaryMinRuns: 50",
      `  promote: ${over.promote ?? "human"}`,
      `  frontierMetric: ${over.frontierMetric ?? "front"}`,
      "  promotionMargin: '-5% at p<.05'",
      `  goldenSuite: ${over.goldenSuite ?? "gold"}`,
    ].join("\n");

  test("tuning: block loads, resolves references, and defaults gates by role", () => {
    const p = loadProfile(writeProfile("p/tuned", tunedYaml()), opts());
    expect(p.tuning).toEqual({
      cadence: "daily",
      minRunsSinceLast: 200,
      canaryFraction: 0.1,
      canaryMinRuns: 50,
      promote: "human",
      frontierMetric: "front",
      promotionMargin: "-5% at p<.05",
      goldenSuite: "gold",
    });
    const byName = Object.fromEntries(p.evals.map((e) => [e.name, e]));
    expect(byName.gold!.gates).toBe(true); // golden gates by default
    expect(byName.front!.gates).toBe(false); // frontier is scored, not a gate
  });

  test("per-N-runs cadence is accepted", () => {
    const p = loadProfile(writeProfile("p/pern", tunedYaml({ cadence: "per-500-runs" })), opts());
    expect(p.tuning?.cadence).toBe("per-500-runs");
  });

  test("frontierMetric must name a role:frontier eval", () => {
    expect(() =>
      loadProfile(writeProfile("p/badfront", tunedYaml({ frontierMetric: "gold" })), opts()),
    ).toThrow(/frontierMetric "gold" must name an eval suite with role: frontier/);
  });

  test("goldenSuite must name a role:golden eval", () => {
    expect(() =>
      loadProfile(writeProfile("p/badgold", tunedYaml({ goldenSuite: "front" })), opts()),
    ).toThrow(/goldenSuite "front" must name an eval suite with role: golden/);
  });

  test("an incomplete tuning block is a loud error, never a silent partial", () => {
    const pdir = writeProfile("p/partial", [
      "spec: mlpal/hop-v1",
      "name: partial",
      "version: 1.0.0",
      "extends: coding",
      "tuning: { cadence: daily }",
    ].join("\n"));
    expect(() => loadProfile(pdir, opts())).toThrow(/missing required field "minRunsSinceLast"/);
  });

  test("promote: auto requires a mandatory-pass golden gate", () => {
    const pdir = writeProfile("p/autonogate", [
      "spec: mlpal/hop-v1",
      "name: autonogate",
      "version: 1.0.0",
      "extends: coding",
      "evals:",
      "  - { name: gold, tasks: 'e/gold', scorer: 'pytest', role: golden, gates: false }",
      "  - { name: front, tasks: 'e/front', scorer: 'measure', role: frontier }",
      "tuning:",
      "  cadence: daily",
      "  minRunsSinceLast: 200",
      "  canaryFraction: 0.1",
      "  canaryMinRuns: 50",
      "  promote: auto",
      "  frontierMetric: front",
      "  promotionMargin: '-5%'",
      "  goldenSuite: gold",
    ].join("\n"));
    expect(() => loadProfile(pdir, opts())).toThrow(/promote: auto but its golden suite "gold" does not gate/);
  });

  test("promote: auto loads when the golden suite gates", () => {
    const p = loadProfile(writeProfile("p/autook", tunedYaml({ promote: "auto" })), opts());
    expect(p.tuning?.promote).toBe("auto");
  });

  test("locked: [tuning.promote] in a parent blocks a child override (blast-radius ratchet)", () => {
    writeProfile(".yodex/hops/base", tunedYaml() + "\nlocked: [tuning.promote]");
    const child = writeProfile("p/child", [
      "spec: mlpal/hop-v1",
      "name: child",
      "version: 1.0.0",
      "extends: base",
      "tuning: { promote: auto }",
    ].join("\n"));
    expect(() => loadProfile(child, opts())).toThrow(/overrides "tuning.promote", which is locked by its parent "tuned"/);
  });

  test("a HOP without a tuning block is valid (un-tuned)", () => {
    const p = loadProfile(writeProfile("p/untuned", [
      "spec: mlpal/hop-v1",
      "name: untuned",
      "version: 1.0.0",
      "extends: coding",
    ].join("\n")), opts());
    expect(p.tuning).toBeUndefined();
  });

  test("settings lock enforcement: explicit user mode vs a locked defaultMode errors", () => {
    expect(() => assertSettingsRespectLocks(REVIEWER_PROFILE, { mode: "autopilot" })).toThrow(
      /profile "reviewer" locks "permissions.defaultMode"/,
    );
    // Not explicitly set → schema default never counts as user intent.
    expect(() => assertSettingsRespectLocks(REVIEWER_PROFILE, {})).not.toThrow();
    // Coding locks nothing.
    expect(() => assertSettingsRespectLocks(CODING_PROFILE, { mode: "manual" })).not.toThrow();
  });
});

describe("verifier deliverable framing", () => {
  test("reviewer framing embeds the report; empty deliverable is itself flagged", async () => {
    const { reviewerVerifierTask } = await import("../src/profile/builtins/reviewer");
    const framed = reviewerVerifierTask("review the repo", "## Findings\nD1 x.py:3 off-by-one");
    expect(framed).toContain("<review_report>");
    expect(framed).toContain("D1 x.py:3 off-by-one");
    const empty = reviewerVerifierTask("review the repo", "");
    expect(empty).toContain("No review text was produced");
  });

  test("coding framing is unchanged by the deliverable param (golden)", async () => {
    const { codingVerifierTask } = await import("../src/profile/builtins/coding");
    expect(codingVerifierTask("TASK", "ignored")).toBe(codingVerifierTask("TASK"));
  });
});
