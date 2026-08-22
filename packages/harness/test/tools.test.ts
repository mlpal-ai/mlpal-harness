import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultRegistry, runTool, type ToolContext } from "../src/tools";

let cwd: string;
let ctx: ToolContext;
const reg = defaultRegistry();

beforeEach(async () => {
  cwd = join(tmpdir(), `yodex-tools-${crypto.randomUUID()}`);
  await mkdir(cwd, { recursive: true });
  ctx = { cwd };
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("Bash timeout adoption (the 678-minute-command policy)", () => {
  test("a command outliving its timeout is adopted as a background task, not killed", async () => {
    const { bashTool } = await import("../src/tools/builtin/bash");
    const { backgroundTasks } = await import("../src/tools/builtin/background");
    const { EventInbox } = await import("../src/events/inbox");
    const inbox = new EventInbox();
    backgroundTasks.attachInbox(inbox, "s-adopt");
    try {
      const t0 = Date.now();
      const r = await bashTool.call(
        { command: "echo early-part; sleep 2; echo late-part", timeout: 500 },
        { cwd: "/tmp", sessionId: "s-adopt", signal: undefined } as never,
      );
      expect(Date.now() - t0).toBeLessThan(1_800); // returned at the timeout, not after the sleep
      const text = String(r.content);
      expect(r.isError).toBeFalsy();
      expect(text).toContain("early-part"); // output so far included
      expect(text).toMatch(/adopted as background task bg\d+/);
      const id = text.match(/background task (bg\d+)/)![1]!;
      // The adopted process finishes on its own and fires a terminal inbox event.
      await new Promise((res) => setTimeout(res, 2_300));
      const task = backgroundTasks.get(id)!;
      expect(task.exitCode).toBe(0);
      expect(task.output).toContain("late-part"); // post-adoption output captured
      const events = inbox.drain();
      expect(events.some((e) => e.source === id && e.kind === "complete")).toBe(true);
    } finally {
      backgroundTasks.detachInbox();
    }
  });

  test("the timeout schema caps at 10 minutes", async () => {
    const { bashTool } = await import("../src/tools/builtin/bash");
    const parsed = bashTool.schema.safeParse({ command: "true", timeout: 1_200_000 });
    expect(parsed.success).toBe(false);
  });
});

describe("Bash orphan-pipe hang (the `server.py &` bug)", () => {
  test("a backgrounded child holding the pipe does not stall the tool past exit", async () => {
    const { bashTool } = await import("../src/tools/builtin/bash");
    const t0 = Date.now();
    const r = await bashTool.call(
      { command: "sleep 30 & echo probe-ok" },
      { cwd: "/tmp", sessionId: "s", signal: undefined } as never,
    );
    const elapsed = Date.now() - t0;
    expect(String(r.content)).toContain("probe-ok");
    expect(elapsed).toBeLessThan(5_000); // was: hung until the 30s child released the pipe
  });
});

describe("registry", () => {
  test("exposes 11 tool schemas with input_schema", () => {
    const schemas = reg.schemas();
    expect(schemas).toHaveLength(11);
    const read = schemas.find((s) => s.name === "Read")!;
    expect((read.input_schema as { type: string }).type).toBe("object");
  });

  test("late-resolver lets a tool that registers mid-connect satisfy the call", async () => {
    const { ToolRegistry } = await import("../src/tools/registry");
    const { defineTool } = await import("../src/tools/types");
    const { z } = await import("zod");
    const r = new ToolRegistry();
    const late = defineTool({
      name: "mcp__x__ping",
      description: "t",
      readOnly: true,
      schema: z.object({}),
      call: async () => ({ content: "pong" }),
    });
    // resolver simulates an in-flight MCP connect finishing
    r.setLateResolver(async (name) => {
      if (name.startsWith("mcp__")) r.register(late as never);
    });
    const res = await runTool(r, "mcp__x__ping", {}, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("pong");
    // unrelated unknown names still fail fast
    const nope = await runTool(r, "Nope", {}, ctx);
    expect(nope.isError).toBe(true);
  });
});

describe("file tools", () => {
  test("Write then Read round-trips with line numbers", async () => {
    await runTool(reg, "Write", { path: "a.txt", content: "line1\nline2" }, ctx);
    const r = await runTool(reg, "Read", { path: "a.txt" }, ctx);
    expect(r.content).toContain("1\tline1");
    expect(r.content).toContain("2\tline2");
  });

  test("Edit replaces a unique string", async () => {
    await runTool(reg, "Write", { path: "b.txt", content: "hello world" }, ctx);
    const r = await runTool(reg, "Edit", { path: "b.txt", old_string: "world", new_string: "yodex" }, ctx);
    expect(r.isError).toBeFalsy();
    const read = await runTool(reg, "Read", { path: "b.txt" }, ctx);
    expect(read.content).toContain("hello yodex");
  });

  test("Edit rejects a non-unique string without replace_all", async () => {
    await runTool(reg, "Write", { path: "c.txt", content: "x x x" }, ctx);
    const r = await runTool(reg, "Edit", { path: "c.txt", old_string: "x", new_string: "y" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not unique");
  });

  test("Read reports missing file as error", async () => {
    const r = await runTool(reg, "Read", { path: "nope.txt" }, ctx);
    expect(r.isError).toBe(true);
  });

  test("Read caps an unbounded read at the default line limit", async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n");
    await runTool(reg, "Write", { path: "big.txt", content: big }, ctx);
    const r = await runTool(reg, "Read", { path: "big.txt" }, ctx);
    const text = r.content as string;
    expect(text).toContain("2000\tline2000");
    expect(text).not.toContain("2001\tline2001");
    expect(text).toContain("read 2000/2500 lines");
  });

  test("Read honors an explicit offset past the default cap", async () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line${i + 1}`).join("\n");
    await runTool(reg, "Write", { path: "big2.txt", content: big }, ctx);
    const r = await runTool(reg, "Read", { path: "big2.txt", offset: 2400, limit: 10 }, ctx);
    expect(r.content as string).toContain("2400\tline2400");
  });

  test("Read returns an image block for image files", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(cwd, "pic.png"), png);
    const r = await runTool(reg, "Read", { path: "pic.png" }, ctx);
    expect(typeof r.content === "string").toBe(false);
    const blocks = r.content as Array<{ type: string; source: { media_type: string } }>;
    expect(blocks[0]!.type).toBe("image");
    expect(blocks[0]!.source.media_type).toBe("image/png");
  });
});

describe("bash tool", () => {
  test("runs a command and captures output", async () => {
    const r = await runTool(reg, "Bash", { command: "echo hi && pwd" }, ctx);
    expect(r.content).toContain("hi");
  });

  test("non-zero exit is flagged as error", async () => {
    const r = await runTool(reg, "Bash", { command: "exit 3" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exit 3");
  });
});

describe("search tools", () => {
  test("Glob finds files; Grep finds content; List lists dir", async () => {
    await runTool(reg, "Write", { path: "src/x.ts", content: "export const NEEDLE = 1;" }, ctx);
    await runTool(reg, "Write", { path: "src/y.ts", content: "const z = 2;" }, ctx);

    const glob = await runTool(reg, "Glob", { pattern: "**/*.ts" }, ctx);
    expect(glob.content).toContain("src/x.ts");
    expect(glob.content).toContain("src/y.ts");

    const grep = await runTool(reg, "Grep", { pattern: "NEEDLE" }, ctx);
    expect(grep.content).toContain("src/x.ts:1");

    const list = await runTool(reg, "List", { path: "src" }, ctx);
    expect(list.content).toContain("x.ts");
  });
});

describe("background Bash", () => {
  test("run_in_background returns a task id; BashOutput reads incrementally until exit", async () => {
    const started = await runTool(
      reg,
      "Bash",
      { command: "echo first; sleep 0.3; echo second", run_in_background: true },
      ctx,
    );
    expect(started.isError).toBeFalsy();
    const id = String(started.content).match(/\b(bg\d+)\b/)![1]!;

    await new Promise((r) => setTimeout(r, 120));
    const first = await runTool(reg, "BashOutput", { id }, ctx);
    expect(first.content).toContain("running");
    expect(first.content).toContain("first");

    await new Promise((r) => setTimeout(r, 400));
    const second = await runTool(reg, "BashOutput", { id }, ctx);
    expect(second.content).toContain("exited with code 0");
    const body = String(second.content).split("\n").slice(1).join("\n"); // after the header
    expect(body).toContain("second");
    expect(body).not.toContain("first"); // incremental: already consumed
  });

  test("Kill stops a running task; unknown ids error", async () => {
    const started = await runTool(reg, "Bash", { command: "sleep 30", run_in_background: true }, ctx);
    const id = String(started.content).match(/\b(bg\d+)\b/)![1]!;
    const killed = await runTool(reg, "Kill", { id }, ctx);
    expect(killed.content).toContain("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    const after = await runTool(reg, "BashOutput", { id }, ctx);
    expect(after.content).toContain("exited");

    expect((await runTool(reg, "BashOutput", { id: "bg999" }, ctx)).isError).toBe(true);
    expect((await runTool(reg, "Kill", { id: "bg999" }, ctx)).isError).toBe(true);
  });
});

describe("WebFetch", () => {
  test("rejects a non-URL and a non-http scheme without touching the network", async () => {
    expect((await runTool(reg, "WebFetch", { url: "not a url" }, ctx)).isError).toBe(true);
    const ftp = await runTool(reg, "WebFetch", { url: "ftp://example.com/x" }, ctx);
    expect(ftp.isError).toBe(true);
    expect(ftp.content).toContain("http");
  });
});

describe("runTool validation", () => {
  test("rejects invalid input", async () => {
    const r = await runTool(reg, "Read", { wrong: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Invalid input");
  });

  test("unknown tool errors", async () => {
    const r = await runTool(reg, "Nope", {}, ctx);
    expect(r.isError).toBe(true);
  });
});

describe("workspace boundary (--add-dir)", () => {
  let outside: string;
  beforeEach(async () => {
    outside = join(tmpdir(), `yodex-outside-${crypto.randomUUID()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "TOP SECRET");
  });
  afterEach(async () => {
    await rm(outside, { recursive: true, force: true });
  });

  test("Read denies an absolute path outside the roots", async () => {
    const r = await runTool(reg, "Read", { path: join(outside, "secret.txt") }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("outside the allowed directories");
    expect(r.content).not.toContain("TOP SECRET");
  });

  test("Write denies escaping via ..", async () => {
    const r = await runTool(reg, "Write", { path: "../escape.txt", content: "x" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("outside the allowed directories");
  });

  test("an added root grants access", async () => {
    const withAdded: ToolContext = { cwd, roots: [cwd, outside] };
    const r = await runTool(reg, "Read", { path: join(outside, "secret.txt") }, withAdded);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("TOP SECRET");
  });

  test("cwd is always allowed even with explicit roots", async () => {
    await runTool(reg, "Write", { path: "in.txt", content: "hi" }, { cwd, roots: [cwd] });
    const r = await runTool(reg, "Read", { path: "in.txt" }, { cwd, roots: [cwd] });
    expect(r.content).toContain("hi");
  });
});
