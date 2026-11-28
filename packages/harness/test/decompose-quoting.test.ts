import { describe, expect, test } from "bun:test";
import { createPolicy } from "../src/permission/engine";
import { classifyAction } from "../src/permission/safety-envelope";
import type { SafetyPolicy } from "../src/profile/types";
import { decomposeBash, refusesAutoApproval, shellWords, UNKNOWN } from "../src/permission/shell-decompose";

/**
 * The decomposer reads a command line as bash will run it. Quoting that changes a word without running anything is
 * decoded exactly ($'…' escapes, $"…", adjacent pieces, backslashes, line continuations). A word whose value is
 * known only at run time either makes the line opaque (as the command name, or eval, a shell reading stdin, a shell
 * with a non-literal script) or lets an anchored gating entry or deny name the command if any value would match.
 * The hole this closes: `mlpal mcp $'delete' srv` was read as `mlpal mcp $delete srv`, classed mutative, and ran
 * without the approval card.
 */
const SAFETY: SafetyPolicy = {
  toolClasses: { readOnly: [], mutative: ["Bash(*)"], consequential: [], destructive: ["Bash(mlpal mcp delete*)", "Bash(mlpal mcp create*)", "Bash(mlpal mcp deploy*)"] },
  preApply: { requirePlanArtifact: false, hash: [] },
  blastRadius: {},
  approval: { destructive: "always", outOfScope: "always" },
  identities: { neverSelfGrant: true },
};
const cls = (command: string) => classifyAction(SAFETY, { toolName: "Bash", command, tags: {} });

/** Spellings bash runs as `mlpal mcp delete srv`, decoded to it. */
const DECODED = [
  "mlpal mcp $'delete' srv",
  "mlpal mcp $'create' srv",
  "mlpal mcp $'deploy' srv",
  "mlpal mcp $'de\\x6cete' srv",
  "mlpal mcp $'\\144elete' srv",
  "mlpal mcp $'del'ete srv",
  'mlpal mcp $"delete" srv',
  'mlpal mcp de"le"te srv',
  "mlpal mcp 'del'ete srv",
  "mlpal mcp del\\ete srv",
  "mlpal mcp \\\ndelete srv",
  "mlpal mcp del\\\nete srv",
  'mlpal mcp "del\\\nete" srv',
];
/** A run-time value in the verb: the anchored entry names it, since some value would match. */
const RUN_TIME = ["mlpal mcp $(echo delete) srv", "mlpal mcp `echo delete` srv", "mlpal mcp $V srv", 'mlpal mcp "$V" srv', "mlpal mcp ${V} srv", "mlpal mcp $((1)) srv", "mlpal mcp d* srv", "mlpal mcp {delete,x} srv", "mlpal mcp $'\\u0064elete' srv", "mlpal mcp $'\\x64\\xe9' srv", "V=delete; mlpal mcp $V srv"];
/** The same as the command, or a program the matcher cannot read: opaque. */
const OPAQUE = ["$'mlpal' mcp delete srv", '$"mlpal" mcp delete srv', "$(echo mlpal) mcp delete srv", "$M mcp delete srv", "ml* mcp delete srv", "{mlpal,x} mcp delete srv", 'eval "mlpal mcp delete srv"', 'bash <<< "mlpal mcp delete srv"', "echo mlpal mcp delete srv | bash", 'bash -c "$CMD"', "sh -c $'mlpal mcp delete srv'", "mlpal mcp $'del\\'ete' srv"];

describe("the hole: a gating entry sees what bash runs", () => {
  for (const line of DECODED) test(`decoded, destructive: ${JSON.stringify(line)}`, () => expect(cls(line)).toBe("destructive"));
  for (const line of RUN_TIME) test(`run-time verb, destructive: ${JSON.stringify(line)}`, () => expect(cls(line)).toBe("destructive"));
  for (const line of OPAQUE) {
    test(`opaque, destructive: ${JSON.stringify(line)}`, () => {
      expect(decomposeBash(line).opaque).not.toBeNull();
      expect(cls(line)).toBe("destructive");
    });
  }
  test("a plain verb the entries do not name stays mutative, however it is quoted", () => {
    for (const line of ["mlpal mcp list srv", "mlpal mcp $'list' srv", 'mlpal mcp "li"st srv', "mlpal mcp $'\\x6cist' srv"]) expect([line, cls(line)]).toEqual([line, "mutative"]);
  });
  test("a deny rule anchored at the command fires for the decoded or run-time verb; one that starts with * keeps the exact reading", async () => {
    const policy = createPolicy({ mode: "autopilot", deny: ["Bash(mlpal mcp delete*)", "Bash(*.mlpal/credentials*)"] });
    const decide = async (command: string) => (await policy({ toolName: "Bash", input: { command } } as never)).behavior;
    for (const line of ["mlpal mcp $'delete' srv", "mlpal mcp $V srv", "mlpal mcp de\"le\"te srv"]) expect([line, await decide(line)]).toEqual([line, "deny"]);
    for (const line of ["ls *.py", "echo $HOME", "cat ~/notes.txt"]) expect([line, await decide(line)]).toEqual([line, "allow"]);
  });
});

describe("the allow side never auto-approves ANSI-C or locale quoting", () => {
  test("refusesAutoApproval, and an allow that would match the decoded words asks", async () => {
    const allowed = async (command: string) => (await createPolicy({ mode: "manual", allow: ["Bash(git*)"] })({ toolName: "Bash", input: { command } } as never)).behavior;
    for (const line of ["git $'log'", 'git $"status"', "git log $'--oneline'"]) {
      expect(refusesAutoApproval(decomposeBash(line))).toBe(true);
      expect([line, await allowed(line)]).toEqual([line, "ask"]);
    }
    expect(await allowed("git log --oneline")).toBe("allow");
  });
});

// ─── the differential test against real bash ───

/** A seeded generator (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One word of quoting pieces that change nothing at run time but how bash reads them; never an expansion, a glob or
 *  an operator, so the line `printf '%s\0' …` runs printf and nothing else. */
function pieces(r: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const plain = () => pick(["a", "de", "lete", "x1", "-n", "--yes", ".", "_", "q", "Z9"]);
  const ansi = () => pick(["\\n", "\\t", "\\x41", "\\x4", "\\x4g", "\\101", "\\0101", "\\7", "\\cA", "\\cz", "\\e", "\\E", "\\a", "\\v", "\\f", "\\r", "\\b", "\\\\", '\\"', "\\?", "\\q", "\\8", "\\x", "\\0", "a\\0b", "\\u0041", "\\c?", "\\xe9", "\\'", "\\c", "lit", " sp "]);
  const dq = () => pick(["a", " b ", "\\\"", "\\\\", "\\$", "\\`", "\\q", "\\n", "\\\n", "x\\y", "'s'"]);
  const one = (): string => {
    switch (Math.floor(r() * 9)) {
      case 0:
        return plain();
      case 1:
        return `'${pick(["del", "a b", "\\x", '"q"', "$X", "`t`", "*"])}'`;
      case 2:
        return `"${Array.from({ length: 1 + Math.floor(r() * 3) }, dq).join("")}"`;
      case 3:
        return `$'${Array.from({ length: 1 + Math.floor(r() * 3) }, ansi).join("")}'`;
      case 4:
        return `$"${pick(["del", "a b", "\\$x", "\\\\"])}"`;
      case 5:
        return `\\${pick(["a", " ", "q", "\\", "'", '"', "$", "*", ";", "|"])}`;
      case 6:
        return "\\\n";
      default:
        return plain();
    }
  };
  let w = "";
  for (let n = 1 + Math.floor(r() * 4); n > 0; n--) w += one();
  return w;
}

function bashWords(line: string): string[] | "error" {
  const p = Bun.spawnSync(["/bin/bash", "--norc", "--noprofile", "-c", line], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) return "error";
  const out = Buffer.from(p.stdout).toString("latin1");
  return out.split("\0").slice(1, -1);
}

describe("differential: the decomposer's words are bash's, or the line is opaque", () => {
  test("a seeded sample of 400 lines of quoting forms, run as `printf '%s\\0' @ …` by /bin/bash", () => {
    const r = rng(20261128);
    let equal = 0;
    let opaque = 0;
    let unknown = 0;
    const mismatches: string[] = [];
    for (let n = 0; n < 400; n++) {
      const words = Array.from({ length: 1 + Math.floor(r() * 3) }, () => pieces(r));
      // a first argument of our own: printf with no argument would still print its format once
      const line = `printf '%s\\0' @ ${words.join(" ")}`;
      const ours = shellWords(line);
      if (ours === null) {
        opaque++;
        continue;
      }
      expect(ours.length).toBe(1);
      const args = ours[0]!.slice(3);
      if (args.includes(UNKNOWN)) {
        unknown++;
        continue;
      }
      const theirs = bashWords(line);
      if (theirs === "error" || JSON.stringify(theirs) !== JSON.stringify(args)) mismatches.push(`${JSON.stringify(line)}: bash ${JSON.stringify(theirs)}, ours ${JSON.stringify(args)}`);
      else equal++;
    }
    console.log(`differential: ${equal} equal, ${unknown} with a run-time part (UNKNOWN), ${opaque} opaque, ${mismatches.length} mismatched`);
    expect(mismatches.slice(0, 10)).toEqual([]);
    expect(equal).toBeGreaterThan(250);
  }, 60_000);
});
