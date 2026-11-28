import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { describeProfile } from "../src/profile/describe";
import { HopPathError, loadProfile } from "../src/profile/load";
import { scriptCommand } from "../src/profile/ui";

/** W3-1: hop.yaml's `ui` section (WAVE-3-HOP-SHAPED-HOME §2): what the loader accepts and what it refuses, loudly. */

let root: string;
let hop: string;

function writeHop(ui: string, extra = ""): void {
  writeFileSync(join(hop, "hop.yaml"), `spec: mlpal/hop-v1\nname: homey\nversion: 1.2.0\n${extra}${ui}`);
}
const load = () => loadProfile(hop, { cwd: root, home: join(root, "home") });
const refusal = (): string => {
  try {
    load();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("the HOP loaded");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hop-ui-"));
  hop = join(root, "hop");
  mkdirSync(join(hop, "ui", "home"), { recursive: true });
  for (const n of ["spend.py", "agents.py", "sites.sh", "hops.py", "five.py"]) writeFileSync(join(hop, "ui", "home", n), "print('{}')\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const FOUR = `ui:
  starters: [Publish my HOP, What did my agents do today?]
  home:
    blocks:
      - { id: spend, title: "Gateway spend, last 7 days", script: ui/home/spend.py, refresh: 30m }
      - { id: agents, title: Your agents, script: ui/home/agents.py }
      - { id: sites, title: Your sites, script: ui/home/sites.sh, refresh: 1h }
      - { id: hops, title: Your published HOPs, script: ui/home/hops.py }
`;

describe("hop.yaml ui: accepted", () => {
  test("inline: starters, four blocks, refresh defaulting to 15m, script paths resolved inside the HOP", () => {
    writeHop(FOUR);
    const p = load();
    expect(p.ui?.starters).toEqual(["Publish my HOP", "What did my agents do today?"]);
    expect(p.ui?.home?.blocks.map((b) => [b.id, b.refresh, b.refreshMs])).toEqual([
      ["spend", "30m", 1_800_000],
      ["agents", "15m", 900_000],
      ["sites", "1h", 3_600_000],
      ["hops", "15m", 900_000],
    ]);
    expect(p.ui?.home?.blocks[0]!.scriptPath).toBe(join(hop, "ui", "home", "spend.py"));
  });

  test("describe_hop carries ui as declared (relative scripts), and a HOP without ui has none", () => {
    writeHop(FOUR);
    expect(describeProfile(load()).ui).toEqual({
      starters: ["Publish my HOP", "What did my agents do today?"],
      home: {
        blocks: [
          { id: "spend", title: "Gateway spend, last 7 days", script: "ui/home/spend.py", refresh: "30m" },
          { id: "agents", title: "Your agents", script: "ui/home/agents.py", refresh: "15m" },
          { id: "sites", title: "Your sites", script: "ui/home/sites.sh", refresh: "1h" },
          { id: "hops", title: "Your published HOPs", script: "ui/home/hops.py", refresh: "15m" },
        ],
      },
    });
    writeHop("");
    expect(load().ui).toBeUndefined();
    expect("ui" in describeProfile(load())).toBe(false);
  });

  test("ui: file:ui.yaml, whose scripts are relative to the HOP's directory", () => {
    mkdirSync(join(hop, "conf"));
    writeFileSync(join(hop, "conf", "ui.yaml"), "starters: [Hi there]\nhome:\n  blocks:\n    - { id: spend, title: Spend, script: ui/home/spend.py }\n");
    writeHop("ui: file:conf/ui.yaml\n");
    const p = load();
    expect(p.ui?.starters).toEqual(["Hi there"]);
    expect(p.ui?.home?.blocks[0]!.scriptPath).toBe(join(hop, "ui", "home", "spend.py"));
  });

  test("W3-1 round 2: a headline and each block's declared kind, loaded and carried by describe_hop", () => {
    writeHop(`ui:
  home:
    headline: Your agents, sites and published HOPs on MLPal
    blocks:
      - { id: hops, title: Your published HOPs, script: ui/home/hops.py, kind: kpis }
      - { id: spend, title: Spend, script: ui/home/spend.py, kind: chart }
      - { id: agents, title: Agents, script: ui/home/agents.py, kind: grid }
      - { id: sites, title: Sites, script: ui/home/sites.sh }
`);
    const p = load();
    expect(p.ui?.home?.headline).toBe("Your agents, sites and published HOPs on MLPal");
    expect(p.ui?.home?.blocks.map((b) => b.kind ?? null)).toEqual(["kpis", "chart", "grid", null]);
    expect(describeProfile(p).ui?.home).toEqual({
      headline: "Your agents, sites and published HOPs on MLPal",
      blocks: [
        { id: "hops", title: "Your published HOPs", script: "ui/home/hops.py", refresh: "15m", kind: "kpis" },
        { id: "spend", title: "Spend", script: "ui/home/spend.py", refresh: "15m", kind: "chart" },
        { id: "agents", title: "Agents", script: "ui/home/agents.py", refresh: "15m", kind: "grid" },
        { id: "sites", title: "Sites", script: "ui/home/sites.sh", refresh: "15m" },
      ],
    });
    // neither set: unchanged
    writeHop(FOUR);
    expect(load().ui?.home && "headline" in load().ui!.home!).toBe(false);
    expect(load().ui?.home?.blocks.every((b) => !("kind" in b))).toBe(true);
  });

  test("the display titles' own rule, shared: a zero-width joiner (emoji need it) and a soft hyphen pass, as in a display title", () => {
    writeHop(`ui:\n  starters: ["Ask my \\U0001F469\\u200D\\U0001F4BB agent", "re\\u00ADport"]\n  home:\n    headline: "Your work\\u200D, at a glance"\n    blocks:\n      - { id: a, title: "Spend\\u00AD", script: ui/home/spend.py }\n`);
    expect(load().ui?.starters).toEqual(["Ask my \u{1F469}\u200D\u{1F4BB} agent", "re\u00ADport"]);
  });

  test("starters alone, no home", () => {
    writeHop("ui:\n  starters: [One, Two]\n");
    expect(load().ui).toEqual({ starters: ["One", "Two"] });
  });

  test("an executable without .py or .sh runs itself", () => {
    writeFileSync(join(hop, "ui", "home", "bin"), "#!/bin/sh\necho '{}'\n");
    chmodSync(join(hop, "ui", "home", "bin"), 0o755);
    writeHop("ui:\n  home:\n    blocks:\n      - { id: b, title: B, script: ui/home/bin }\n");
    expect(load().ui?.home?.blocks[0]!.id).toBe("b");
  });

  test("a child HOP does not inherit its parent's ui", () => {
    writeHop(FOUR);
    const child = join(root, "child");
    mkdirSync(child);
    writeFileSync(join(child, "hop.yaml"), `spec: mlpal/hop-v1\nname: child\nversion: 1.0.0\nextends: ../hop\n`);
    expect(loadProfile(child, { cwd: root, home: join(root, "home") }).ui).toBeUndefined();
  });

  test("scriptCommand: python3 for .py, bash for .sh, the file itself otherwise, each path quoted", () => {
    expect(scriptCommand("/h/ui/a.py")).toBe("python3 '/h/ui/a.py'");
    expect(scriptCommand("/h/ui/a.sh")).toBe("/bin/bash '/h/ui/a.sh'");
    expect(scriptCommand("/h/it's/bin")).toBe(`'/h/it'\\''s/bin'`);
  });
});

describe("hop.yaml ui: refused with a load error naming the field", () => {
  const block = (b: string) => `ui:\n  home:\n    blocks:\n      - ${b}\n`;
  const cases: Array<[string, string, RegExp]> = [
    ["five starters", "ui:\n  starters: [a, b, c, d, e]\n", /at ui\.starters: at most 4 starters/],
    ["a starter over 60 characters", `ui:\n  starters: ["${"x".repeat(61)}"]\n`, /at ui\.starters\.0: a starter is at most 60 characters/],
    ["an empty starter", `ui:\n  starters: ["  "]\n`, /a starter is empty/],
    ["a starter with a control character", `ui:\n  starters: ["a\\u001b[31mb"]\n`, /a starter has a control or invisible character/],
    ["a starter twice", "ui:\n  starters: [a, a]\n", /a starter is listed twice/],
    ["no blocks", "ui:\n  home:\n    blocks: []\n", /a home has at least one block/],
    ["five blocks", `ui:\n  home:\n    blocks:\n${["spend", "agents", "hops", "five", "six"].map((id) => `      - { id: ${id}, title: T, script: ui/home/spend.py }\n`).join("")}`, /a home has at most 4 blocks/],
    ["an id used twice", `ui:\n  home:\n    blocks:\n      - { id: a, title: T, script: ui/home/spend.py }\n      - { id: a, title: U, script: ui/home/hops.py }\n`, /a home block id is used twice/],
    ["a bad id", block("{ id: Spend_1, title: T, script: ui/home/spend.py }"), /at ui\.home\.blocks\.0\.id: a home block id is lowercase/],
    ["a title over 120 characters", block(`{ id: a, title: "${"t".repeat(121)}", script: ui/home/spend.py }`), /a home block title is at most 120 characters/],
    ["a starter with a right-to-left override", `ui:\n  starters: ["Pay \\u202Eexe.txt"]\n`, /at ui\.starters\.0: a starter has a control or invisible character \(a bidi override/],
    ["a headline with a zero-width space", `ui:\n  home:\n    headline: "pay\\u200Bpal"\n    blocks:\n      - { id: a, title: T, script: ui/home/spend.py }\n`, /at ui\.home\.headline: a home headline has a control or invisible character/],
    ["a block title with a left-to-right isolate", block('{ id: a, title: "Spend \\u2066x", script: ui/home/spend.py }'), /at ui\.home\.blocks\.0\.title: a home block title has a control or invisible character/],
    ["a starter with a line break", `ui:\n  starters: ["one\\ntwo"]\n`, /a starter has a control or invisible character/],
    ["a headline over 120 characters", `ui:\n  home:\n    headline: "${"h".repeat(121)}"\n    blocks:\n      - { id: a, title: T, script: ui/home/spend.py }\n`, /at ui\.home\.headline: a home headline is at most 120 characters/],
    ["a headline with a control character", `ui:\n  home:\n    headline: "a\\u0007b"\n    blocks:\n      - { id: a, title: T, script: ui/home/spend.py }\n`, /a home headline has a control or invisible character/],
    ["an empty headline", `ui:\n  home:\n    headline: " "\n    blocks:\n      - { id: a, title: T, script: ui/home/spend.py }\n`, /a home headline is empty/],
    ["a kind no home block may be", block("{ id: a, title: T, script: ui/home/spend.py, kind: image }"), /at ui\.home\.blocks\.0\.kind: kind is one of chart, kpis, grid/],
    ["refresh under 5m", block("{ id: a, title: T, script: ui/home/spend.py, refresh: 4m }"), /refresh is <n>m or <n>h, from 5m to 24h/],
    ["refresh in seconds", block("{ id: a, title: T, script: ui/home/spend.py, refresh: 600s }"), /refresh is <n>m or <n>h/],
    ["refresh over a day", block("{ id: a, title: T, script: ui/home/spend.py, refresh: 25h }"), /from 5m to 24h/],
    ["an unknown key in a block", block("{ id: a, title: T, script: ui/home/spend.py, args: [x] }"), /at ui\.home\.blocks\.0: Unrecognized key\(s\) in object: 'args'/],
    ["an unknown key in ui", "ui:\n  name: Supply\n", /at ui: Unrecognized key\(s\) in object: 'name'/],
    ["a string that is not file:", "ui: home.yaml\n", /ui is the section itself or file:<relpath>/],
    ["an absolute script", block("{ id: a, title: T, script: /usr/bin/true }"), /ui\.home\.blocks\[0\]\.script is \/usr\/bin\/true: a script is a path relative/],
    ["a script outside the HOP", block("{ id: a, title: T, script: ../elsewhere.py }"), /ui\.home\.blocks\[0\]\.script references \.\.\/elsewhere\.py, outside the HOP's directory/],
    ["a missing script", block("{ id: a, title: T, script: ui/home/gone.py }"), /references ui\/home\/gone\.py but .* is not a file/],
    ["a directory as script", block("{ id: a, title: T, script: ui/home }"), /is not a file/],
    ["a file that is neither .py, .sh nor executable", block("{ id: a, title: T, script: ui/home/data.json }"), /neither a \.py or \.sh file nor executable/],
  ];
  for (const [name, ui, want] of cases) {
    test(name, () => {
      writeFileSync(join(hop, "ui", "home", "data.json"), "{}");
      writeFileSync(join(root, "elsewhere.py"), "print(1)");
      writeHop(ui);
      expect(refusal()).toMatch(want);
    });
  }

  test("a script linked to a file outside the HOP", () => {
    writeFileSync(join(root, "outside.py"), "print(1)");
    symlinkSync(join(root, "outside.py"), join(hop, "ui", "home", "link.py"));
    writeHop(block("{ id: a, title: T, script: ui/home/link.py }"));
    expect(refusal()).toMatch(/references ui\/home\/link\.py, outside the HOP's directory/);
  });

  test("ui: file: outside the HOP, missing, invalid YAML, or an invalid section", () => {
    writeFileSync(join(root, "ui.yaml"), "starters: [a]\n");
    writeHop("ui: file:../ui.yaml\n");
    expect(refusal()).toMatch(/profile ui references file:\.\.\/ui\.yaml, outside the HOP's directory/);
    writeHop("ui: file:none.yaml\n");
    expect(refusal()).toMatch(/profile ui references file:none\.yaml but .* does not exist/);
    writeFileSync(join(hop, "ui.yaml"), "starters: [a\n");
    writeHop("ui: file:ui.yaml\n");
    expect(refusal()).toMatch(/ui\.yaml is not valid YAML/);
    writeFileSync(join(hop, "ui.yaml"), "starters: [a, b, c, d, e]\n");
    expect(refusal()).toMatch(/ui\.yaml is not a valid profile at ui\.starters: at most 4 starters/);
  });

  test("under confinement (an assigned bundle), a ui file outside the bundle is a HopPathError", () => {
    writeFileSync(join(root, "ui.yaml"), "starters: [a]\n");
    writeHop("ui: file:../ui.yaml\n");
    expect(() => loadProfile(hop, { cwd: root, home: join(root, "home"), confineTo: hop })).toThrow(HopPathError);
  });
});
