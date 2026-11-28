import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSandbox, DEFAULT_UNREADABLE, resolveSandboxSpec } from "../src/sandbox";
import { editTool, readTool, writeTool } from "../src/tools/builtin/files";
import { globTool, grepTool, listTool } from "../src/tools/builtin/search";
import { runTool, ToolRegistry } from "../src/tools/registry";

/**
 * R51: what cannot see the person's stored header secrets (`~/.yodex/person-secrets.json`) and MCP sign-ins
 * (`~/.yodex/mcp-auth/`). In a workspace the engine's roots are the workspace directory, beside the home, never the
 * home itself: every model file tool resolves a path through symlinks and refuses one outside the roots. A sandboxed
 * command meets the same files on the engine's unreadable list. Each test would fail if the file could be read.
 */

const MARK = "R51-MARKED-SECRET-7f3a9c";
let base: string;
let home: string;
let work: string;

beforeEach(() => {
  // A home path with no link in it, as a real home is (macOS's tmpdir is under the /var -> /private/var link).
  base = realpathSync(mkdtempSync(join(tmpdir(), "r51-")));
  home = join(base, "home");
  work = join(home, "workspace");
  mkdirSync(join(home, ".yodex", "mcp-auth"), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(home, ".yodex", "person-secrets.json"), JSON.stringify({ version: 1, secrets: { K: { value: MARK } } }), { mode: 0o600 });
  writeFileSync(join(home, ".yodex", "mcp-auth", "linear.json"), JSON.stringify({ tokens: { access_token: MARK } }), { mode: 0o600 });
  writeFileSync(join(work, "notes.md"), "ordinary file\n");
  symlinkSync(join(home, ".yodex", "person-secrets.json"), join(work, "secrets-link.json"));
  symlinkSync(join(home, ".yodex"), join(work, "yodex-link"));
  symlinkSync(join(home, ".yodex", "mcp-auth"), join(work, "auth-link"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of [readTool, writeTool, editTool, globTool, grepTool, listTool]) reg.register(t as never);
  return reg;
}
const ctx = () => ({ cwd: work, roots: [work] });
const text = (r: { content: unknown }) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content));

describe("R51: the model's file tools cannot reach the stored secrets", () => {
  const targets = () => [
    join(home, ".yodex", "person-secrets.json"),
    "~/.yodex/person-secrets.json",
    "../.yodex/person-secrets.json",
    "secrets-link.json",
    "yodex-link/person-secrets.json",
    join(home, ".yodex", "mcp-auth", "linear.json"),
    "../.yodex/mcp-auth/linear.json",
    "auth-link/linear.json",
  ];

  test("Read refuses every way of naming them: absolute, ~, relative and through a symlink in the workspace", async () => {
    const reg = registry();
    for (const path of targets()) {
      const r = await runTool(reg, "Read", { path }, ctx());
      expect(text(r)).not.toContain(MARK);
      expect(r.isError).toBe(true);
    }
  });

  test("Edit and Write cannot overwrite or read them back", async () => {
    const reg = registry();
    for (const path of targets()) {
      const e = await runTool(reg, "Edit", { path, old_string: MARK, new_string: "x" }, ctx());
      expect(e.isError).toBe(true);
      expect(text(e)).not.toContain(MARK);
      const w = await runTool(reg, "Write", { path, content: "overwritten" }, ctx());
      expect(w.isError).toBe(true);
    }
    expect(readFileSync(join(home, ".yodex", "person-secrets.json"), "utf8")).toContain(MARK);
    expect(readFileSync(join(home, ".yodex", "mcp-auth", "linear.json"), "utf8")).toContain(MARK);
  });

  test("Grep over the workspace (links included), Glob and List never return a stored value", async () => {
    const reg = registry();
    for (const input of [{ pattern: MARK }, { pattern: MARK, path: "yodex-link" }, { pattern: MARK, path: "auth-link" }, { pattern: MARK, path: "secrets-link.json" }, { pattern: MARK, path: join(home, ".yodex") }]) {
      expect(text(await runTool(reg, "Grep", input, ctx()))).not.toContain(MARK);
    }
    for (const input of [{ pattern: "**/*.json" }, { pattern: "**/*", path: "yodex-link" }, { pattern: "*", path: join(home, ".yodex") }]) {
      const out = text(await runTool(reg, "Glob", input, ctx()));
      expect(out).not.toContain(MARK);
      expect(out).not.toContain("linear.json");
    }
    const listed = await runTool(reg, "List", { path: "yodex-link" }, ctx());
    expect(listed.isError).toBe(true);
    expect(text(listed)).not.toContain("person-secrets.json");
    expect(text(await runTool(reg, "List", {}, ctx()))).toContain("notes.md");
    // The ordinary file is still found: the filter takes out only what resolves outside.
    expect(text(await runTool(reg, "Grep", { pattern: "ordinary" }, ctx()))).toContain("notes.md:1:ordinary file");
  });
});

describe("R51: a sandboxed command cannot read them", () => {
  test("both are on the engine's unreadable list, resolved under the home", () => {
    expect(DEFAULT_UNREADABLE).toContain("~/.yodex/person-secrets.json");
    expect(DEFAULT_UNREADABLE).toContain("~/.yodex/mcp-auth");
    const spec = resolveSandboxSpec(undefined, { roots: [work], home, realHome: home, tmpDir: join(base, "tmp") } as never);
    expect(spec.filesystem.unreadable).toContain(join(home, ".yodex", "person-secrets.json"));
    expect(spec.filesystem.unreadable).toContain(join(home, ".yodex", "mcp-auth"));
  });
});

describe.skipIf(process.platform !== "darwin")("R51: under the real sandbox (seatbelt) a command reads neither", () => {
  test("cat, grep -r and a copy through links all fail; an ordinary file still reads", () => {
    const sandbox = createSandbox(resolveSandboxSpec(undefined, { roots: [work], home, realHome: home }));
    const run = (command: string) => {
      const p = Bun.spawnSync(sandbox.wrap(["/bin/bash", "-c", command]), { cwd: work, env: { PATH: "/usr/bin:/bin", HOME: home } });
      return `${p.stdout.toString()}${p.stderr.toString()}`;
    };
    try {
      for (const command of [
        `cat ${join(home, ".yodex", "person-secrets.json")}`,
        "cat ~/.yodex/person-secrets.json",
        "cat ../.yodex/person-secrets.json",
        "cat secrets-link.json",
        "cat yodex-link/person-secrets.json",
        "cat auth-link/linear.json ~/.yodex/mcp-auth/linear.json",
        "grep -r R51 . ~/.yodex 2>&1",
        "cp secrets-link.json copy.json && cat copy.json",
      ]) {
        expect(run(command)).not.toContain(MARK);
      }
      expect(run("cat notes.md")).toContain("ordinary file");
    } finally {
      sandbox.close();
    }
  });
});

describe("REVIEW-1 RQ-7: every tool that opens a file by path keeps to the roots (Skill, Lsp)", () => {
  test("SIB-1: a skill's bundled file, or its SKILL.md, that links to the store is refused / not loaded", async () => {
    const { createSkillTool, loadSkills } = await import("../src/skills/skills");
    const skills = join(work, ".yodex", "skills");
    mkdirSync(join(skills, "helper"), { recursive: true });
    writeFileSync(join(skills, "helper", "SKILL.md"), "---\nname: helper\ndescription: d\n---\nbody\n");
    symlinkSync(join(home, ".yodex", "person-secrets.json"), join(skills, "helper", "ref.md"));
    mkdirSync(join(skills, "linked"), { recursive: true });
    symlinkSync(join(home, ".yodex", "person-secrets.json"), join(skills, "linked", "SKILL.md"));
    symlinkSync(join(home, ".yodex", "person-secrets.json"), join(skills, "flat.md"));
    const loaded = await loadSkills([skills]);
    expect(loaded.map((s) => s.name).sort()).toEqual(expect.arrayContaining(["helper"]));
    expect(JSON.stringify(loaded)).not.toContain(MARK);
    const tool = createSkillTool(loaded);
    const r = await tool.call({ name: "helper", file: "ref.md" }, ctx() as never);
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain(MARK);
    writeFileSync(join(skills, "helper", "plain.md"), "inside\n");
    expect(text(await tool.call({ name: "helper", file: "plain.md" }, ctx() as never))).toContain("inside");
  });

  test("SIB-2: an Lsp location outside the roots shows its path, never its line", async () => {
    const { renderLocations } = await import("../src/tools/builtin/lsp");
    const outside = { uri: `file://${join(home, ".yodex", "person-secrets.json")}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    const inside = { uri: `file://${join(work, "notes.md")}`, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } };
    const out = renderLocations([outside, inside] as never, work, [work]);
    expect(out).not.toContain(MARK);
    expect(out).toContain("ordinary file");
  });
});

describe("REVIEW-1 RQ-6(a): a command naming the stored keys or sign-ins is refused in every mode", () => {
  test("the bypass-immune deny holds in cruise and autopilot, by path, ~, and after a cd", async () => {
    const { createPolicy } = await import("../src/permission/engine");
    for (const mode of ["cruise", "autopilot", "manual"] as const) {
      const policy = createPolicy({ mode, allow: ["Bash"] });
      for (const command of ["cat ~/.yodex/person-secrets.json", `cat ${home}/.yodex/person-secrets.json`, "cd ~/.yodex && cat person-secrets.json", "ls ~/.yodex/mcp-auth", "cd ~/.yodex; cat mcp-auth/linear.json", "cp $HOME/.yodex/person-secrets.json /tmp/x"]) {
        const d = await policy({ toolName: "Bash", input: { command }, readOnly: true } as never);
        expect([mode, command, d.behavior]).toEqual([mode, command, "deny"]);
      }
      expect((await policy({ toolName: "Bash", input: { command: "cat notes.md" }, readOnly: true } as never)).behavior).toBe("allow");
    }
  });
});

describe("REVIEW-2 RQ-6: the home's .yodex is not for commands, in any spelling; masking covers encodings and notices", () => {
  test("REVIEW-3: commands naming a secret file are denied in every mode; ones that could reach it otherwise are asked", async () => {
    const { createPolicy } = await import("../src/permission/engine");
    const denied = [
      "cat ~/.yodex/person-secrets.json",
      "xxd ~/.yodex/plugin-hooks.json",
      'cat "$HOME/.yodex/trust.json"',
      "cat ~/.yodex/credentials.json",
      "jq . ~/.yodex/variable-grants.json",
      "cat ${HOME}/.yodex/hooks-trust.json",
      "ls ~/.yodex/mcp-auth",
      "cd ~/.yodex && cat person-secrets.json",
    ];
    const asked = [
      "cat ~/.yod*/person-secret?.json",
      "cat ~/.y*/p*",
      "cat ~mlpaluser/.yodex/x.json",
      "cat ../.././.yodex/person-secret?.json",
      "xxd ~/.yodex/person-secret?.json",
      "od -c ~/.yodex/pers*",
      "cat ~/.yodex/*.json",
      "cat $HOME/.y?dex/a",
      "cat ~/.mlpal/*",
      "cat ~/.{yodex,mlpal}/x",
      "cat /home/mlpaluser/.yodex/[pt]*.json",
      "grep -r value ~",
      "grep -rn key $HOME",
      "rg sk- ~/",
      "find / -name '*.json'",
      "find ~ -type f",
      "tar -cf - ~ | base64",
      "cp -r ~ /tmp/x",
      "zip -r out.zip /home/mlpaluser",
      "rsync -a ~/ /tmp/y",
      "du -a ~",
      "ls -R ~",
    ];
    for (const mode of ["cruise", "autopilot", "manual"] as const) {
      const policy = createPolicy({ mode, allow: ["Bash"] });
      for (const command of denied) expect([mode, command, (await policy({ toolName: "Bash", input: { command }, readOnly: true } as never)).behavior]).toEqual([mode, command, "deny"]);
      for (const command of asked) expect([mode, command, (await policy({ toolName: "Bash", input: { command }, readOnly: true } as never)).behavior]).toEqual([mode, command, "ask"]);
    }
  });

  test("REVIEW-3: skill scripts under ~/.yodex keep running: the must-not-break corpus", async () => {
    const { protectedReachAsk, protectedReadDeny } = await import("../src/permission/safety");
    const { createPolicy } = await import("../src/permission/engine");
    const hop = "/home/mlpaluser/.yodex/hops/mlpal/0.2.6/skills";
    // The MLPal HOP's skill scripts (mlpal-hops mlpal/hop/0.2.6, skills/hop-builder), invoked by path as the Skill tool
    // says, and the pack and person skills beside them; the reads HOPs make of the environment's own files.
    const corpus = [
      `cp ${hop}/hop-evals/scripts/run_cases.py evals/`,
      `python3 ${hop}/hop-evals/scripts/run_cases.py run --cases evals/cases.json --out evals/runs/v0.1.0`,
      `python3 ${hop}/mcp-server-code/scripts/mcp_call.py --help`,
      `uv run python ${hop}/static-agent-test/scripts/sa_manifest.py`,
      ...["loop.sh", "ship.sh", "bakeoff.sh", "retune-brief.sh", "baseline.sh", "worklog.sh", "golden.sh", "_common.sh"].map((f) => `bash ~/.yodex/skills/hop-builder/scripts/${f} ./hop`),
      "python3 ~/.yodex/skills/hop-builder/scripts/new-family.py ./hop infra",
      "bash /home/mlpaluser/.yodex/hops/mlpal/1.2.0/skills/hop-builder/scripts/loop.sh",
      "python /home/mlpaluser/.yodex/plugins/browser/skills/web-check/flow.py",
      "bash ~/.yodex/skills/deploy/run.sh",
      "ls ~/.yodex/hops",
      "cat ~/.yodex/YODEX.md",
      "cat $HOME/.yodex/AGENTS.md",
      'yodex --hop "$PWD/.yodex/hops/demo" --print hi',
      "cat .yodex/settings.json",
      "grep -rn TODO .",
      "grep -r foo src",
      "find . -name '*.ts'",
      "cp -r src dist",
      "ls -R src",
      "du -sh ~/workspace",
      "tar -czf out.tgz ~/workspace/proj",
      "rg pattern ~/workspace/proj",
      "ls ~/workspace/*.md",
    ];
    for (const command of corpus) {
      expect([command, protectedReadDeny(command), protectedReachAsk(command)]).toEqual([command, null, null]);
      expect([command, (await createPolicy({ mode: "cruise" })({ toolName: "Bash", input: { command }, readOnly: false } as never)).behavior]).not.toEqual([command, "deny"]);
    }
  });

  test("REVIEW-3: a stored value is masked in xxd, xxd -p, od -tx1, od -c and wrapped base64 output", async () => {
    const { clearSecrets, redactText, registerSecret } = await import("../src/obs/redact");
    clearSecrets();
    const v = "sk-REVIEW3-0123456789abcdefABCDEF-key-41ch";
    registerSecret("stored key", v);
    const xxd = (b: Buffer) => {
      const out: string[] = [];
      for (let o = 0; o < b.length; o += 16) {
        const row = b.subarray(o, o + 16);
        const hex = (row.toString("hex").match(/.{1,4}/g) ?? []).join(" ").padEnd(39, " ");
        out.push(`${o.toString(16).padStart(8, "0")}: ${hex}  ${[...row].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ".")).join("")}`);
      }
      return out.join("\n");
    };
    const run = (argv: string[], input: Buffer) => Bun.spawnSync(argv, { stdin: input }).stdout.toString();
    for (const prefix of ["", "a", "ab", "abc", '{"version":1,"secrets":{"K_1A2B":{"value":"']) {
      const file = Buffer.from(`${prefix}${v}","server":"eleven","origin":"https://api.example"}}}\n`);
      const dumps: Record<string, string> = {
        xxd: xxd(file),
        "xxd -p": (file.toString("hex").match(/.{1,60}/g) ?? []).join("\n"),
        "od -An -tx1": run(["od", "-An", "-tx1"], file),
        "od -tx1": run(["od", "-tx1"], file),
        "od -c": run(["od", "-c"], file),
        "base64 (76)": run(["base64"], file),
        "base64 -w 20": run(["base64", "-w", "20"], file),
      };
      for (const [how, out] of Object.entries(dumps)) {
        const masked = redactText(out);
        expect([how, prefix.length, masked.includes("[redacted:stored key]")]).toEqual([how, prefix.length, true]);
        expect([how, masked.includes("0123456789abcdef"), masked.includes("3031323334353637")]).toEqual([how, false, false]);
      }
    }
    // Unrelated dumps are left as they are.
    const plain = run(["od", "-An", "-tx1"], Buffer.from("nothing secret in here at all, just text\n"));
    expect(redactText(plain)).toBe(plain);
    clearSecrets();
  });

  test("a registered value is masked as JSON-escaped, URL-encoded, hex and base64 at any alignment", async () => {
    const { clearSecrets, redactText, registerSecret } = await import("../src/obs/redact");
    clearSecrets();
    const v = 'R51-k"e\\y/+=value-0011';
    registerSecret("stored key", v);
    const shown = [JSON.stringify({ k: v }), encodeURIComponent(v), Buffer.from(v).toString("hex"), Buffer.from(v).toString("hex").toUpperCase()];
    for (const prefix of ["", "a", "ab", '{"secrets":{"K":"']) shown.push(Buffer.from(prefix + v + "tail").toString("base64"), Buffer.from(prefix + v).toString("base64url"));
    for (const s of shown) expect([s, redactText(s).includes("[redacted:stored key]")]).toEqual([s, true]);
    clearSecrets();
  });

  test("a background command's exit notice, a monitor event and an inbox event are masked", async () => {
    const { clearSecrets, registerSecret } = await import("../src/obs/redact");
    const { EventInbox } = await import("../src/events/inbox");
    clearSecrets();
    registerSecret("stored key", MARK);
    const inbox = new EventInbox();
    inbox.emit({ id: "1", source: "bg", sourceType: "monitor", kind: "error", label: `cat ${MARK}`, body: `Last output:\n${MARK}`, ts: 0 } as never);
    expect(JSON.stringify((inbox as unknown as { pending: unknown[] }).pending)).not.toContain(MARK);
    const { BackgroundTasks } = await import("../src/tools/builtin/background");
    const bg = new BackgroundTasks();
    const t = bg.start(`printf %s ${MARK}`, work) as unknown as { id: string };
    for (let i = 0; i < 50 && !bg.list().find((x) => x.id === t.id && x.exitCode !== null); i++) await new Promise((r) => setTimeout(r, 50));
    const notes = bg.drainNotifications();
    expect(notes.join("\n")).toContain("[redacted:stored key]");
    expect(notes.join("\n")).not.toContain(MARK);
    clearSecrets();
  });

  test("an OAuth token saved after start is masked from then on", async () => {
    const { clearSecrets, redactText } = await import("../src/obs/redact");
    const { StoredOAuthProvider } = await import("../src/mcp/oauth");
    clearSecrets();
    new StoredOAuthProvider({ dir: join(base, "auth"), server: "s" }).saveTokens({ access_token: "at-R51-fresh-token-77", token_type: "Bearer" } as never);
    expect(redactText("token at-R51-fresh-token-77")).toBe("token [redacted:MCP sign-in]");
    clearSecrets();
  });
});

describe("REVIEW-4 R4-1: paths in their normal form; a recursive read of the state directory is a sweep; hexdump -C", () => {
  const ctx = { home: "/home/mlpaluser", cwd: "/home/mlpaluser/workspace/proj" };

  test("the reviewer's lines and the five spellings ask (or are denied by name)", async () => {
    const { protectedReachAsk, protectedReadDeny, normalWord } = await import("../src/permission/safety");
    const asked = [
      "grep -r value ~/.yodex",
      "grep -r . ~/.yodex | xxd",
      "grep -r . ~/.yodex | hexdump -C",
      "grep -r . ~/.yodex | od -c",
      "rg -uu key /home/mlpaluser/.mlpal",
      "ls -R ~/.yodex/",
      "cat //home/mlpaluser/.yodex/person-secret?.json",
      "cat /home/./mlpaluser/.yodex/person-secret?.json",
      "cat ../../../mlpaluser/.yodex/person-secret?.json",
      "cat /proc/self/root/home/mlpaluser/.yodex/person-secret?.json",
      "cat /proc/1234/root/home/mlpaluser/.yodex/person-secret?.json",
      "hexdump -C //home/mlpaluser/.yodex/person-secret?.json",
      "od -c /home/./mlpaluser/.yodex/person-secret?.json",
      "cat ../.././.yodex/person-secret?.json",
      "grep -r . /proc/self/root/home/mlpaluser",
    ];
    for (const command of asked) expect([command, protectedReachAsk(command, ctx) !== null || protectedReadDeny(command) !== null]).toEqual([command, true]);
    expect(normalWord("//home/./u/../mlpaluser/.yodex", ctx)).toEqual({ path: "/home/mlpaluser/.yodex", literal: "/home/mlpaluser/.yodex", pattern: false });
    expect(normalWord("/proc/self/root/home/mlpaluser/.yodex/p*", ctx)?.literal).toBe("/home/mlpaluser/.yodex");
    expect(normalWord("~/.yodex", ctx)?.path).toBe("/home/mlpaluser/.yodex");
    expect(normalWord("src/x", ctx)?.path).toBe("/home/mlpaluser/workspace/proj/src/x");
    expect(normalWord("-r", ctx)).toBeNull();
  });

  test("must-not-break: of the reviewer's 74 everyday commands only `find /` asks; skill scripts and subfolders of ~/.yodex do not", async () => {
    const { protectedReachAsk, protectedReadDeny } = await import("../src/permission/safety");
    const corpus = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "permission", "everyday-commands.json"), "utf8")) as Record<string, string[]>;
    const all = Object.values(corpus).flat();
    expect(all.length).toBe(74);
    const asking = all.filter((c) => protectedReachAsk(c, ctx) !== null || protectedReadDeny(c) !== null);
    expect(asking).toEqual(["find / -name '*.log' 2>/dev/null | head"]);
    for (const c of ["grep -rn TODO ~/.yodex/skills", "ls -R ~/.yodex/hops/mlpal", "bash ~/.yodex/hops/mlpal/0.2.6/skills/hop-evals/scripts/run_cases.py", "du -sh ~/workspace", "cp -r ../shared ./vendor"]) {
      expect([c, protectedReachAsk(c, ctx)]).toEqual([c, null]);
    }
  });

  test("hexdump -C output is masked at every alignment; an unrelated dump is untouched", async () => {
    const { clearSecrets, redactText, registerSecret } = await import("../src/obs/redact");
    clearSecrets();
    const v = "sk-REVIEW4-0123456789abcdefABCDEF-key-41ch";
    registerSecret("stored key", v);
    for (const prefix of ["", "a", "ab", "abc", "abcdefgh", '{"version":1,"secrets":{"K":{"value":"']) {
      const file = Buffer.from(`${prefix}${v}","server":"e"}}}\n${"\0".repeat(64)}tail\n`);
      for (const argv of [["hexdump", "-C"], ["od", "-c"], ["od", "-An", "-c"]]) {
        const out = Bun.spawnSync(argv, { stdin: file }).stdout.toString();
        if (!out) continue;
        const masked = redactText(out);
        expect([argv.join(" "), prefix.length, masked.includes("[redacted:stored key]"), masked.includes("0123456789abcdef")]).toEqual([argv.join(" "), prefix.length, true, false]);
      }
    }
    const plain = Bun.spawnSync(["hexdump", "-C"], { stdin: Buffer.from("nothing secret here, only text and more text\n") }).stdout.toString();
    if (plain) expect(redactText(plain)).toBe(plain);
    clearSecrets();
  });
});

describe("REVIEW-5: relative words and $PWD against the folder; operands on the state directory; many-file readers", () => {
  const ctx = { home: "/home/mlpaluser", cwd: "/home/mlpaluser/workspace" };

  test("R5-1/R5-2/R5-3: the reviewer's lines ask", async () => {
    const { protectedReachAsk } = await import("../src/permission/safety");
    for (const command of [
      "cat src/../../.yodex/person-secret?.json",
      "cat sub/x/../../../.yodex/p*",
      "grep -d recurse value ~/.yodex",
      "grep --directories=recurse value ~/.yodex",
      "git grep --no-index value ~/.yodex",
      "ag value ~/.yodex",
      "ack value ~/.yodex",
      "fd . ~/.yodex -x cat",
      "tree ~/.yodex",
      "grep -d recurse . ~/.yodex | od",
      "ag secret ~",
      "tree /",
      "git grep --no-index key /home/mlpaluser",
      "cat $PWD/../.yodex/person-secret?.json",
      "cat ${PWD}/../.yodex/person-secret?.json",
      "cd ~ && cat .yodex/person-secret?.json",
      "cd .. && grep -r value .yodex",
      "cd ~/.yodex && cat p*",
      "ls ~/.yodex",
      "cp ~/.mlpal /tmp/x -r",
    ]) {
      expect([command, protectedReachAsk(command, ctx) !== null]).toEqual([command, true]);
    }
    // The folder unknown: a word that climbs toward a state directory asks; one that does not, does not.
    expect(protectedReachAsk("cat ../../.yodex/p*", { home: ctx.home })).not.toBeNull();
    expect(protectedReachAsk("cat $PWD/../.yodex/person-secret?.json", { home: ctx.home })).not.toBeNull();
    expect(protectedReachAsk("cat ../README.md", { home: ctx.home })).toBeNull();
    // After a cd whose target is not literal, the folder is unknown.
    expect(protectedReachAsk("cd $X && cat ../.yodex/p*", ctx)).not.toBeNull();
  });

  test("must-not-break: everyday commands, skills, the workspace's own sweeps, ls ~, YODEX.md", async () => {
    const { protectedReachAsk, protectedReadDeny } = await import("../src/permission/safety");
    const corpus = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "permission", "everyday-commands.json"), "utf8")) as Record<string, string[]>;
    const all = Object.values(corpus).flat();
    const proj = { home: ctx.home, cwd: "/home/mlpaluser/workspace/proj" };
    expect(all.filter((c) => protectedReachAsk(c, proj) !== null)).toEqual(["find / -name '*.log' 2>/dev/null | head"]);
    expect(all.filter((c) => protectedReadDeny(c) !== null)).toEqual([]);
    for (const c of [
      "grep -r foo .",
      "find . -name '*.ts'",
      "du -sh .",
      "ls ~",
      "cd ~",
      "ls -la ~/.config",
      "cat ~/.yodex/YODEX.md",
      "cat ~/.yodex/AGENTS.md",
      "ls ~/.yodex/hops",
      "ls -la ~/.yodex/plugins",
      "grep -r foo ~/.yodex/skills",
      "find ~/.yodex/hops -name SKILL.md",
      "cat ~/.yodex/hops/mlpal/0.2.6/hop.yaml",
      "python3 ~/.yodex/hops/mlpal/0.2.6/skills/hop-evals/scripts/run_cases.py run --cases evals/cases.json",
      "bash ~/.yodex/skills/hop-builder/scripts/loop.sh ./hop",
      'yodex --hop "$PWD/.yodex/hops/demo" --print hi',
      "cat ./node_modules/.bin/../pkg/package.json",
      "cat ../README.md",
      "grep -rn TODO ../other-project",
      "du -sh ~/workspace/*",
      "cd src && grep -r foo .",
    ]) {
      expect([c, protectedReachAsk(c, proj), protectedReadDeny(c)]).toEqual([c, null, null]);
    }
  });

  test("od -c and od -An -c are masked with spaces in the store's layout", async () => {
    const { clearSecrets, redactText, registerSecret } = await import("../src/obs/redact");
    clearSecrets();
    const v = "sk-REVIEW5-0123456789abcdefABCDEF-key-41ch";
    registerSecret("stored key", v);
    for (const indent of ["", " ", "  ", "   ", "    ", "     "]) {
      const file = Buffer.from(`{\n${indent}"secrets": {\n${indent}  "K": {\n${indent}    "value": "${v}",\n${indent}    "server": "e"\n  }\n}\n`);
      for (const argv of [["od", "-c"], ["od", "-An", "-c"]]) {
        const out = Bun.spawnSync(argv, { stdin: file }).stdout.toString();
        if (!out) continue;
        expect([argv.join(" "), indent.length, redactText(out).includes("[redacted:stored key]")]).toEqual([argv.join(" "), indent.length, true]);
      }
    }
    clearSecrets();
  });
});

describe("REVIEW-6: redirect files, directory options and ~+ / ~- are operands", () => {
  const ctx = { home: "/home/mlpaluser", cwd: "/home/mlpaluser/workspace/proj" };

  test("the reviewer's three lines and variants ask", async () => {
    const { protectedReachAsk } = await import("../src/permission/safety");
    for (const command of [
      "cat < ~/.yodex/person-secret?.json",
      "cat <~/.yodex/person-secret?.json",
      "jq . 0< ~/.yodex/p*",
      "hexdump -C < ~/.y*/person-secret?.json",
      "cat <> ~/.yodex/p*",
      "echo x > ~/.yodex/*.json",
      "echo x 2>~/.yodex/p*",
      "env -C ~/.yodex cat person-secret?.json",
      "env --chdir=/home/mlpaluser/.yodex cat p*",
      "git -C ~/.yodex grep --no-index value",
      "make -C ~/.yodex",
      "tar -C ~/.yodex -cf - .",
      "sudo -D ~/.yodex cat x",
      "npm --prefix ~/.mlpal ls",
      "env -C ~ grep -r value .yodex",
      "cat ~+/../../.yodex/person-secret?.json",
      "cat ~-/.yodex/person-secret?.json",
      "cat ~-/../p*",
      "cat $OLDPWD/.yodex/p*",
    ]) {
      expect([command, protectedReachAsk(command, ctx) !== null]).toEqual([command, true]);
    }
    expect(protectedReachAsk("cat ~+/../.yodex/p*", { home: ctx.home })).not.toBeNull();
  });

  test("must-not-break: the 74 everyday commands, the skills, workspace searches, ordinary redirects, -C in the workspace", async () => {
    const { protectedReachAsk, protectedReadDeny, expandLeading } = await import("../src/permission/safety");
    const corpus = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "permission", "everyday-commands.json"), "utf8")) as Record<string, string[]>;
    const all = Object.values(corpus).flat();
    expect(all.filter((c) => protectedReachAsk(c, ctx) !== null)).toEqual(["find / -name '*.log' 2>/dev/null | head"]);
    expect(all.filter((c) => protectedReadDeny(c) !== null)).toEqual([]);
    for (const c of [
      "bun test > out.txt 2>&1",
      "node build.js >> build.log",
      "jq .name < input.json",
      "cat < ~/.yodex/YODEX.md",
      "python3 run.py 2>/dev/null",
      "sort < data.csv > sorted.csv",
      "git -C . status",
      "git -C ../other log --oneline",
      "make -C build",
      "tar -C dist -czf out.tgz .",
      "npm --prefix web run build",
      "env -C src ls",
      "grep -r foo .",
      "find . -name '*.ts'",
      "ls ~",
      "cat ~+/README.md",
      "ls ~+",
      "cd ~- && ls",
      "bash ~/.yodex/skills/hop-builder/scripts/loop.sh ./hop > loop.log",
      "python3 ~/.yodex/hops/mlpal/0.2.6/skills/hop-evals/scripts/run_cases.py grade --cases evals/cases.json",
    ]) {
      expect([c, protectedReachAsk(c, ctx), protectedReadDeny(c)]).toEqual([c, null, null]);
    }
    expect(expandLeading("~+/x", ctx)).toEqual({ word: "/home/mlpaluser/workspace/proj/x" });
    expect(expandLeading("~-/x", ctx)).toEqual({ runtime: true });
    expect(expandLeading("~/x", ctx)).toEqual({ word: "/home/mlpaluser/x" });
    expect(expandLeading("${PWD}/x", ctx)).toEqual({ word: "/home/mlpaluser/workspace/proj/x" });
  });
});

describe("REVIEW-7: directory-stack tildes and named-descriptor redirects", () => {
  const ctx = { home: "/home/mlpaluser", cwd: "/home/mlpaluser/workspace/proj" };

  test("the reviewer's two lines and a variant of each ask", async () => {
    const { protectedReachAsk, expandLeading } = await import("../src/permission/safety");
    for (const command of [
      "cat ~+0/../.yodex/person-secret?.json",
      "cat ~-1/../../.y*/p*",
      "cat ~2/.mlpal/*",
      "exec {fd}<~/.yodex/person-secret?.json",
      "exec {out}> ~/.yodex/p*",
      "exec {rw}<>~/.y*/person-secret?.json",
    ]) {
      expect([command, protectedReachAsk(command, ctx) !== null]).toEqual([command, true]);
    }
    for (const w of ["~+0/x", "~-1/x", "~3/x", "~+12"]) expect([w, expandLeading(w, ctx)]).toEqual([w, { runtime: true }]);
  });

  test("must-not-break: stack tildes and named descriptors on workspace files stay free", async () => {
    const { protectedReachAsk } = await import("../src/permission/safety");
    for (const c of ["cat ~+0/README.md", "ls ~-1", "exec {fd}<input.json", "exec {log}>>build.log", "exec {fd}>&-"]) {
      expect([c, protectedReachAsk(c, ctx)]).toEqual([c, null]);
    }
  });
});
