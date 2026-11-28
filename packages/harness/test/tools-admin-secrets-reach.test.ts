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
  test("every spelling of the state directory is refused in every mode; a project's .yodex and YODEX.md are not", async () => {
    const { createPolicy } = await import("../src/permission/engine");
    const refused = [
      "cat ~/.yodex/person-secret?.json",
      "cat ~/.yodex/person-*",
      "cat ~/.yodex/*.json",
      "xxd ~/.yodex/person-secret?.json",
      "od -c ~/.yodex/pers*",
      "grep -r value ~/.yodex",
      "cat ~/.yodex/mcp-a*/linear.json",
      "tar -cf - ~/.yodex | base64",
      "cp -r ~/.yodex ~/workspace/copy",
      'cat "$HOME/.yodex/trust.json"',
      "cat ${HOME}/.yodex/config.json",
      "ls /home/mlpaluser/.yodex",
      "ls /Users/someone/.yodex/",
      "cat ../.yodex/plugin-hooks.json",
      "cd ~/.yodex && ls",
      "cat ~/.yodex/YODEX.md ~/.yodex/p*",
    ];
    for (const mode of ["cruise", "autopilot", "manual"] as const) {
      const policy = createPolicy({ mode, allow: ["Bash"] });
      for (const command of refused) {
        const d = await policy({ toolName: "Bash", input: { command }, readOnly: true } as never);
        expect([mode, command, d.behavior]).toEqual([mode, command, "deny"]);
      }
      for (const command of ["cat ~/.yodex/YODEX.md", "cat $HOME/.yodex/AGENTS.md", 'yodex --hop "$PWD/.yodex/hops/demo" --print hi', "ls .yodex/skills", "cat notes.md"]) {
        expect([mode, command, (await policy({ toolName: "Bash", input: { command }, readOnly: true } as never)).behavior]).toEqual([mode, command, "allow"]);
      }
    }
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
