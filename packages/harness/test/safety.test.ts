import { describe, expect, test } from "bun:test";
import { createPolicy } from "../src/permission/engine";
import {
  catastrophicDeny,
  contentSafetyDeny,
  redirectTargets,
  splitShellCommands,
} from "../src/permission/safety";

const HUMAN = { type: "human" as const };
function bash(command: string) {
  return { toolName: "Bash", input: { command }, readOnly: false, isEdit: false, principal: HUMAN };
}
function write(path: string) {
  return { toolName: "Write", input: { path, content: "x" }, readOnly: false, isEdit: true, principal: HUMAN };
}

describe("splitShellCommands", () => {
  test("splits on &&, ||, ;, |", () => {
    expect(splitShellCommands("git status && rm -rf x")).toEqual(["git status", "rm -rf x"]);
    expect(splitShellCommands("a ; b | c || d")).toEqual(["a", "b", "c", "d"]);
  });
  test("does not split inside quotes", () => {
    expect(splitShellCommands('echo "a; b && c"')).toEqual(['echo a; b && c']);
  });
  test("recurses into $() and backticks", () => {
    expect(splitShellCommands("echo $(rm -rf /)")).toContain("rm -rf /");
    expect(splitShellCommands("echo `mkfs.ext4 /dev/sda`")).toContain("mkfs.ext4 /dev/sda");
  });
});

describe("catastrophicDeny", () => {
  test("blocks rm -rf on system/home roots", () => {
    expect(catastrophicDeny("rm -rf /")).toBeTruthy();
    expect(catastrophicDeny("rm -rf ~")).toBeTruthy();
    expect(catastrophicDeny("rm -rf /usr/lib")).toBeTruthy();
    expect(catastrophicDeny("rm -fr $HOME/*")).toBeTruthy();
    expect(catastrophicDeny("sudo rm -rf --no-preserve-root /")).toBeTruthy();
  });
  test("allows rm -rf on project subdirs", () => {
    expect(catastrophicDeny("rm -rf node_modules")).toBeNull();
    expect(catastrophicDeny("rm -rf ./build dist")).toBeNull();
    expect(catastrophicDeny("rm file.txt")).toBeNull();
  });
  test("blocks rm -rf on a home folder itself, by path or alias", () => {
    for (const target of [
      "~",
      "~/",
      "~/*",
      "$HOME",
      "/home",
      "/home/",
      "/home/*",
      "/home/mlpaluser",
      "/home/mlpaluser/",
      "/home/mlpaluser/*",
      "/Users",
      "/Users/me",
      "/Users/me/*",
      "/root",
      "/root/project",
    ]) {
      expect(catastrophicDeny(`rm -rf ${target}`)).toBe("blocked: recursive-force rm targeting a system/home root");
    }
  });
  test("still blocks every path in a system folder", () => {
    for (const target of ["/usr/local/lib", "/var/tmp/x", "/etc/nginx", "/bin/*", "/Library/Caches"]) {
      expect(catastrophicDeny(`rm -rf ${target}`)).toBeTruthy();
    }
  });
  test("allows rm -rf on a project folder inside a home", () => {
    expect(catastrophicDeny("rm -rf /home/mlpaluser/workspace/r2check")).toBeNull();
    expect(catastrophicDeny("rm -rf /home/mlpaluser/workspace/app/node_modules")).toBeNull();
    expect(catastrophicDeny("rm -rf /Users/me/code/app/build")).toBeNull();
    expect(catastrophicDeny("cd /home/mlpaluser/workspace && rm -rf r2check")).toBeNull();
  });
  test("blocks mkfs, dd-to-device, fork bomb, chmod -R /", () => {
    expect(catastrophicDeny("mkfs.ext4 /dev/sda1")).toBeTruthy();
    expect(catastrophicDeny("dd if=/dev/zero of=/dev/sda")).toBeTruthy();
    expect(catastrophicDeny(":(){ :|:& };:")).toBeTruthy();
    expect(catastrophicDeny("chmod -R 000 /")).toBeTruthy();
  });
  test("catches a catastrophic command hidden in a chain", () => {
    expect(catastrophicDeny("echo ok && rm -rf /")).toBeTruthy();
    expect(catastrophicDeny("ls; mkfs /dev/sdb")).toBeTruthy();
  });
});

describe("contentSafetyDeny", () => {
  test("blocks writes to protected paths", () => {
    expect(contentSafetyDeny(".git/config")).toBeTruthy();
    expect(contentSafetyDeny("repo/.git/hooks/pre-commit")).toBeTruthy();
    expect(contentSafetyDeny("/home/u/.ssh/id_rsa")).toBeTruthy();
    expect(contentSafetyDeny("~/.aws/credentials")).toBeTruthy();
    expect(contentSafetyDeny(".npmrc")).toBeTruthy();
  });
  test("allows normal project files (incl .gitignore)", () => {
    expect(contentSafetyDeny("src/index.ts")).toBeNull();
    expect(contentSafetyDeny(".gitignore")).toBeNull();
    expect(contentSafetyDeny(".github/workflows/ci.yml")).toBeNull();
    expect(contentSafetyDeny("config.ts")).toBeNull();
  });
});

describe("redirectTargets", () => {
  test("finds > >> and tee targets", () => {
    expect(redirectTargets("echo hi > .git/config")).toContain(".git/config");
    expect(redirectTargets("cat x >> ~/.ssh/id_rsa")).toContain("~/.ssh/id_rsa");
    expect(redirectTargets("echo k | tee ~/.aws/credentials")).toContain("~/.aws/credentials");
  });
});

describe("policy integration — safety is bypass-immune", () => {
  test("autopilot cannot run a catastrophic command", () => {
    const policy = createPolicy({ mode: "autopilot" });
    const d = policy(bash("rm -rf /")) as { behavior: string; reason: string };
    expect(d.behavior).toBe("deny");
    expect(d.reason).toContain("blocked");
  });
  test("an explicit allow rule cannot override the safety deny", () => {
    const policy = createPolicy({ mode: "autopilot", allow: ["Bash(rm*)", "Bash"] });
    expect((policy(bash("rm -rf ~")) as { behavior: string }).behavior).toBe("deny");
  });
  test("autopilot cannot write git internals or a redirect into one", () => {
    const policy = createPolicy({ mode: "autopilot" });
    expect((policy(write(".git/config")) as { behavior: string }).behavior).toBe("deny");
    expect((policy(bash("echo x > .git/config")) as { behavior: string }).behavior).toBe("deny");
  });
  test("a deny rule catches a bad sub-command in a chain (autopilot)", () => {
    const policy = createPolicy({ mode: "autopilot", deny: ["Bash(rm*)"] });
    expect((policy(bash("git status && rm important.txt")) as { behavior: string }).behavior).toBe("deny");
  });
  test("normal commands still pass in autopilot", () => {
    const policy = createPolicy({ mode: "autopilot" });
    expect((policy(bash("npm test")) as { behavior: string }).behavior).toBe("allow");
    expect((policy(bash("rm -rf node_modules")) as { behavior: string }).behavior).toBe("allow");
  });
});

describe("rm -rf guard: spellings of a protected folder (review M1)", () => {
  const HOME = "/home/mlpaluser";
  const WS = `${HOME}/workspace`;
  const ctx = { cwd: WS, roots: [WS] };
  let saved: string | undefined;
  const withHome = (fn: () => void) => {
    saved = process.env.HOME;
    process.env.HOME = HOME;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.HOME;
      else process.env.HOME = saved;
    }
  };

  test("a home reached through //, . or .. is still a home", () => {
    for (const target of [
      `${HOME}/workspace/../*`,
      `${HOME}//`,
      "/home//mlpaluser",
      "/home/./mlpaluser",
      `${HOME}/.*`,
      `${HOME}/.`,
      `${HOME}/workspace/..`,
      "/home/mlpaluser/../mlpaluser/",
    ]) {
      expect(catastrophicDeny(`rm -rf ${target}`)).toBe("blocked: recursive-force rm targeting a system/home root");
    }
  });

  test("every spelling of the home folder", () => {
    withHome(() => {
      for (const target of ["~", "~/", "~/*", "~/.*", "~/../*", "$HOME", "$HOME/*", "${HOME}", "${HOME}/*", '"$HOME"', `'${HOME}'`]) {
        expect(catastrophicDeny(`rm -rf ${target}`)).toBeTruthy();
      }
    });
  });

  test("the added system folders: sbin, lib64, proc, opt", () => {
    for (const target of ["/opt", "/opt/mlpal", "/sbin", "/proc", "/lib64", "/bin*"]) {
      expect(catastrophicDeny(`rm -rf ${target}`)).toBe("blocked: recursive-force rm targeting a system/home root");
    }
  });

  test("the session's own folder, its contents, and any folder containing it", () => {
    withHome(() => {
      for (const target of [WS, `${WS}/`, `${WS}/*`, `${WS}/.*`, "/home/*/workspace", "~/workspace", "~/workspace/*", "*", ".", "./*"]) {
        expect(catastrophicDeny(`rm -rf ${target}`, ctx)).toBeTruthy();
      }
      expect(catastrophicDeny(`rm -rf ${WS}`, ctx)).toBe("blocked: recursive-force rm targeting the session's own folder");
      expect(catastrophicDeny("rm -rf ../*", ctx)).toBe("blocked: recursive-force rm targeting a system/home root");
    });
  });

  test("a project folder inside the session's folder stays allowed", () => {
    withHome(() => {
      for (const target of [`${WS}/r2check`, "r2check", "./r2check/", `${WS}/app/node_modules`, "~/workspace/r2check", `${WS}/r2check/*`]) {
        expect(catastrophicDeny(`rm -rf ${target}`, ctx)).toBeNull();
      }
      expect(catastrophicDeny("rm -rf build dist", { cwd: `${WS}/r2check`, roots: [WS] })).toBeNull();
    });
  });

  test("without the session's folders, a project under a home is allowed as before", () => {
    expect(catastrophicDeny(`rm -rf ${WS}/r2check`)).toBeNull();
    expect(catastrophicDeny("rm -rf /Users/me/code/app/build")).toBeNull();
  });

  test("the policy judges relative paths where the shell will run: a removed folder's parent", async () => {
    const { mkdtemp, realpath, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const ws = await realpath(await mkdtemp(join(tmpdir(), "rm-guard-")));
    try {
      const gone = join(ws, "r2check");
      const policy = createPolicy({ mode: "autopilot" });
      const req = (command: string) => ({ ...bash(command), cwd: gone, roots: [ws] });
      const reason = async (command: string) => {
        const d = await policy(req(command));
        return d.behavior === "allow" ? undefined : d.reason;
      };
      expect(await reason("rm -rf *")).toBe("blocked: recursive-force rm targeting the session's own folder");
      expect((await reason(`rm -rf ${join(ws, "other")}`)) ?? "").not.toContain("recursive-force");
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});
