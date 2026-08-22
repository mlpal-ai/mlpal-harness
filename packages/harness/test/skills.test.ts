import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createSkillTool,
  loadSkills,
  parseFrontmatter,
  skillsCatalog,
} from "../src/skills/skills";

let dir: string;
beforeEach(async () => {
  dir = join(tmpdir(), `yodex-skills-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
  test("extracts meta and body", () => {
    const { meta, body } = parseFrontmatter('---\nname: foo\ndescription: "does foo"\n---\nbody here');
    expect(meta.name).toBe("foo");
    expect(meta.description).toBe("does foo");
    expect(body).toBe("body here");
  });
  test("no frontmatter → whole text is the body", () => {
    expect(parseFrontmatter("just text").meta).toEqual({});
  });
});

describe("loadSkills", () => {
  test("includes the built-in docx skill", async () => {
    const skills = await loadSkills([]);
    expect(skills.some((s) => s.name === "docx")).toBe(true);
  });

  test("loads user skills from a dir and they override built-ins by name", async () => {
    await writeFile(join(dir, "deploy.md"), "---\nname: deploy\ndescription: ship it\n---\nrun the deploy script");
    await mkdir(join(dir, "docx"), { recursive: true });
    await writeFile(join(dir, "docx", "SKILL.md"), "---\nname: docx\ndescription: custom docx\n---\ncustom body");

    const skills = await loadSkills([dir]);
    expect(skills.find((s) => s.name === "deploy")?.description).toBe("ship it");
    const docx = skills.find((s) => s.name === "docx")!;
    expect(docx.description).toBe("custom docx"); // user overrode builtin
    expect(docx.body).toBe("custom body");
  });
});

describe("skill tool + catalog", () => {
  test("catalog lists names and descriptions", async () => {
    const skills = await loadSkills([]);
    const cat = skillsCatalog(skills);
    expect(cat).toContain("docx:");
    expect(cat).toContain("Skill tool");
  });

  test("Skill tool returns the body, errors on unknown", async () => {
    const skills = await loadSkills([]);
    const tool = createSkillTool(skills);
    const ok = await tool.call({ name: "docx" }, { cwd: dir });
    expect(ok.content).toContain("python-docx");
    const bad = await tool.call({ name: "nope" }, { cwd: dir });
    expect(bad.isError).toBe(true);
  });
});

describe("bundled-resource skills", () => {
  async function makeBundledSkill() {
    const sk = join(dir, "chart");
    await mkdir(join(sk, "scripts"), { recursive: true });
    await writeFile(join(sk, "SKILL.md"), "---\nname: chart\ndescription: make charts\n---\nUse the bundled script.");
    await writeFile(join(sk, "scripts", "plot.py"), "print('plotting')\n");
    await writeFile(join(sk, "reference.md"), "# Chart types\nbar, line, pie");
    return sk;
  }

  test("loadSkills sets `dir` for directory-form skills", async () => {
    const sk = await makeBundledSkill();
    const skills = await loadSkills([dir]);
    expect(skills.find((s) => s.name === "chart")?.dir).toBe(sk);
  });

  test("loading a bundled skill lists its resources with absolute paths", async () => {
    const sk = await makeBundledSkill();
    const tool = createSkillTool(await loadSkills([dir]));
    const out = await tool.call({ name: "chart" }, { cwd: dir });
    expect(out.content).toContain("Bundled resources");
    expect(out.content).toContain(join(sk, "scripts", "plot.py"));
    expect(out.content).toContain("reference.md");
  });

  test("Skill(file:…) returns a bundled file's contents", async () => {
    await makeBundledSkill();
    const tool = createSkillTool(await loadSkills([dir]));
    const out = await tool.call({ name: "chart", file: "reference.md" }, { cwd: dir });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("bar, line, pie");
  });

  test("Skill(file:…) refuses path traversal out of the skill dir", async () => {
    await makeBundledSkill();
    const tool = createSkillTool(await loadSkills([dir]));
    const out = await tool.call({ name: "chart", file: "../../etc/passwd" }, { cwd: dir });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("Refusing to read outside");
  });

  test("Skill(file:…) on a body-only (built-in) skill errors", async () => {
    const tool = createSkillTool(await loadSkills([]));
    const out = await tool.call({ name: "docx", file: "x" }, { cwd: dir });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("bundles no files");
  });
});

describe("skill state", () => {
  test("a disabled skill is refused by the Skill tool with a proceed-without-it note", async () => {
    const tool = createSkillTool(await loadSkills([]), { isEnabled: (n) => n !== "docx" });
    const out = await tool.call({ name: "docx" }, { cwd: dir });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('Skill "docx" is disabled');
    expect(out.content).toContain("Proceed without it");
  });

  test("catalog caps runaway descriptions at the entry limit", async () => {
    const catalog = skillsCatalog([
      { name: "big", description: "y".repeat(2000), body: "", source: "builtin" },
    ]);
    const line = catalog.split("\n").find((l) => l.startsWith("- big:"))!;
    expect(line.length).toBeLessThanOrEqual(260);
    expect(line.endsWith("…")).toBe(true);
  });

  test("catalog carries the invocation-reliability nudges", async () => {
    const catalog = skillsCatalog([{ name: "a", description: "d", body: "", source: "builtin" }]);
    expect(catalog).toContain("BEFORE doing the task");
    expect(catalog).toContain("Never say you used a skill without actually calling the tool");
    expect(catalog).toContain("already loaded in this conversation");
  });
});
