import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { expandCommand, loadCommands, type SlashCommand } from "../src/commands/commands";

let dir: string;
beforeEach(async () => { dir = join(tmpdir(), `yodex-cmd-${crypto.randomUUID()}`); await mkdir(dir, { recursive: true }); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("loadCommands", () => {
  test("loads /name from <name>.md with frontmatter description", async () => {
    await writeFile(join(dir, "fix.md"), "---\ndescription: fix a bug\n---\nFix the bug: $ARGUMENTS");
    const cmds = await loadCommands([dir]);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.name).toBe("fix");
    expect(cmds[0]!.description).toBe("fix a bug");
  });
  test("project dir overrides user dir by name", async () => {
    const user = join(dir, "u"); const proj = join(dir, "p");
    await mkdir(user); await mkdir(proj);
    await writeFile(join(user, "x.md"), "---\ndescription: user\n---\nu");
    await writeFile(join(proj, "x.md"), "---\ndescription: project\n---\np");
    const cmds = await loadCommands([user, proj]);
    expect(cmds.find((c) => c.name === "x")!.description).toBe("project");
  });
});

describe("expandCommand", () => {
  const cmd = (body: string): SlashCommand => ({ name: "t", description: "", body, source: "" });
  test("$ARGUMENTS expands to all args", () => {
    expect(expandCommand(cmd("Do: $ARGUMENTS"), "the thing now")).toBe("Do: the thing now");
  });
  test("$1..$9 expand positionally", () => {
    expect(expandCommand(cmd("$1 then $2"), "alpha beta")).toBe("alpha then beta");
  });
  test("no placeholder + args → args appended", () => {
    expect(expandCommand(cmd("Review the code."), "focus on perf")).toBe("Review the code.\n\nfocus on perf");
  });
  test("no placeholder + no args → body verbatim", () => {
    expect(expandCommand(cmd("Summarize the repo."), "")).toBe("Summarize the repo.");
  });
});
