import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CODING_PROFILE,
  codingAntiChurnNudge,
  codingClassifierSystem,
  codingSelfCheckNudge,
  CODING_ENV_BROKEN_RE,
  CODING_VERIFY_CMD_RE, CODING_MEMORY_CONTRACT } from "../src/profile/builtins/coding";
import { REVIEWER_PROFILE } from "../src/profile/builtins/reviewer";
import { assertSettingsRespectLocks, builtinProfiles, HopPathError, loadProfile } from "../src/profile/load";
import { describeProfile } from "../src/profile/describe";
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
    expect(CODING_PROFILE.tools.include).toBeUndefined(); // absent = all tools, pre-split behavior
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

  test("verification.agent.task defines the verifier framing in YAML (text-deliverable HOPs)", () => {
    const p = loadProfile(writeProfile("p/vtask", [
      "spec: mlpal/hop-v1", "name: vtask", "version: 1.0.0", "extends: coding",
      "verification: { agent: { task: 'Check {task} -- result: {deliverable}' } }",
    ].join("\n")), opts());
    expect(p.prompts.verifierTask("do X", "the result")).toBe("Check do X -- result: the result");
    expect(p.prompts.verifierTask("do X")).toBe("Check do X -- result: (no deliverable on disk)");
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

  // ---- v1.1 additive blocks ----

  test("model block loads; main required; allowInvokeAny defaults true; subagents compose", () => {
    const p = loadProfile(writeProfile("p/m", [
      "spec: mlpal/hop-v1",
      "name: m",
      "version: 1.0.0",
      "extends: coding",
      "model: { main: frontier, subagents: { readOnly: cheap } }",
    ].join("\n")), opts());
    expect(p.model).toEqual({ main: "frontier", subagents: { readOnly: "cheap" }, allowInvokeAny: true });
  });

  test("a model block without main is a loud error", () => {
    const pdir = writeProfile("p/nomain", [
      "spec: mlpal/hop-v1",
      "name: nomain",
      "version: 1.0.0",
      "extends: coding",
      "model: { subagents: { verify: mid } }",
    ].join("\n"));
    expect(() => loadProfile(pdir, opts())).toThrow(/model block without model.main/);
  });

  test("model.main is tunable via an enum-set range (the x12 gap)", () => {
    const p = loadProfile(writeProfile("p/tm", [
      "spec: mlpal/hop-v1",
      "name: tm",
      "version: 1.0.0",
      "extends: coding",
      "model: { main: frontier }",
      "tunable: [ { path: model.main, range: [frontier, max] } ]",
    ].join("\n")), opts());
    const t = p.tunable.find((x) => x.path === "model.main");
    expect(t?.range).toEqual(["frontier", "max"]); // enum-set, not numeric
  });

  test("model.tiers load, compose (inline override), and main resolves to a declared tier", () => {
    writeProfile(".yodex/hops/base-tiers", [
      "spec: mlpal/hop-v1",
      "name: base-tiers",
      "version: 1.0.0",
      "extends: coding",
      "model:",
      "  main: frontier",
      "  tiers:",
      "    cheap: { primary: gpt-5.6-luna, fallbacks: [claude-haiku-4-5] }",
      "    frontier: { primary: claude-opus-5, fallbacks: [gpt-5.6-sol] }",
    ].join("\n"));
    const p = loadProfile(writeProfile("p/child-tiers", [
      "spec: mlpal/hop-v1",
      "name: child-tiers",
      "version: 1.0.0",
      "extends: base-tiers",
      "model: { tiers: { frontier: { primary: claude-opus-5, fallbacks: [] } } }", // override just frontier
    ].join("\n")), opts());
    expect(p.model?.tiers?.cheap?.primary).toBe("gpt-5.6-luna"); // inherited
    expect(p.model?.tiers?.frontier?.fallbacks).toEqual([]); // overridden
    expect(p.warnings ?? []).toEqual([]); // fully pinned, no warning
  });

  test("tier NAMES follow a grammar (a digit/uppercase in a tier name is a load error)", () => {
    const bad = writeProfile("p/badtier", [
      "spec: mlpal/hop-v1", "name: badtier", "version: 1.0.0", "extends: coding",
      "model: { main: frontier, tiers: { tier2: { primary: claude-opus-5 }, frontier: { primary: claude-opus-5 } } }",
    ].join("\n"));
    expect(() => loadProfile(bad, opts())).toThrow(/model.tiers name "tier2" must match/);
  });

  test("classification is table membership: a non-table token is a pinned id, not an unknown tier", () => {
    // `sol`-style: a bare token not in the table resolves as a pinned id at serving, no load error.
    const ok = loadProfile(writeProfile("p/pinnedref", [
      "spec: mlpal/hop-v1", "name: pinnedref", "version: 1.0.0", "extends: coding",
      "model: { main: sol, tiers: { frontier: { primary: claude-opus-5 } } }",
    ].join("\n")), opts());
    expect(ok.model?.main).toBe("sol"); // treated as an id, resolved by the serving layer
    // an id with a digit likewise
    const ok2 = loadProfile(writeProfile("p/pinned2", [
      "spec: mlpal/hop-v1", "name: pinned2", "version: 1.0.0", "extends: coding",
      "model: { main: claude-opus-5, tiers: { frontier: { primary: claude-opus-5 } } }",
    ].join("\n")), opts());
    expect(ok2.model?.main).toBe("claude-opus-5");
  });

  test("a model.main fallback that is a lower tier's primary is a load error", () => {
    const bad = writeProfile("p/downfall", [
      "spec: mlpal/hop-v1", "name: downfall", "version: 1.0.0", "extends: coding",
      "model:",
      "  main: frontier",
      "  tiers:",
      "    cheap: { primary: gpt-5.6-luna }",
      "    frontier: { primary: claude-opus-5, fallbacks: [gpt-5.6-luna] }", // cheap's primary!
    ].join("\n"));
    expect(() => loadProfile(bad, opts())).toThrow(/may not silently degrade downward/);
  });

  test("an unknown-tier fallback loads with a warning; catalog-only warns unpinned", () => {
    const p = loadProfile(writeProfile("p/unkfall", [
      "spec: mlpal/hop-v1", "name: unkfall", "version: 1.0.0", "extends: coding",
      "model: { main: frontier, tiers: { frontier: { primary: claude-opus-5, fallbacks: [gpt-5.6-sol] } } }",
    ].join("\n")), opts());
    expect(p.warnings?.some((w) => w.includes("gpt-5.6-sol"))).toBe(true);

    const catalogOnly = loadProfile(writeProfile("p/catonly", [
      "spec: mlpal/hop-v1", "name: catonly", "version: 1.0.0", "extends: coding",
      "model: { main: frontier }", // no tiers, no subscribe
    ].join("\n")), opts());
    expect(catalogOnly.warnings?.some((w) => w.includes("unpinned"))).toBe(true);
  });

  test("subscribe defers an unknown tier to the host baseline (no load error)", () => {
    const p = loadProfile(writeProfile("p/sub", [
      "spec: mlpal/hop-v1", "name: sub", "version: 1.0.0", "extends: coding",
      "model: { main: premium, subscribe: 'coding@3' }", // premium comes from the baseline
    ].join("\n")), opts());
    expect(p.model?.subscribe).toBe("coding@3");
    expect(p.model?.main).toBe("premium");
  });

  test("requires keyring rungs: models/memory override, agents by name, skills union; absent stays absent", () => {
    const parent = writeProfile("p/rungs-parent", [
      "spec: mlpal/hop-v1",
      "name: rungs-parent",
      "version: 1.0.0",
      "extends: coding",
      "requires: { models: { tiers: [frontier] }, agents: [ { name: triage } ], skills: [docx], memory: { read: true } }",
    ].join("\n"));
    const child = writeProfile("p/rungs-child", [
      "spec: mlpal/hop-v1",
      "name: rungs-child",
      "version: 1.0.0",
      `extends: ${parent}`,
      "requires: { models: { tiers: [frontier, cheap] }, agents: [ { name: triage, optional: true }, { name: fixer } ], skills: [hop-builder], memory: { read: true, write: true } }",
    ].join("\n"));
    const p = loadProfile(child, opts());
    expect(p.requires?.models).toEqual({ tiers: ["frontier", "cheap"] });
    expect(p.requires?.agents).toEqual([{ name: "triage", optional: true }, { name: "fixer" }]);
    expect(p.requires?.skills).toEqual(["docx", "hop-builder"]);
    expect(p.requires?.memory).toEqual({ read: true, write: true });
    const plain = loadProfile(writeProfile("p/rungs-none", ["spec: mlpal/hop-v1", "name: rungs-none", "version: 1.0.0", "extends: coding", "requires: { mcp: [ { name: memory } ] }"].join("\n")), opts());
    // coding's own keyring defaults (every tier + the platform web-search server) are inherited
    expect(plain.requires).toEqual({ binaries: [], mcp: [{ name: "websearch" }, { name: "memory" }], models: { tiers: ["cheap", "mid", "frontier", "max"] }, memory: { read: true, write: true } });
  });

  test("requires block unions binaries + mcp by name down the chain", () => {
    writeProfile(".yodex/hops/base-req", [
      "spec: mlpal/hop-v1",
      "name: base-req",
      "version: 1.0.0",
      "extends: coding",
      "requires: { binaries: [ { name: aws, detect: 'aws --version' } ], mcp: [ { name: aws-mcp } ] }",
    ].join("\n"));
    const p = loadProfile(writeProfile("p/child-req", [
      "spec: mlpal/hop-v1",
      "name: child-req",
      "version: 1.0.0",
      "extends: base-req",
      "requires: { binaries: [ { name: terraform, detect: 'terraform version' } ] }",
    ].join("\n")), opts());
    expect(p.requires?.binaries.map((b) => b.name).sort()).toEqual(["aws", "terraform"]);
    expect(p.requires?.mcp.map((m) => m.name)).toEqual(["websearch", "aws-mcp"]); // inherited from coding, then base-req
  });

  test("safety.sandbox (§10.3) loads with its defaults left to the host, and rejects unknown keys", () => {
    const p = loadProfile(writeProfile("p/sbx", [
      "spec: mlpal/hop-v1",
      "name: sbx",
      "version: 1.0.0",
      "extends: coding",
      "permissions: { defaultMode: cruise }",
      "safety: { sandbox: { filesystem: { mode: readOnly, allowRead: ['~/.kube'] }, network: { mode: allowlist, allow: ['*.amazonaws.com'] }, env: { keep: [AWS_PROFILE] }, required: true } }",
    ].join("\n")), opts());
    expect(p.safety?.sandbox).toEqual({
      filesystem: { mode: "readOnly", allowRead: ["~/.kube"] },
      network: { mode: "allowlist", allow: ["*.amazonaws.com"] },
      env: { keep: ["AWS_PROFILE"] },
      required: true,
    });
    expect(p.locked).toContain("safety");
    expect(() =>
      loadProfile(writeProfile("p/sbx-bad", [
        "spec: mlpal/hop-v1",
        "name: sbx-bad",
        "version: 1.0.0",
        "extends: coding",
        "permissions: { defaultMode: cruise }",
        "safety: { sandbox: { network: { mode: firewall } } }",
      ].join("\n")), opts()),
    ).toThrow();
  });

  test("safety block loads and is AUTO-LOCKED (child cannot override it)", () => {
    const p = loadProfile(writeProfile("p/saf", [
      "spec: mlpal/hop-v1",
      "name: saf",
      "version: 1.0.0",
      "extends: coding",
      "permissions: { defaultMode: cruise }", // safety + autopilot is a load error (review 22)
      "safety: { blastRadius: { maxResources: 25 } }",
    ].join("\n")), opts());
    expect(p.safety?.blastRadius.maxResources).toBe(25);
    expect(p.safety?.approval.destructive).toBe("always"); // default
    expect(p.locked).toContain("safety"); // auto-locked

    writeProfile(".yodex/hops/base-saf", [
      "spec: mlpal/hop-v1",
      "name: base-saf",
      "version: 1.0.0",
      "extends: coding",
      "permissions: { defaultMode: cruise }",
      "safety: { blastRadius: { maxResources: 25 } }",
    ].join("\n"));
    const child = writeProfile("p/loosen", [
      "spec: mlpal/hop-v1",
      "name: loosen",
      "version: 1.0.0",
      "extends: base-saf",
      "safety: { blastRadius: { maxResources: 9999 } }",
    ].join("\n"));
    expect(() => loadProfile(child, opts())).toThrow(/overrides "safety.*which is locked by its parent "base-saf"/s);
  });

  test("safety + defaultMode autopilot is a load error (review 22)", () => {
    const pdir = writeProfile("p/safauto", [
      "spec: mlpal/hop-v1", "name: safauto", "version: 1.0.0", "extends: coding",
      "permissions: { defaultMode: autopilot }",
      "safety: { blastRadius: { maxResources: 10 } }",
    ].join("\n"));
    expect(() => loadProfile(pdir, opts())).toThrow(/safety block with defaultMode: autopilot/);
  });

  test("promote: auto with a safety block is refused (review 24)", () => {
    const pdir = writeProfile("p/safpromote", [
      "spec: mlpal/hop-v1", "name: safpromote", "version: 1.0.0", "extends: coding",
      "permissions: { defaultMode: cruise }",
      "safety: { blastRadius: { maxResources: 10 } }",
      "evals:",
      "  - { name: g, tasks: 'e/g', scorer: 'pytest', role: golden }",
      "  - { name: f, tasks: 'e/f', scorer: 'm', role: frontier }",
      "tuning: { cadence: daily, minRunsSinceLast: 200, canaryFraction: 0.1, canaryMinRuns: 50, promote: auto, frontierMetric: f, promotionMargin: '-5%', goldenSuite: g }",
    ].join("\n"));
    expect(() => loadProfile(pdir, opts())).toThrow(/promote: auto with a safety block present/);
  });

  test("tuning.maxAge accepted; cadence on-incident rejected (review 8, 9)", () => {
    const p = loadProfile(writeProfile("p/maxage", [
      "spec: mlpal/hop-v1", "name: maxage", "version: 1.0.0", "extends: coding",
      "evals:",
      "  - { name: g, tasks: 'e/g', scorer: 'pytest', role: golden }",
      "  - { name: f, tasks: 'e/f', scorer: 'm', role: frontier }",
      "tuning: { cadence: per-30-runs, maxAge: 4w, minRunsSinceLast: 30, canaryFraction: 0.1, canaryMinRuns: 20, promote: human, frontierMetric: f, promotionMargin: '-5%', goldenSuite: g }",
    ].join("\n")), opts());
    expect(p.tuning?.maxAge).toBe("4w");
    const bad = writeProfile("p/oncad", [
      "spec: mlpal/hop-v1", "name: oncad", "version: 1.0.0", "extends: coding",
      "tuning: { cadence: on-incident, minRunsSinceLast: 1, canaryFraction: 0.1, canaryMinRuns: 1, promote: human, frontierMetric: f, promotionMargin: '-5%', goldenSuite: g }",
    ].join("\n"));
    expect(() => loadProfile(bad, opts())).toThrow(/cadence/i);
  });

  test("tuning.triggers array loads beside cadence", () => {
    const p = loadProfile(writeProfile("p/trig", [
      "spec: mlpal/hop-v1",
      "name: trig",
      "version: 1.0.0",
      "extends: coding",
      "evals:",
      "  - { name: g, tasks: 'e/g', scorer: 'pytest', role: golden }",
      "  - { name: f, tasks: 'e/f', scorer: 'm', role: frontier }",
      "tuning:",
      "  cadence: weekly",
      "  triggers: [on-model-release, on-incident]",
      "  minRunsSinceLast: 200",
      "  canaryFraction: 0.1",
      "  canaryMinRuns: 50",
      "  promote: human",
      "  frontierMetric: f",
      "  promotionMargin: '-5%'",
      "  goldenSuite: g",
    ].join("\n")), opts());
    expect(p.tuning?.triggers).toEqual(["on-model-release", "on-incident"]);
  });

  test("versioned layout: bare ref resolves highest semver; @version pins", () => {
    writeProfile(".yodex/hops/infra/1.0.0", ["spec: mlpal/hop-v1", "name: infra", "version: 1.0.0", "extends: coding"].join("\n"));
    writeProfile(".yodex/hops/infra/1.2.0", ["spec: mlpal/hop-v1", "name: infra", "version: 1.2.0", "extends: coding"].join("\n"));
    writeProfile(".yodex/hops/infra/1.1.0", ["spec: mlpal/hop-v1", "name: infra", "version: 1.1.0", "extends: coding"].join("\n"));
    expect(loadProfile("infra", opts()).version).toBe("1.2.0"); // highest
    expect(loadProfile("infra@1.1.0", opts()).version).toBe("1.1.0"); // pinned
    expect(() => loadProfile("infra@9.9.9", opts())).toThrow(/infra@9.9.9" not found/);
  });

  test("versioned layout: flat + versioned in one dir is a loud error", () => {
    writeProfile(".yodex/hops/dup", ["spec: mlpal/hop-v1", "name: dup", "version: 1.0.0", "extends: coding"].join("\n"));
    writeProfile(".yodex/hops/dup/2.0.0", ["spec: mlpal/hop-v1", "name: dup", "version: 2.0.0", "extends: coding"].join("\n"));
    expect(() => loadProfile("dup", opts())).toThrow(/both a flat hop.yaml and versioned subdirs/);
  });

  test("versioned layout: @version pin against a flat layout errors", () => {
    writeProfile(".yodex/hops/flatonly", ["spec: mlpal/hop-v1", "name: flatonly", "version: 1.0.0", "extends: coding"].join("\n"));
    expect(() => loadProfile("flatonly@1.0.0", opts())).toThrow(/uses the flat layout \(no versions\)/);
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

describe("v1.1 riskGate + memory.workspace", () => {
  test("riskGate defaults to changed-lines and a child may select actions; memory.workspace composes child over parent", () => {
    const dir = mkdtempSync(join(tmpdir(), "hop-rg-"));
    try {
      writeFileSync(
        join(dir, "hop.yaml"),
        "spec: mlpal/hop-v1\nname: infra-like\nversion: 0.0.1\ndescription: t\nextends: coding\nverification:\n  agent: { riskGate: actions }\nmemory: { workspace: infra }\n",
      );
      const p = loadProfile(dir, { cwd: dir, home: join(dir, "home") });
      expect(p.verification.agent.riskGate).toBe("actions");
      // memory v13: coding carries the work-memory contract, so a child that names only a
      // workspace inherits the parent's policy, topics and globs under its own workspace.
      expect(p.memory?.workspace).toBe("infra");
      expect(p.memory?.topics).toEqual(CODING_MEMORY_CONTRACT.topics);
      expect(p.memory?.writes).toEqual(CODING_MEMORY_CONTRACT.writes);
      expect(builtinProfiles().coding!.verification.agent.riskGate).toBe("changed-lines");
      expect(builtinProfiles().coding!.memory).toEqual(CODING_MEMORY_CONTRACT);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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


describe("v1.1 §9.2 memory.policy", () => {
  const base = "spec: mlpal/hop-v1\nname: p\nversion: 0.0.1\ndescription: t\nextends: coding\n";
  const load = (yaml: string) => {
    const dir = mkdtempSync(join(tmpdir(), "hop-mem-"));
    writeFileSync(join(dir, "hop.yaml"), yaml);
    try {
      return loadProfile(dir, { cwd: dir, home: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  test("loads the closed sets and defaults feeds to both consumers", () => {
    const p = load(base + "memory:\n  workspace: infra\n  policy:\n    record: [refusal, unmodelled]\n");
    expect(p.memory?.workspace).toBe("infra");
    expect(p.memory?.policy).toEqual({ record: ["refusal", "unmodelled"], feeds: ["tune", "evals"] });
    expect(p.memory?.topics).toEqual(CODING_MEMORY_CONTRACT.topics); // inherited from coding (memory v13)
  });
  test("an unknown kind is a load error naming the value", () => {
    expect(() => load(base + "memory:\n  policy:\n    record: [refusal, hiccup]\n")).toThrow(/unknown kind "hiccup"/);
  });
  test("a policy that feeds nothing, or repeats a kind, is refused", () => {
    expect(() => load(base + "memory:\n  policy:\n    record: [refusal]\n    feeds: []\n")).toThrow(/at least one consumer/);
    expect(() => load(base + "memory:\n  policy:\n    record: [refusal, refusal]\n")).toThrow(/twice/);
  });
  test("a policy without a workspace still loads; a child's policy replaces the parent's whole block", () => {
    const p = load(base + "memory:\n  policy:\n    record: [surprise]\n");
    expect(p.memory?.policy).toEqual({ record: ["surprise"], feeds: ["tune", "evals"] });
    expect(p.memory?.workspace).toBe("from-host"); // coding's placeholder, filled by the host
    const parentDir = mkdtempSync(join(tmpdir(), "hop-mem-parent-"));
    writeFileSync(join(parentDir, "hop.yaml"), base.replace("name: p", "name: parent") + "memory:\n  workspace: w\n  policy:\n    record: [refusal, escalation]\n    feeds: [tune]\n");
    const childDir = mkdtempSync(join(tmpdir(), "hop-mem-child-"));
    writeFileSync(join(childDir, "hop.yaml"), `spec: mlpal/hop-v1\nname: child\nversion: 0.0.1\ndescription: t\nextends: ${parentDir}\nmemory:\n  policy:\n    record: [correction]\n`);
    try {
      const c = loadProfile(childDir, { cwd: childDir, home: childDir });
      expect(c.memory?.workspace).toBe("w");
      expect(c.memory?.policy).toEqual({ record: ["correction"], feeds: ["tune", "evals"] });
      expect(c.memory?.topics).toEqual(CODING_MEMORY_CONTRACT.topics); // inherited through the parent from coding
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
      rmSync(childDir, { recursive: true, force: true });
    }
  });
});


describe("v1.1 §9.3 memory.contract", () => {
  const base = "spec: mlpal/hop-v1\nname: p\nversion: 0.0.1\ndescription: t\nextends: coding\n";
  const load = (yaml: string) => {
    const dir = mkdtempSync(join(tmpdir(), "hop-mc-"));
    writeFileSync(join(dir, "hop.yaml"), yaml);
    try {
      return loadProfile(dir, { cwd: dir, home: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const contract = `memory:
  workspace: infra
  tenant: acme-infra
  topics:
    - { id: infra/state/cost-daily, kind: state, key: date, halfLife: 1d, read: company, inject: true }
    - { id: "infra/state/watch/{target}", kind: state, key: target, read: company }
    - { id: infra/learning, kind: learning, key: dedup, read: company }
    - { id: "person/{me}/pref/infra", kind: preference, key: field, read: self }
  reads: [company/ownership]
  writes: ["infra/*", "person/{me}/pref/infra"]
`;
  test("managed HOPs: a topic may say what feeds back to the publisher; ask needs the publication", () => {
    const yaml = base + "memory:\n  publication: \"5\"\n  topics:\n    - { id: x/feedback, kind: learning, key: dedup, read: owner, feedback: ask }\n    - { id: x/dev, kind: deviation, key: dedup, read: owner, feedback: declared-only }\n    - { id: x/state/a, kind: state, key: date, read: owner }\n";
    const p = load(yaml);
    expect(p.memory!.publication).toBe("5");
    expect(p.memory!.topics!.map((t) => t.feedback)).toEqual(["ask", "declared-only", undefined]);
    expect(() => load(base + "memory:\n  topics:\n    - { id: x/feedback, kind: learning, key: dedup, read: owner, feedback: ask }\n")).toThrow(/needs memory.publication/);
    expect(() => load(base + "memory:\n  publication: \"5\"\n  topics:\n    - { id: x/feedback, kind: learning, key: dedup, read: owner, feedback: always }\n")).toThrow(/not one of off, declared-only, ask/);
  });

  test("loads the contract, fills half-life defaults, keeps writes and reads", () => {
    const p = load(base + contract);
    const c = p.memory!;
    expect(c.tenant).toBe("acme-infra");
    expect(c.topics!.map((t) => [t.id, t.halfLife, t.inject])).toEqual([
      ["infra/state/cost-daily", "1d", true],
      ["infra/state/watch/{target}", "2x", false],
      ["infra/learning", "1y", false],
      ["person/{me}/pref/infra", "none", false],
    ]);
    expect(c.reads).toEqual(["company/ownership"]);
    expect(c.writes).toEqual(["infra/*", "person/{me}/pref/infra"]);
  });
  test("writes defaults to the declared topic ids when omitted", () => {
    const p = load(base + "memory:\n  topics:\n    - { id: x/state/a, kind: state, key: date, read: owner }\n");
    expect(p.memory!.writes).toEqual(["x/state/a"]);
  });
  test("refuses an unknown kind, an unknown read scope, a state topic keyed dedup, a duplicate id and an uncovered topic, naming the value", () => {
    expect(() => load(base + "memory:\n  topics:\n    - { id: x/a, kind: blob, key: date, read: owner }\n")).toThrow(/unknown kind "blob"/);
    expect(() => load(base + "memory:\n  topics:\n    - { id: x/a, kind: state, key: date, read: everyone }\n")).toThrow(/unknown scope "everyone"/);
    expect(() => load(base + "memory:\n  topics:\n    - { id: x/a, kind: state, key: dedup, read: owner }\n")).toThrow(/needs a key other than dedup/);
    expect(() => load(base + "memory:\n  topics:\n    - { id: x/a, kind: state, key: date, read: owner }\n    - { id: x/a, kind: learning, key: dedup, read: owner }\n")).toThrow(/duplicate id "x\/a"/);
    expect(() => load(base + "memory:\n  topics:\n    - { id: y/a, kind: state, key: date, read: owner }\n  writes: [\"x/*\"]\n")).toThrow(/not covered by writes/);
    expect(() => load(base + "memory:\n  topics:\n    - { id: x/a, kind: state, key: date, read: owner, halfLife: soon }\n")).toThrow(/halfLife/);
  });
  test("policy accepts the positive kinds and the personalize feed", () => {
    const p = load(base + "memory:\n  policy:\n    record: [refusal, outcome, preference]\n    feeds: [personalize]\n");
    expect(p.memory!.policy).toEqual({ record: ["refusal", "outcome", "preference"], feeds: ["personalize"] });
  });
});

describe("capability modules (memory v10)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "yodex-modules-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const yamlFor = (gcloud: string) => `spec: mlpal/hop-v1
name: cloudy
version: 0.1.0
extends: coding
prompts:
  system: file:prompts/system.md
modules:
  aws:
    prompt: file:prompts/aws.md
    tools: [Bash]
  gcloud:
    prompt: file:prompts/gcloud.md
    enabled: ${gcloud}
tunable:
  - path: modules.gcloud.enabled
    range: [on, off]
`;
  const files = { "prompts/system.md": "You manage clouds.", "prompts/aws.md": "AWS section: use aws cli.", "prompts/gcloud.md": "GCP section: use gcloud." };
  function write(gcloud: string) {
    const pdir = join(dir, "cloudy");
    mkdirSync(join(pdir, "prompts"), { recursive: true });
    writeFileSync(join(pdir, "hop.yaml"), yamlFor(gcloud));
    for (const [n, c] of Object.entries(files)) writeFileSync(join(pdir, n), c);
    return pdir;
  }
  test("enabled modules join the system prompt in order; a switched-off one stays out but in the artifact", () => {
    const on = loadProfile(write("on"), { cwd: dir, home: join(dir, "home") });
    expect(on.prompts.system).toContain("You manage clouds.");
    expect(on.prompts.system.indexOf("AWS section")).toBeLessThan(on.prompts.system.indexOf("GCP section"));
    expect(on.modules.gcloud!.enabled).toBe(true);
    expect(on.tunable.some((t) => t.path === "modules.gcloud.enabled")).toBe(true);
    const off = loadProfile(write("off"), { cwd: dir, home: join(dir, "home") });
    expect(off.prompts.system).toContain("AWS section");
    expect(off.prompts.system).not.toContain("GCP section");
    expect(off.modules.gcloud!.enabled).toBe(false);
    expect(Object.keys(off.modules)).toEqual(["aws", "gcloud"]);
  });
});

describe("tools.include: absent = all registered, [] = none (2026-10-26)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hop-tools-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const head = (name: string, ext: string) => `spec: mlpal/hop-v1\nname: ${name}\nversion: 0.0.1\ndescription: t\nextends: ${ext}\n`;
  function write(name: string, yaml: string): string {
    const pdir = join(dir, name);
    mkdirSync(join(pdir, "prompts"), { recursive: true });
    writeFileSync(join(pdir, "hop.yaml"), yaml);
    writeFileSync(join(pdir, "prompts", "m.md"), "module section");
    return pdir;
  }
  const load = (pdir: string) => loadProfile(pdir, { cwd: dir, home: join(dir, "home") });
  const listParent = () => write("listed", head("listed", "coding") + "tools:\n  include: [Read, Grep]\n");

  test("the coding builtin resolves with include absent (= every registered tool)", () => {
    expect(CODING_PROFILE.tools.include).toBeUndefined();
    expect(loadProfile("coding", { cwd: dir, home: join(dir, "home") }).tools.include).toBeUndefined();
    expect("include" in describeProfile(CODING_PROFILE).tools).toBe(false);
  });

  test("a HOP that omits tools resolves with include absent", () => {
    expect(load(write("plain", head("plain", "coding"))).tools.include).toBeUndefined();
  });

  test("a HOP that writes include: [] resolves to [] (no tools)", () => {
    expect(load(write("bare", head("bare", "coding") + "tools:\n  include: []\n")).tools.include).toEqual([]);
  });

  test("a child that omits tools.include inherits its parent's list", () => {
    const parent = listParent();
    expect(load(write("kid", head("kid", parent))).tools.include).toEqual(["Read", "Grep"]);
  });

  test("a child that writes [] overrides its parent's list with none", () => {
    const parent = listParent();
    expect(load(write("kid", head("kid", parent) + "tools:\n  include: []\n")).tools.include).toEqual([]);
  });

  const withModule = (include: string | null) =>
    head("mod", "coding") +
    (include === null ? "" : `tools:\n  include: ${include}\n`) +
    "modules:\n  aws:\n    prompt: file:prompts/m.md\n    tools: [Bash]\n  off:\n    prompt: file:prompts/m.md\n    tools: [Write]\n    enabled: off\n";

  test("an enabled module's tools merge into [] and into a list; a disabled module's do not", () => {
    expect(load(write("m1", withModule("[]"))).tools.include).toEqual(["Bash"]);
    expect(load(write("m2", withModule("[Read]"))).tools.include).toEqual(["Read", "Bash"]);
  });

  test("an enabled module leaves an absent include absent (all tools already include it)", () => {
    expect(load(write("m3", withModule(null))).tools.include).toBeUndefined();
  });
});

describe("builtin HOPs pinned by version", () => {
  test("coding@<its version> loads the builtin; another version is refused by name", () => {
    const opts = { cwd: "/nonexistent-cwd", home: "/nonexistent-home" };
    const coding = loadProfile("coding", opts);
    expect(loadProfile(`coding@${coding.version}`, opts).name).toBe("coding");
    expect(loadProfile(`reviewer@${loadProfile("reviewer", opts).version}`, opts).name).toBe("reviewer");
    expect(() => loadProfile("coding@0.0.1", opts)).toThrow(/version .* in this build/);
    expect(() => loadProfile("nope@1.0.0", opts)).toThrow(/unknown HOP/);
  });
});

describe("describeProfile", () => {
  test("every builtin describes to plain data that survives JSON, with the prompts, the lock list and the loop's regexes as source", () => {
    for (const p of Object.values(builtinProfiles())) {
      const view = describeProfile(p);
      const round = JSON.parse(JSON.stringify(view)) as typeof view;
      expect(round).toEqual(view);
      expect(round.name).toBe(p.name);
      expect(round.prompts.system).toBe(p.prompts.system);
      expect(round.locked).toEqual(p.locked);
      expect(round.loop.verifyCommand).toBe(p.loop.verifyCommandRe?.source ?? null);
      expect(JSON.stringify(round)).not.toContain("=>");
    }
    expect(describeProfile(loadProfile("reviewer", { cwd: "/x", home: "/y" })).permissions.defaultMode).toBe("recon");
  });
});

describe("loadProfile confineTo: every path an assigned bundle's HOP reads stays inside it", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hop-confine-"));
    mkdirSync(join(root, "bundle", "prompts"), { recursive: true });
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(join(root, "secrets", "gateway.token"), "test-secret-token");
    writeFileSync(join(root, "bundle", "prompts", "system.md"), "be careful\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const hop = (body: string) => writeFileSync(join(root, "bundle", "hop.yaml"), `spec: mlpal/hop-v1\nname: confined\nversion: 1.0.0\n${body}`);
  const load = () => loadProfile(join(root, "bundle"), { cwd: root, home: root, confineTo: join(root, "bundle") });
  const refused = (field: string) => {
    let e: unknown;
    try {
      load();
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(HopPathError);
    expect((e as HopPathError).field).toBe(field);
    return e as HopPathError;
  };

  test("a file: reference inside the bundle loads", () => {
    hop("prompts: { system: 'file:prompts/system.md' }\n");
    expect(load().prompts.system).toBe("be careful");
  });
  test("an absolute file: reference outside it is refused, naming the path; nothing is read", () => {
    hop(`prompts: { system: 'file:${join(root, "secrets", "gateway.token")}' }\n`);
    expect(refused("prompts.system").path).toBe(join(root, "secrets", "gateway.token"));
  });
  test("a ../ file: reference is refused", () => {
    hop("prompts: { system: 'file:../secrets/gateway.token' }\n");
    refused("prompts.system");
  });
  test("a file: reference through a symlink that leaves the bundle is refused (links resolved first)", () => {
    symlinkSync(join(root, "secrets", "gateway.token"), join(root, "bundle", "prompts", "link.md"));
    hop("prompts: { system: 'file:prompts/link.md' }\n");
    refused("prompts.system");
  });
  // Review round 2, item 4: each prompt field a HOP path is loaded for is confined at its own call site.
  for (const field of ["summarizer", "condenser", "verifierAgent"] as const) {
    test(`prompts.${field} is confined too`, () => {
      hop(`prompts: { ${field}: 'file:../secrets/gateway.token' }\n`);
      refused(`prompts.${field}`);
    });
  }
  test("a hop.yaml that is a symlink out of the bundle is refused before it is read (review round 2, item 3)", () => {
    writeFileSync(join(root, "secrets", "hop.yaml"), "spec: mlpal/hop-v1\nname: outside\nversion: 1.0.0\n");
    symlinkSync(join(root, "secrets", "hop.yaml"), join(root, "bundle", "hop.yaml"));
    expect(refused("hop.yaml").path).toBe(join(root, "bundle", "hop.yaml"));
  });
  test("a module prompt is confined too", () => {
    hop("modules:\n  m:\n    prompt: file:../secrets/gateway.token\n");
    refused("modules.m.prompt");
  });
  test("a path extends outside the bundle is refused; a builtin parent is fine", () => {
    mkdirSync(join(root, "other"), { recursive: true });
    writeFileSync(join(root, "other", "hop.yaml"), "spec: mlpal/hop-v1\nname: other\nversion: 1.0.0\n");
    hop("extends: ../other\n");
    refused("extends");
    hop("extends: coding\n");
    expect(load().name).toBe("confined");
  });
  test("a named (installed) parent is refused under confinement: the bundle must carry its chain", () => {
    mkdirSync(join(root, "hops", "infra"), { recursive: true });
    writeFileSync(join(root, "hops", "infra", "hop.yaml"), "spec: mlpal/hop-v1\nname: infra\nversion: 1.0.0\n");
    hop("extends: infra\n");
    refused("extends");
  });
  test("without confineTo the loader is unchanged", () => {
    hop(`prompts: { system: 'file:${join(root, "secrets", "gateway.token")}' }\n`);
    expect(loadProfile(join(root, "bundle"), { cwd: root, home: root }).prompts.system).toBe("test-secret-token");
  });
});
