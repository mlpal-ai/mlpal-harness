import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadAgents } from "../src/subagent/agents";
import { createTaskTool, type SubagentRun } from "../src/subagent/task";

let userDir: string;
let projDir: string;

beforeEach(async () => {
  userDir = join(tmpdir(), `yodex-agents-u-${crypto.randomUUID()}`);
  projDir = join(tmpdir(), `yodex-agents-p-${crypto.randomUUID()}`);
  await mkdir(userDir, { recursive: true });
  await mkdir(projDir, { recursive: true });
});
afterEach(async () => {
  await rm(userDir, { recursive: true, force: true });
  await rm(projDir, { recursive: true, force: true });
});

describe("loadAgents", () => {
  test("parses frontmatter (name, description, model, tools) and body", async () => {
    await writeFile(
      join(userDir, "reviewer.md"),
      `---\nname: reviewer\ndescription: reviews code for bugs\nmodel: mlpal-flash\ntools: Read, Grep, Glob\n---\nYou are a meticulous code reviewer. Report findings only.`,
    );
    const [a] = await loadAgents([userDir]);
    expect(a).toMatchObject({
      name: "reviewer",
      description: "reviews code for bugs",
      model: "mlpal-flash",
      tools: ["Read", "Grep", "Glob"],
    });
    expect(a!.prompt).toContain("meticulous code reviewer");
  });

  test("project dir overrides user dir by name; filename is the fallback name", async () => {
    await writeFile(join(userDir, "helper.md"), `---\ndescription: user version\n---\nuser body`);
    await writeFile(join(projDir, "helper.md"), `---\ndescription: project version\n---\nproject body`);
    const agents = await loadAgents([userDir, projDir]);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.description).toBe("project version");
  });

  test("skips files without a body and missing dirs", async () => {
    await writeFile(join(userDir, "empty.md"), `---\nname: empty\n---\n`);
    const agents = await loadAgents([userDir, "/nonexistent-dir"]);
    expect(agents).toHaveLength(0);
  });
});

describe("Task tool with custom agents", () => {
  const runs: Array<{ prompt: string; agent?: string }> = [];
  const run: SubagentRun = async (args) => {
    runs.push({ prompt: args.prompt, agent: args.agent });
    return { text: `done as ${args.agent ?? "default"}`, sessionId: "s" };
  };

  test("passes the agent name through and advertises agents in the description", async () => {
    const tool = createTaskTool(run, [
      { name: "reviewer", description: "reviews code", prompt: "p", source: "t" },
    ]);
    expect(tool.description).toContain("reviewer");
    const r = await tool.call(
      { description: "review it", prompt: "review x", agent: "reviewer" },
      { cwd: "/" },
    );
    expect(r.content).toBe("done as reviewer");
    expect(runs.at(-1)).toMatchObject({ agent: "reviewer" });
  });

  test("unknown agent name errors without running", async () => {
    const tool = createTaskTool(run, []);
    const r = await tool.call({ description: "x", prompt: "y", agent: "ghost" }, { cwd: "/" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Unknown agent");
  });
});
