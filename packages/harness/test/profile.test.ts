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
    expect(p.requires?.mcp.map((m) => m.name)).toEqual(["aws-mcp"]); // inherited
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
      const p = loadProfile(dir);
      expect(p.verification.agent.riskGate).toBe("actions");
      expect(p.memory).toEqual({ workspace: "infra" });
      expect(builtinProfiles().coding!.verification.agent.riskGate).toBe("changed-lines");
      expect(builtinProfiles().coding!.memory).toBeUndefined();
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
