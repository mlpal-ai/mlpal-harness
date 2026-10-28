import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadProfile } from "../src/profile/load";

/** The mlpal/hop-v1 declaration blocks (controller ruling 2026-10-28) and P4's processes: validated and carried as data. */
describe("hop.yaml sandbox, workspace, credentials, memory promotion/limits and processes", () => {
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
    "  size_class: 1c2g",
    "  template: py-tools@v3",
    "  egress: [api.github.com, 'pypi.org:443', '[2001:db8::1]:8443']",
    "workspace:",
    "  policy: ephemeral",
    "credentials:",
    "  - { ref: gh-token, tool: sandbox, host: api.github.com, header: authorization }",
    "  - { ref: vlt_01J9, tool: github-mcp, host: api.githubcopilot.com, header: Authorization }",
    "memory:",
    "  reads: ['repo/*']",
    "  writes: ['repo/*']",
    "  promotion: review",
    "  limits: { max_nodes: 5000, max_bytes: 10485760, max_write_bytes: 65536 }",
    "processes:",
    "  mcp_stdio:",
    "    - { name: github, argv: [github-mcp, --stdio], env_names: [GITHUB_TOKEN] }",
    "  hooks: true",
    "  lsp: false",
    "",
  ].join("\n");

  test("all four declaration blocks and processes load onto the profile as written", () => {
    hop("full", FULL);
    const p = load("full");
    expect(p.sandbox).toEqual({ size_class: "1c2g", template: "py-tools@v3", egress: ["api.github.com", "pypi.org:443", "[2001:db8::1]:8443"] });
    expect(p.workspace).toEqual({ policy: "ephemeral" });
    expect(p.credentials).toEqual([
      { ref: "gh-token", tool: "sandbox", host: "api.github.com", header: "authorization" },
      { ref: "vlt_01J9", tool: "github-mcp", host: "api.githubcopilot.com", header: "Authorization" },
    ]);
    expect(p.memory).toMatchObject({ reads: ["repo/*"], writes: ["repo/*"], promotion: "review", limits: { max_nodes: 5000, max_bytes: 10485760, max_write_bytes: 65536 } });
    expect(p.processes).toEqual({ mcp_stdio: [{ name: "github", argv: ["github-mcp", "--stdio"], env_names: ["GITHUB_TOKEN"] }], hooks: true, lsp: false });
  });

  test("absent blocks stay absent (the coding builtin declares none); env_names defaults to none", () => {
    const coding = load("coding");
    expect([coding.sandbox, coding.workspace, coding.credentials, coding.processes, coding.memory?.promotion, coding.memory?.limits]).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    hop("bare", "processes:\n  mcp_stdio:\n    - { name: fs, argv: [fs-mcp] }\n");
    const p = load("bare");
    expect(p.sandbox).toBeUndefined();
    expect(p.workspace).toBeUndefined();
    expect(p.credentials).toBeUndefined();
    expect(p.processes).toEqual({ mcp_stdio: [{ name: "fs", argv: ["fs-mcp"], env_names: [] }] });
  });

  test("a child inherits its parent's blocks and overrides per field; its own lists replace the parent's", () => {
    hop("parent", FULL);
    hop("child", "extends: parent\nsandbox: { size_class: 2c4g }\nworkspace: { policy: session }\ncredentials: []\nmemory: { promotion: auto }\nprocesses:\n  mcp_stdio: []\n");
    const p = load("child");
    expect(p.sandbox).toEqual({ size_class: "2c4g", template: "py-tools@v3", egress: ["api.github.com", "pypi.org:443", "[2001:db8::1]:8443"] });
    expect(p.workspace).toEqual({ policy: "session" });
    expect(p.credentials).toEqual([]);
    expect(p.memory).toMatchObject({ promotion: "auto", limits: { max_nodes: 5000 } });
    expect(p.processes).toEqual({ mcp_stdio: [], hooks: true, lsp: false });
    hop("heir", "extends: parent\n");
    expect(load("heir").credentials).toHaveLength(2);
    expect(load("heir").memory).toMatchObject({ promotion: "review", limits: { max_nodes: 5000, max_bytes: 10485760, max_write_bytes: 65536 } });
  });

  test("memory.limits are inherited per field, as sandbox is", () => {
    hop("parent", FULL);
    hop("tighter", "extends: parent\nmemory: { limits: { max_nodes: 100 } }\n");
    expect(load("tighter").memory).toMatchObject({ promotion: "review", limits: { max_nodes: 100, max_bytes: 10485760, max_write_bytes: 65536 } });
  });

  const refused: Array<[string, string, RegExp]> = [
    ["size_class", "sandbox: { size_class: 8c16g }", /sandbox\.size_class/],
    ["size (the old name)", "sandbox: { size: 1c2g }", /size/],
    ["template", "sandbox: { template: 'my template' }", /sandbox\.template/],
    ["egress as {allow} (the old shape)", "sandbox: { egress: { allow: [a.com] } }", /sandbox\.egress/],
    ["egress wildcard", "sandbox: { egress: ['*.github.com'] }", /sandbox\.egress\.0/],
    ["egress scheme", "sandbox: { egress: ['https://api.github.com'] }", /sandbox\.egress\.0/],
    ["egress port", "sandbox: { egress: ['a.com:99999'] }", /sandbox\.egress\.0/],
    ["unknown sandbox key", "sandbox: { secrets: [] }", /secrets/],
    ["policy", "workspace: { policy: forever }", /workspace\.policy/],
    ["workspace extras are the platform's", "workspace: { idle_after_s: 300 }", /idle_after_s/],
    ["workspace outputs are the platform's", "workspace: { outputs: [/workspace/out/**] }", /outputs/],
    ["volume is the platform's", "workspace: { volume: { name: a, size_gib: 1 } }", /volume/],
    ["a credential value", "credentials: [{ ref: gh, tool: sandbox, host: api.github.com, header: authorization, value: ghp_x }]", /credentials\.0: a credential is a reference \(ref\); a value never appears in a HOP/],
    ["a credential without ref", "credentials: [{ tool: sandbox, host: api.github.com, header: authorization }]", /credentials\.0\.ref/],
    ["a credential's unknown key", "credentials: [{ ref: gh, tool: sandbox, host: api.github.com, header: authorization, scheme: bearer }]", /scheme/],
    ["a credential host with a port", "credentials: [{ ref: gh, tool: sandbox, host: 'api.github.com:443', header: authorization }]", /credentials\.0\.host/],
    ["a credential header", "credentials: [{ ref: gh, tool: sandbox, host: api.github.com, header: 'bad header' }]", /credentials\.0\.header/],
    ["memory promotion", "memory: { promotion: always }", /memory\.promotion/],
    ["memory limits", "memory: { limits: { max_nodes: 0 } }", /memory\.limits\.max_nodes/],
    ["memory limits unknown", "memory: { limits: { max_files: 3 } }", /max_files/],
    ["process name", "processes: { mcp_stdio: [{ name: 'Git Hub', argv: [x] }] }", /processes\.mcp_stdio\.0\.name/],
    ["empty argv", "processes: { mcp_stdio: [{ name: gh, argv: [] }] }", /processes\.mcp_stdio\.0\.argv/],
    ["env name", "processes: { mcp_stdio: [{ name: gh, argv: [x], env_names: [github-token] }] }", /processes\.mcp_stdio\.0\.env_names/],
    ["inline env value", "processes: { mcp_stdio: [{ name: gh, argv: [x], env: { A: b } }] }", /env/],
    ["duplicate names", "processes: { mcp_stdio: [{ name: gh, argv: [x] }, { name: gh, argv: [y] }] }", /processes\.mcp_stdio: duplicate name "gh"/],
    ["hooks", "processes: { hooks: yes-please }", /processes\.hooks/],
    ["an unknown top-level key, as before", "sandboxes: {}", /sandboxes/],
  ];
  for (const [what, body, error] of refused) {
    test(`refused: ${what}`, () => {
      hop("bad", `${body}\n`);
      expect(() => load("bad")).toThrow(error);
    });
  }
});
