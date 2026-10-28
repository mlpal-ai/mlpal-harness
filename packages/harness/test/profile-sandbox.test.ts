import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadProfile } from "../src/profile/load";

/** P4 §6: a HOP's own `sandbox`, `workspace` and `processes` blocks: validated and carried as data. */
describe("hop.yaml sandbox, workspace and processes (P4)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "yx-p4-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const hop = (name: string, body: string) => {
    const dir = join(home, ".yodex", "hops", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "hop.yaml"), `spec: mlpal/hop-v1\nname: ${name}\nversion: 1.0.0\ndescription: t\n${body}`);
  };
  const load = (name: string) => loadProfile(name, { cwd: "/nonexistent", home });

  const FULL = [
    "sandbox:",
    "  size: 1c2g",
    "  template: py-tools@v3",
    "  egress: { allow: [api.github.com, 'pypi.org:443', '[2001:db8::1]:8443'] }",
    "workspace:",
    "  policy: ephemeral",
    "  idle_after_s: 300",
    "  retention_s: 86400",
    "  outputs: ['/workspace/out/**', /tmp/report.md]",
    "processes:",
    "  mcp_stdio:",
    "    - { name: github, argv: [github-mcp, --stdio], env_names: [GITHUB_TOKEN] }",
    "  hooks: true",
    "  lsp: false",
    "",
  ].join("\n");

  test("a full declaration loads onto the profile as written", () => {
    hop("full", FULL);
    const p = load("full");
    expect(p.sandbox).toEqual({ size: "1c2g", template: "py-tools@v3", egress: { allow: ["api.github.com", "pypi.org:443", "[2001:db8::1]:8443"] } });
    expect(p.workspace).toEqual({ policy: "ephemeral", idle_after_s: 300, retention_s: 86400, outputs: ["/workspace/out/**", "/tmp/report.md"] });
    expect(p.processes).toEqual({ mcp_stdio: [{ name: "github", argv: ["github-mcp", "--stdio"], env_names: ["GITHUB_TOKEN"] }], hooks: true, lsp: false });
  });

  test("absent blocks stay absent (the coding builtin declares none); env_names defaults to none", () => {
    expect(load("coding").sandbox).toBeUndefined();
    hop("bare", "processes:\n  mcp_stdio:\n    - { name: fs, argv: [fs-mcp] }\n");
    const p = load("bare");
    expect(p.sandbox).toBeUndefined();
    expect(p.workspace).toBeUndefined();
    expect(p.processes).toEqual({ mcp_stdio: [{ name: "fs", argv: ["fs-mcp"], env_names: [] }] });
  });

  test("a child inherits its parent's blocks and overrides per field; its own mcp_stdio replaces the parent's list", () => {
    hop("parent", FULL);
    hop("child", "extends: parent\nsandbox: { size: 2c4g }\nworkspace: { policy: session }\nprocesses:\n  mcp_stdio: []\n");
    const p = load("child");
    expect(p.sandbox).toEqual({ size: "2c4g", template: "py-tools@v3", egress: { allow: ["api.github.com", "pypi.org:443", "[2001:db8::1]:8443"] } });
    expect(p.workspace).toEqual({ policy: "session", idle_after_s: 300, retention_s: 86400, outputs: ["/workspace/out/**", "/tmp/report.md"] });
    expect(p.processes).toEqual({ mcp_stdio: [], hooks: true, lsp: false });
  });

  const refused: Array<[string, string, RegExp]> = [
    ["size", "sandbox: { size: 8c16g }", /sandbox\.size/],
    ["template", "sandbox: { template: 'my template' }", /sandbox\.template/],
    ["egress wildcard", "sandbox: { egress: { allow: ['*.github.com'] } }", /sandbox\.egress\.allow/],
    ["egress scheme", "sandbox: { egress: { allow: ['https://api.github.com'] } }", /sandbox\.egress\.allow/],
    ["egress port", "sandbox: { egress: { allow: ['a.com:99999'] } }", /sandbox\.egress\.allow/],
    ["unknown sandbox key", "sandbox: { secrets: [] }", /secrets/],
    ["policy", "workspace: { policy: forever }", /workspace\.policy/],
    ["idle", "workspace: { idle_after_s: 0 }", /workspace\.idle_after_s/],
    ["retention", "workspace: { retention_s: -1 }", /workspace\.retention_s/],
    ["outputs outside the guest roots", "workspace: { outputs: [/etc/passwd] }", /workspace\.outputs/],
    ["outputs relative", "workspace: { outputs: [out/**] }", /workspace\.outputs/],
    ["volume is the platform's", "workspace: { volume: { name: a, size_gib: 1 } }", /volume/],
    ["process name", "processes: { mcp_stdio: [{ name: 'Git Hub', argv: [x] }] }", /processes\.mcp_stdio\.0\.name/],
    ["empty argv", "processes: { mcp_stdio: [{ name: gh, argv: [] }] }", /processes\.mcp_stdio\.0\.argv/],
    ["env name", "processes: { mcp_stdio: [{ name: gh, argv: [x], env_names: [github-token] }] }", /processes\.mcp_stdio\.0\.env_names/],
    ["inline env value", "processes: { mcp_stdio: [{ name: gh, argv: [x], env: { A: b } }] }", /env/],
    ["duplicate names", "processes: { mcp_stdio: [{ name: gh, argv: [x] }, { name: gh, argv: [y] }] }", /processes\.mcp_stdio: duplicate name "gh"/],
    ["hooks", "processes: { hooks: yes-please }", /processes\.hooks/],
  ];
  for (const [what, body, error] of refused) {
    test(`refused: ${what}`, () => {
      hop("bad", `${body}\n`);
      expect(() => load("bad")).toThrow(error);
    });
  }
});
