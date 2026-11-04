/**
 * managed-v1 (S-GUIDE-HOP's ask, C8 context): a command that prints the environment must be a command the rules see.
 * A bare `env` (or `env -i`, `env A=1`) used to decompose to nothing, as the `env` prefix with no command after it, so a
 * deny rule never fired on it and `mlpal whoami; env` passed an allow rule written for `mlpal`.
 */
import { describe, expect, test } from "bun:test";
import { createPolicy } from "../src/permission/engine";
import { decomposeBash } from "../src/permission/shell-decompose";

const decide = async (o: { allow?: string[]; deny?: string[] }, command: string) => (await createPolicy({ mode: "manual", ...o })({ toolName: "Bash", input: { command } } as never)).behavior;

/** The dashboard HOP's deny rules for the environment dumpers. */
const DENY = ["Bash(env*)", "Bash(printenv*)", "Bash(export*)", "Bash(set*)", "Bash(declare*)", "Bash(typeset*)", "Bash(compgen*)", "Bash(*/proc/*/environ*)"];

describe("environment dumpers are commands the rules see", () => {
  test("a bare env, with options or assignments and no command, is the command env", () => {
    expect(decomposeBash("env").commands.map((c) => c.forms)).toEqual([["env"]]);
    expect(decomposeBash("env -i").commands.map((c) => c.forms)).toEqual([["env -i"]]);
    expect(decomposeBash("env A=1").commands.map((c) => c.forms)).toEqual([["env A=1"]]);
    expect(decomposeBash("mlpal whoami; env").commands.map((c) => c.forms)).toEqual([["mlpal whoami"], ["env"]]);
    expect(decomposeBash("env | grep TOKEN").commands.map((c) => c.forms)).toEqual([["env"], ["grep TOKEN"]]);
    // env before a command is still a prefix: the command is what runs.
    expect(decomposeBash("env -u X git status").commands.map((c) => c.forms)).toEqual([["git status"]]);
  });

  test("each dumper is denied by the HOP's rules, alone or behind an allowed command", async () => {
    for (const command of [
      "env",
      "env -i",
      "printenv",
      "printenv MLPAL_ACCESS_TOKEN",
      "export -p",
      "export",
      "set",
      "declare -x",
      "typeset -x",
      "compgen -e",
      "cat /proc/self/environ",
      "cat /proc/1/environ",
      "mlpal whoami; env",
      "mlpal whoami && printenv",
      "mlpal agents list | env",
      "env | grep TOKEN",
    ]) {
      expect([command, await decide({ allow: ["Bash(mlpal *)"], deny: DENY }, command)]).toEqual([command, "deny"]);
    }
  });

  test("an allow rule for mlpal never auto-allows a line that also runs env", async () => {
    expect(await decide({ allow: ["Bash(mlpal *)"] }, "mlpal whoami")).toBe("allow");
    expect(await decide({ allow: ["Bash(mlpal *)"] }, "mlpal whoami; env")).toBe("ask");
    expect(await decide({ allow: ["Bash(mlpal *)"] }, "mlpal whoami; env -i")).toBe("ask");
  });
});
