import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BASE_FLOOR, BASE_PROFILE, BASE_SIDE_PROMPTS, BASE_TOOL_DESCRIPTIONS } from "../src/profile/builtins/base";
import { CODING_PROFILE } from "../src/profile/builtins/coding";
import { REVIEWER_PROFILE } from "../src/profile/builtins/reviewer";
import { describeProfile } from "../src/profile/describe";
import { builtinProfiles, loadProfile } from "../src/profile/load";
import { hopLintWarnings, PROMPT_SLOTS } from "../src/profile/origins";
import { SECTION_NAMES } from "../src/profile/types";
import { memoryPolicySection } from "../src/memory/derived";

/**
 * GOLDEN: the side-call prompts became HOP slots. Their `coding` values must be the exact strings
 * the calls used before (captured from engine 59a04c2 and yodex 01031dd into the fixture, not
 * retyped). If this fails, a slot changed coding's behaviour: fix the slot, not the fixture.
 */
describe("golden: coding's side prompts are the pre-slot strings", () => {
  const orig = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "side-prompts-59a04c2.json"), "utf8")) as Record<string, string>;
  const side = CODING_PROFILE.prompts.side;

  test("watcher, aside, suggest, AskModel system and context label", () => {
    expect(side.watcher).toBe(orig.watcher!);
    expect(side.aside).toBe(orig.aside!);
    expect(side.suggest).toBe(orig.suggest!);
    expect(side.askModel).toBe(orig.askModel!);
    expect(side.askModelContext).toBe(orig.askModelContext!);
  });

  test("coding leaves the host's own side calls (recap, handoff, disclose) unset: their text stays in the host", () => {
    expect(side.recap).toBeUndefined();
    expect(side.handoff).toBeUndefined();
    expect(side.disclose).toBeUndefined();
    expect(Object.keys(orig).sort()).toEqual(["aside", "askModel", "askModelContext", "suggest", "watcher"]);
  });

  test("coding and reviewer: no floor, every section on, every slot their own", () => {
    for (const p of [CODING_PROFILE, REVIEWER_PROFILE]) {
      expect(p.prompts.floor).toBe("");
      expect(p.sections).toEqual(Object.fromEntries(SECTION_NAMES.map((n) => [n, "on"])) as typeof p.sections); // unconditional, as before slots
      for (const s of PROMPT_SLOTS) expect(p.origins[`prompts.${s}`]).toBe(p.name);
      expect(p.tools.describe).toBeUndefined();
    }
    expect(REVIEWER_PROFILE.prompts.side).toBe(CODING_PROFILE.prompts.side);
  });
});

describe("the base builtin", () => {
  test("is discoverable and neutral: no identity, tools, memory, nudges or verification", () => {
    expect(Object.keys(builtinProfiles()).sort()).toEqual(["base", "coding", "reviewer"]);
    const b = loadProfile("base", { cwd: tmpdir(), home: tmpdir() });
    expect(b).toBe(BASE_PROFILE);
    expect(b.prompts.system).toBe("");
    expect(b.prompts.floor).toBe(BASE_FLOOR);
    expect(b.tools.include).toEqual([]);
    expect(b.memory).toBeUndefined();
    expect(b.requires).toBeUndefined();
    expect(b.safety).toBeUndefined();
    expect(b.verification.observe).toBe("builtin:none");
    expect(b.verification.selfCheck.enabled).toBe(false);
    expect(b.verification.antiChurn.enabled).toBe(false);
    expect(b.verification.agent.enabled).toBe(false);
    expect(b.loop.verifyCommandRe).toBeNull();
    expect(b.routing.subagents).toBe("inherit");
    expect(b.permissions.defaultMode).toBe("manual");
    expect(Object.values(b.sections)).toEqual(SECTION_NAMES.map(() => "auto"));
  });

  test("no base text speaks as a coding agent or to a developer", () => {
    const texts = [
      b().prompts.floor,
      b().prompts.verifierAgent,
      b().prompts.verifierTask("T", "D"),
      b().loop.summarizerSystem,
      b().loop.condenserSystem,
      b().loop.classifierSystem(3),
      b().loop.checkpointNudge!(5, "ws"),
      ...Object.values(BASE_SIDE_PROMPTS).map((v) => (typeof v === "function" ? v("x") : v)),
      ...Object.values(BASE_TOOL_DESCRIPTIONS),
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/coding|developer|yodex|repositor|\brepo\b|git diff|codebase/i);
      expect(t.length).toBeGreaterThan(0);
    }
  });

  const b = () => BASE_PROFILE;
});

describe("YAML HOPs on base", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hop-base-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const opts = () => ({ cwd: dir, home: join(dir, "home") });
  const hop = (rel: string, body: string[], files: Record<string, string> = {}) => {
    const pdir = join(dir, rel);
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, "hop.yaml"), ["spec: mlpal/hop-v1", ...body].join("\n") + "\n");
    for (const [n, c] of Object.entries(files)) writeFileSync(join(pdir, n), c);
    return pdir;
  };

  test("a child owns its system prompt, inherits the floor and base's neutral slots, and records where each came from", () => {
    const p = loadProfile(hop("h", ["name: helper", "version: 0.1.0", "extends: base", "prompts:", "  system: You are Helper."]), opts());
    expect(p.extendsChain).toEqual(["base"]);
    expect(p.prompts.system).toBe("You are Helper.");
    expect(p.prompts.floor).toBe(BASE_FLOOR);
    expect(p.prompts.side).toEqual(BASE_SIDE_PROMPTS);
    expect(p.loop.summarizerSystem).toBe(BASE_PROFILE.loop.summarizerSystem);
    expect(p.tools.include).toEqual([]);
    expect(p.tools.describe).toEqual(BASE_TOOL_DESCRIPTIONS);
    expect(p.origins["prompts.system"]).toBe("helper");
    expect(p.origins["prompts.floor"]).toBe("base");
    expect(p.origins["prompts.watcher"]).toBe("base");
    expect(p.origins["tools.describe.AskUserQuestion"]).toBe("base");
  });

  test("the builtin name resolves first: an installed HOP named base is shadowed, as coding's would be", () => {
    hop(".yodex/hops/base", ["name: base", "version: 9.9.9", "extends: coding"]);
    expect(loadProfile("base", opts())).toBe(BASE_PROFILE);
  });

  test("the floor is not a YAML key: no HOP can set or drop it", () => {
    const pdir = hop("h", ["name: helper", "version: 0.1.0", "extends: base", "prompts:", "  floor: ''"]);
    expect(() => loadProfile(pdir, opts())).toThrow(/floor/);
  });

  test("template slots render their placeholders; '' switches a note off", () => {
    const p = loadProfile(
      hop("h", [
        "name: t",
        "version: 0.1.0",
        "extends: base",
        "prompts:",
        "  classifier: 'rate 0..{top}'",
        "  selfCheck: '{edits} edits; check {verify_hint}'",
        "  antiChurn: '{path} x{edits}'",
        "  checkpoint: 'turn {turns} in {workspace}'",
        "  handoff: 'work in {cwd}'",
        "  disclose: 'today {today}'",
      ]),
      opts(),
    );
    expect(p.loop.classifierSystem(4)).toBe("rate 0..4");
    expect(p.loop.selfCheckNudge(3, "bun test")).toBe("3 edits; check bun test");
    expect(p.loop.selfCheckNudge(3)).toBe("3 edits; check ");
    expect(p.loop.antiChurnNudge("a.md", 7)).toBe("a.md x7");
    expect(p.loop.checkpointNudge!(9, "ws")).toBe("turn 9 in ws");
    expect(p.prompts.side.handoff!("/r")).toBe("work in /r");
    expect(p.prompts.side.disclose!("2026-01-02")).toBe("today 2026-01-02");

    const off = loadProfile(hop("off", ["name: off", "version: 0.1.0", "extends: coding", "prompts:", "  selfCheck: ''", "  antiChurn: ''", "  checkpoint: ''"]), opts());
    expect(off.loop.selfCheckNudge(5, "x")).toBe("");
    expect(off.loop.antiChurnNudge("a", 9)).toBe("");
    expect(off.loop.checkpointNudge).toBeUndefined();
    expect(CODING_PROFILE.loop.checkpointNudge).toBeDefined(); // coding itself untouched
  });

  test("an unknown placeholder is a load error naming the slot and its placeholders", () => {
    const pdir = hop("h", ["name: t", "version: 0.1.0", "extends: base", "prompts:", "  selfCheck: '{edits} then {file}'"]);
    expect(() => loadProfile(pdir, opts())).toThrow(/prompts\.selfCheck uses \{file\}; this slot's placeholders are \{edits\}, \{verify_hint\}/);
  });

  test("JSON in a template is not a placeholder", () => {
    const p = loadProfile(hop("h", ["name: t", "version: 0.1.0", "extends: base", "prompts:", `  classifier: 'Reply {"rung": <0..{top}>}'`]), opts());
    expect(p.loop.classifierSystem(2)).toBe('Reply {"rung": <0..2>}');
  });

  test("every side-call system is the HOP's own when it sets one", () => {
    const slots = ["watcher", "aside", "suggest", "askModel", "askModelContext", "recap"] as const;
    const p = loadProfile(hop("h", ["name: t", "version: 0.1.0", "extends: coding", "prompts:", ...slots.map((k) => `  ${k}: Own ${k}.`)]), opts());
    for (const k of slots) {
      expect(p.prompts.side[k]).toBe(`Own ${k}.`);
      expect(p.origins[`prompts.${k}`]).toBe("t");
    }
    expect(p.prompts.side.handoff).toBeUndefined(); // not set: coding's, which leaves it to the host
  });

  test("a side-call system may not be empty", () => {
    const pdir = hop("h", ["name: t", "version: 0.1.0", "extends: base", "prompts:", "  watcher: ''"]);
    expect(() => loadProfile(pdir, opts())).toThrow();
  });

  test("side prompts and templates resolve file: references inside the HOP", () => {
    const p = loadProfile(
      hop("h", ["name: t", "version: 0.1.0", "extends: base", "prompts:", "  watcher: file:watcher.md", "  checkpoint: file:cp.md"], {
        "watcher.md": "Watch it.\n",
        "cp.md": "cp {turns}\n",
      }),
      opts(),
    );
    expect(p.prompts.side.watcher).toBe("Watch it.");
    expect(p.loop.checkpointNudge!(4, "w")).toBe("cp 4");
  });

  test("sections merge per section down the chain; on/off/auto and booleans all work", () => {
    const mid = hop("mid", ["name: mid", "version: 0.1.0", "extends: base", "sections:", "  environment: off", "  gateway: false", "  skills: on"]);
    expect(mid).toBeTruthy();
    const leaf = loadProfile(hop("leaf", ["name: leaf", "version: 0.1.0", "extends: ../mid", "sections:", "  gateway: true", "  skills: auto"]), opts());
    expect(leaf.sections).toEqual({ capabilities: "auto", environment: "off", gateway: "on", verify: "auto", projectMemory: "auto", skills: "auto" });
    expect(leaf.origins["sections.environment"]).toBe("mid");
    expect(leaf.origins["sections.gateway"]).toBe("leaf");
    expect(leaf.origins["sections.skills"]).toBe("leaf");
    expect(leaf.origins["sections.capabilities"]).toBe("base");
  });

  test("an unknown section is a load error", () => {
    expect(() => loadProfile(hop("h", ["name: t", "version: 0.1.0", "extends: base", "sections:", "  weather: off"]), opts())).toThrow();
  });

  test("tools.describe merges per tool; SendMessage's description is engine-owned", () => {
    const p = loadProfile(
      hop("h", ["name: t", "version: 0.1.0", "extends: base", "tools:", "  include: [AskUserQuestion, Read]", "  describe:", "    Read: Read one of the person's files."]),
      opts(),
    );
    expect(p.tools.include).toEqual(["AskUserQuestion", "Read"]);
    expect(p.tools.describe).toEqual({ ...BASE_TOOL_DESCRIPTIONS, Read: "Read one of the person's files." });
    expect(p.origins["tools.describe.Read"]).toBe("t");
    const bad = hop("bad", ["name: bad", "version: 0.1.0", "extends: base", "tools:", "  describe:", "    SendMessage: anything"]);
    expect(() => loadProfile(bad, opts())).toThrow(/SendMessage/);
  });

  test("a coding child keeps coding's tools shape (no describe) unless it declares one", () => {
    const p = loadProfile(hop("h", ["name: t", "version: 0.1.0", "extends: coding"]), opts());
    expect(p.tools).toEqual({});
    expect(describeProfile(p).tools).toEqual({});
  });

  test("a lock on a note's switch binds its text too: \"\" would switch the locked note off", () => {
    hop("mid", ["name: mid", "version: 0.1.0", "extends: coding", "locked: [verification.selfCheck, verification.antiChurn.enabled]"]);
    for (const slot of ["selfCheck", "antiChurn"]) {
      const leaf = hop(`leaf-${slot}`, [`name: leaf-${slot.toLowerCase()}`, "version: 0.1.0", "extends: ../mid", "prompts:", `  ${slot}: ''`]);
      expect(() => loadProfile(leaf, opts())).toThrow(`profile "leaf-${slot.toLowerCase()}" overrides "prompts.${slot}", whose text can switch off "verification.${slot}.enabled", which is locked by its parent "mid"`);
    }
    // An unlocked note's text stays the child's to set.
    expect(loadProfile(hop("free", ["name: free", "version: 0.1.0", "extends: coding", "prompts:", "  selfCheck: ''"]), opts()).loop.selfCheckNudge(5)).toBe("");
  });

  test("a slot that reads \"\" as inherit is not credited to the child", () => {
    const p = loadProfile(hop("h", ["name: t", "version: 0.1.0", "extends: coding", "prompts:", "  system: ''", "  summarizer: ''"]), opts());
    expect(p.prompts.system).toBe(CODING_PROFILE.prompts.system);
    expect(p.origins["prompts.system"]).toBe("coding");
    expect(p.origins["prompts.summarizer"]).toBe("coding");
    expect(hopLintWarnings(p)).toEqual([]);
  });

  test("a parent's lock on a new slot binds its children", () => {
    hop("mid", ["name: mid", "version: 0.1.0", "extends: base", "prompts:", "  watcher: Mid watches.", "locked: [prompts.watcher]"]);
    const leaf = hop("leaf", ["name: leaf", "version: 0.1.0", "extends: ../mid", "prompts:", "  watcher: Leaf watches."]);
    expect(() => loadProfile(leaf, opts())).toThrow(/prompts\.watcher.*locked by its parent "mid"/);
  });

  test("memory.policy.record: [] opts a coding child out of the inherited policy (no policy section)", () => {
    const p = loadProfile(hop("h", ["name: t", "version: 0.1.0", "extends: coding", "memory:", "  policy:", "    record: []"]), opts());
    expect(p.memory?.policy?.record).toEqual([]);
    expect(memoryPolicySection(p.memory?.policy)).toBe("");
    expect(memoryPolicySection(CODING_PROFILE.memory?.policy)).not.toBe("");
  });

  test("lint: a coding child that replaced the system prompt is told what it still inherits", () => {
    const p = loadProfile(hop("h", ["name: builder", "version: 0.1.0", "extends: coding", "prompts:", "  system: You are Builder.", "  summarizer: Compress."]), opts());
    const [w, ...rest] = hopLintWarnings(p);
    expect(rest).toEqual([]);
    expect(w).toContain("builder replaces coding's system prompt");
    expect(w).toContain("prompts.selfCheck");
    expect(w).toContain("prompts.watcher");
    expect(w).not.toContain("prompts.summarizer"); // its own
    expect(w).not.toContain("prompts.floor"); // empty under coding: reported as "no engine floor"
    expect(w).toContain("coding's memory policy");
    expect(w).toContain("requires.mcp websearch");
    expect(w).toContain("no engine floor");
    // its own policy is not reported as coding's
    const own = loadProfile(hop("o", ["name: own", "version: 0.1.0", "extends: coding", "prompts:", "  system: S", "memory:", "  policy:", "    record: [refusal]"]), opts());
    expect(hopLintWarnings(own)[0]).not.toContain("memory policy");
  });

  test("lint: clean on base children that own their words; flags an empty system and a stray describe", () => {
    const clean = loadProfile(hop("c", ["name: c", "version: 0.1.0", "extends: base", "prompts:", "  system: You are C.", "tools:", "  include: [AskUserQuestion]"]), opts());
    expect(hopLintWarnings(clean)).toEqual([]);
    const empty = loadProfile(hop("e", ["name: e", "version: 0.1.0", "extends: base", "tools:", "  include: [Read]", "  describe:", "    Grep: g"]), opts());
    expect(hopLintWarnings(empty)).toEqual([
      "e has an empty prompts.system: the model gets only the engine floor and the host sections",
      "tools.describe names Grep, which tools.include leaves out",
    ]);
    expect(hopLintWarnings(CODING_PROFILE)).toEqual([]);
    expect(hopLintWarnings(BASE_PROFILE)).toEqual([]);
  });

  test("lint: a bundle with a base/ folder that extends the bare builtin name is told to write ./base", () => {
    hop("g/base", ["name: guide", "version: 0.1.0", "extends: base", "prompts:", "  system: Guide."]);
    const p = loadProfile(hop("g", ["name: pill", "version: 0.1.0", "extends: base", "prompts:", "  system: Pill."]), opts());
    expect(hopLintWarnings(p)).toContain("pill extends the builtin base, but its directory bundles a parent in base/: write extends: ./base for that one");
    hop("g2/base", ["name: guide2", "version: 0.1.0", "extends: base", "prompts:", "  system: Guide."]);
    const ok = loadProfile(hop("g2", ["name: pill2", "version: 0.1.0", "extends: ./base", "prompts:", "  system: Pill."]), opts());
    expect(ok.extendsChain).toEqual(["base", "guide2"]);
    expect(hopLintWarnings(ok)).toEqual([]);
  });

  test("describe_hop's wire shape is unchanged for coding", () => {
    const v = describeProfile(CODING_PROFILE);
    expect(Object.keys(v.prompts)).toEqual(["system", "verifierAgent"]);
    expect(v.tools).toEqual({});
  });
});
