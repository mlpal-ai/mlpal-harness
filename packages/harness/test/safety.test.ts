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
