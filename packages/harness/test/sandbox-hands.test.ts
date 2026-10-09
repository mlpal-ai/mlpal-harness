import { describe, expect, test } from "bun:test";
import { createSandboxHands, guestPath, type HandsClient, type HandsExecResult, SANDBOX_HANDS_NAMES } from "../src/tools/remote/sandbox-hands";

/** An in-memory guest: a file map and a tiny shell that knows the commands the tools issue. */
class FakeGuest implements HandsClient {
  files = new Map<string, string>();
  execs = new Map<string, HandsExecResult>();
  calls: { argv: string[] | string; opts?: unknown }[] = [];
  killed: string[] = [];
  private n = 0;

  constructor(files: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(files)) this.files.set(k, v);
  }

  private result(over: Partial<HandsExecResult>): HandsExecResult {
    const id = `ex_${++this.n}`;
    const r: HandsExecResult = { execId: id, exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, state: "exited", ...over };
    this.execs.set(id, r);
    return r;
  }

  async exec(argv: string[] | string, opts?: { detach?: boolean; timeoutMs?: number; cwd?: string }): Promise<HandsExecResult> {
    this.calls.push({ argv, opts });
    const cmd = typeof argv === "string" ? argv : argv.join(" ");
    if (opts?.detach) return this.result({ state: "running", exitCode: null, stdout: "" });
    if (cmd.startsWith("echo ")) return this.result({ stdout: `${cmd.slice(5)}\n` });
    if (cmd === "fail") return this.result({ stdout: "partial\n", stderr: "boom\n", exitCode: 2 });
    if (cmd === "slow") return this.result({ stdout: "tick\n", exitCode: null, timedOut: true });
    if (cmd === "big") return this.result({ stdout: "x".repeat(100) + "END", truncated: true });
    const m = /^cd (\S+) && rg (.*)$/.exec(cmd);
    if (m) {
      const base = m[1]!.replace(/^'|'$/g, "");
      const args = m[2]!;
      const inBase = [...this.files.keys()].filter((p) => p.startsWith(`${base}/`)).map((p) => p.slice(base.length + 1));
      if (args.includes("--files")) {
        const pat = /-g (\S+)/.exec(args)![1]!.replace(/^'|'$/g, "");
        const ext = pat.replace(/^\*\*\/\*/, "");
        const hits = inBase.filter((p) => p.endsWith(ext));
        return this.result(hits.length ? { stdout: hits.join("\n") + "\n" } : { exitCode: 1 });
      }
      const pat = /--regexp (\S+)$/.exec(args)![1]!.replace(/^'|'$/g, "");
      const glob = /-g (\S+)/.exec(args)?.[1]?.replace(/^'|'$/g, "");
      const lines: string[] = [];
      for (const rel of inBase) {
        if (glob && !rel.endsWith(glob.replace(/^\*/, ""))) continue;
        this.files.get(`${base}/${rel}`)!.split("\n").forEach((l, i) => {
          if (new RegExp(pat).test(l)) lines.push(`${rel}:${i + 1}:${l}`);
        });
      }
      return this.result(lines.length ? { stdout: lines.join("\n") + "\n" } : { exitCode: 1 });
    }
    return this.result({ stderr: `sh: ${cmd}: not found\n`, exitCode: 127 });
  }

  async readOutput(execId: string): Promise<HandsExecResult> {
    const r = this.execs.get(execId);
    if (!r) throw new Error("exec_not_found");
    return r;
  }

  async killExec(execId: string): Promise<void> {
    this.killed.push(execId);
  }

  async readFile(path: string): Promise<Uint8Array> {
    const t = this.files.get(path);
    if (t === undefined) throw new Error(`not_found: ${path}`);
    return new TextEncoder().encode(t);
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    if (!path.startsWith("/workspace") && !path.startsWith("/tmp")) throw new Error("path_refused");
    this.files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
  }

  async listDir(path: string): Promise<{ name: string; is_dir?: boolean }[]> {
    const prefix = `${path.replace(/\/$/, "")}/`;
    const names = new Map<string, boolean>();
    for (const p of this.files.keys()) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const head = rest.split("/")[0]!;
      names.set(head, rest.includes("/"));
    }
    return [...names.entries()].map(([name, is_dir]) => ({ name, is_dir }));
  }
}

const ctx = { cwd: "/anything-local" };
const guest = () => new FakeGuest({
  "/workspace/src/a.ts": "const a = 1;\nexport const b = a + 1;\n",
  "/workspace/src/b.ts": "import { b } from './a';\nconsole.log(b);\n",
  "/workspace/README.md": "# demo\n",
  "/workspace/node_modules/x/index.js": "x",
});
const tools = (g: FakeGuest) => Object.fromEntries(createSandboxHands({ client: g, maxOutput: 60 }).map((t) => [t.name, t]));

describe("sandbox hands: the same nine tools, over a session", () => {
  test("names and flags match the local builtins; paths resolve against the guest cwd", () => {
    const t = tools(guest());
    expect(Object.keys(t).sort()).toEqual([...SANDBOX_HANDS_NAMES].sort());
    expect(t.Bash!.executes && !t.Bash!.readOnly).toBe(true);
    expect(t.Read!.readOnly && t.Glob!.readOnly && t.Grep!.readOnly && t.List!.readOnly && t.BashOutput!.readOnly).toBe(true);
    expect(t.Write!.edits && t.Edit!.edits).toBe(true);
    expect(guestPath("src/a.ts", "/workspace")).toBe("/workspace/src/a.ts");
    expect(guestPath("./src/a.ts", "/workspace/")).toBe("/workspace/src/a.ts");
    expect(guestPath("/tmp/x", "/workspace")).toBe("/tmp/x");
    expect(guestPath(undefined, "/workspace")).toBe("/workspace");
  });

  test("Bash: combined output, the exit prefix, timeouts, the tail cap, the sandbox's own cap, background start, BashOutput and Kill", async () => {
    const g = guest();
    const t = tools(g);
    expect((await t.Bash!.call({ command: "echo hi" }, ctx)).content).toBe("hi\n");
    expect(g.calls[0]!.opts).toMatchObject({ cwd: "/workspace", timeoutMs: 120_000 });
    const f = await t.Bash!.call({ command: "fail", timeout: 5000 }, ctx);
    expect(f.content).toBe("[exit 2]\npartial\nboom\n");
    expect(f.isError).toBe(false);
    expect(g.calls[1]!.opts).toMatchObject({ timeoutMs: 5000 });
    expect((await t.Bash!.call({ command: "slow" }, ctx)).content).toBe("tick\n\n[timed out]");
    const big = String((await t.Bash!.call({ command: "big" }, ctx)).content);
    expect(big).toContain("[output truncated — showing the last 60 characters]");
    expect(big).toContain("END");
    expect(big).toContain("read the rest with BashOutput ex_4");
    const bg = await t.Bash!.call({ command: "sleep 100", run_in_background: true }, ctx);
    expect(bg.content).toBe("Started background task ex_5. Read its output with BashOutput, stop it with Kill.");
    expect(g.calls[4]!.opts).toMatchObject({ detach: true, timeoutMs: 600_000 });
    expect((await t.BashOutput!.call({ id: "ex_5" }, ctx)).content).toBe("[still running: ex_5]\n");
    expect(await t.BashOutput!.call({ id: "nope" }, ctx)).toMatchObject({ isError: true, content: "cannot read nope: exec_not_found" });
    expect((await t.Kill!.call({ id: "ex_5" }, ctx)).content).toBe("Killed ex_5");
    expect(g.killed).toEqual(["ex_5"]);
    const noKill = Object.fromEntries(createSandboxHands({ client: { ...g, killExec: undefined } as unknown as HandsClient }).map((x) => [x.name, x]));
    expect(await noKill.Kill!.call({ id: "ex_5" }, ctx)).toMatchObject({ isError: true });
  });

  test("Read numbers lines with offset and limit and the continuation note; a missing file is an error", async () => {
    const g = guest();
    g.files.set("/workspace/long.txt", Array.from({ length: 2005 }, (_, i) => `l${i + 1}`).join("\n"));
    const t = tools(g);
    expect((await t.Read!.call({ path: "src/a.ts" }, ctx)).content).toBe("     1\tconst a = 1;\n     2\texport const b = a + 1;\n     3\t");
    expect((await t.Read!.call({ path: "src/a.ts", offset: 2, limit: 1 }, ctx)).content).toBe("     2\texport const b = a + 1;");
    const long = String((await t.Read!.call({ path: "/workspace/long.txt" }, ctx)).content);
    expect(long.endsWith("[read 2000/2005 lines — pass offset:2001 to continue, or Grep for a specific match]")).toBe(true);
    expect(await t.Read!.call({ path: "missing.ts" }, ctx)).toMatchObject({ isError: true, content: "cannot read missing.ts: not_found: /workspace/missing.ts" });
  });

  test("Write and Edit change the guest file and carry a diff; Edit refuses a missing or ambiguous old_string; the guest's refusal is the error", async () => {
    const g = guest();
    const t = tools(g);
    const w = await t.Write!.call({ path: "src/c.ts", content: "export const c = 3;\n" }, ctx);
    expect(w.content).toBe("Wrote 20 bytes to src/c.ts");
    expect(w.meta?.diff).toContain("+export const c = 3;");
    expect(g.files.get("/workspace/src/c.ts")).toBe("export const c = 3;\n");
    const e = await t.Edit!.call({ path: "src/a.ts", old_string: "a + 1", new_string: "a + 2" }, ctx);
    expect(e.content).toBe("Replaced 1 occurrence(s) in src/a.ts");
    expect(g.files.get("/workspace/src/a.ts")).toContain("a + 2");
    expect(e.meta?.diff).toContain("-export const b = a + 1;");
    expect(await t.Edit!.call({ path: "src/a.ts", old_string: "zzz", new_string: "y" }, ctx)).toMatchObject({ isError: true, content: "old_string not found in file" });
    g.files.set("/workspace/dup.txt", "x x");
    expect(await t.Edit!.call({ path: "dup.txt", old_string: "x", new_string: "y" }, ctx)).toMatchObject({ isError: true, content: expect.stringContaining("not unique (2 matches)") });
    expect((await t.Edit!.call({ path: "dup.txt", old_string: "x", new_string: "y", replace_all: true }, ctx)).content).toBe("Replaced 2 occurrence(s) in dup.txt");
    expect(await t.Write!.call({ path: "/etc/passwd", content: "no" }, ctx)).toMatchObject({ isError: true, content: "cannot write /etc/passwd: path_refused" });
  });

  test("Glob, Grep and List run ripgrep in the guest and render like the local tools", async () => {
    const g = guest();
    const t = tools(g);
    expect((await t.Glob!.call({ pattern: "**/*.ts" }, ctx)).content).toBe("src/a.ts\nsrc/b.ts");
    expect(String(g.calls[0]!.argv)).toBe("cd /workspace && rg --files -g '**/*.ts'");
    expect((await t.Glob!.call({ pattern: "**/*.py" }, ctx)).content).toBe("No files matched");
    expect((await t.Grep!.call({ pattern: "const", path: "src" }, ctx)).content).toBe("a.ts:1:const a = 1;\na.ts:2:export const b = a + 1;");
    expect(String(g.calls[2]!.argv)).toBe("cd /workspace/src && rg --line-number --max-columns 500 --regexp const");
    expect((await t.Grep!.call({ pattern: "console", glob: "*.ts" }, ctx)).content).toBe("src/b.ts:2:console.log(b);");
    expect((await t.Grep!.call({ pattern: "nothing-here" }, ctx)).content).toBe("No matches");
    expect((await t.List!.call({}, ctx)).content).toBe("README.md\nsrc/");
    expect((await t.List!.call({ path: "src" }, ctx)).content).toBe("a.ts\nb.ts");
    expect((await t.List!.call({ path: "empty" }, ctx)).content).toBe("(empty)");
  });
});
