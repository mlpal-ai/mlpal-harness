import { describe, expect, test } from "bun:test";
import { createPolicy } from "../src/permission/engine";
import { isReadOnlyShell } from "../src/permission/readonly-shell";

const yes = ["pwd", "ls -la", "git status", "git log --oneline -5", "git diff HEAD~1 -- src", "ps aux | grep node", "readlink -f .", "cat package.json | head -20", "which bun && bun --version", "node --version", "find . -name '*.ts' | wc -l", "grep -rn TODO src", "rg --files", "sed -n '1,5p' README.md", "git branch -a", "git stash list", "git remote -v", "git config --get user.name", "env | sort", "FOO=1 ls", "du -sh .; df -h", "git worktree list", "echo 'a > b'"];
const no = ["rm -rf dist", "git status && rm x", "cat a > b", "ls | tee out.txt", "echo $(whoami)", "find . -delete", "find . -name x -exec rm {} \;", "sed -i 's/a/b/' f", "git branch new-branch", "git branch -D old", "git stash", "git stash pop", "git config user.name me", "git log --output=log.txt", "npm test", "node script.js", "python3 -c 'print(1)'", "sudo ls", "xargs rm < list", "sleep 60 &", "ls; echo hi > f", "curl https://x", "eval ls", "git push", "bun run build", "", "   "];

describe("isReadOnlyShell", () => {
  test.each(yes)("read-only: %s", (c) => expect(isReadOnlyShell(c)).toBe(true));
  test.each(no)("not read-only: %s", (c) => expect(isReadOnlyShell(c)).toBe(false));
});

describe("cruise mode", () => {
  const req = (command: string) => ({ toolName: "Bash", input: { command }, readOnly: false, isEdit: false, principal: { type: "human" as const } });
  test("a read-only command runs without a prompt; a mutating one still asks; other modes unchanged", async () => {
    const cruise = createPolicy({ mode: "cruise" });
    expect((await cruise(req("git status"))).behavior).toBe("allow");
    expect((await cruise(req("ps aux | grep serve"))).behavior).toBe("allow");
    expect((await cruise(req("npm test"))).behavior).toBe("ask");
    expect((await cruise(req("git status && rm -rf build"))).behavior).toBe("ask");
    const manual = createPolicy({ mode: "manual" });
    expect((await manual(req("git status"))).behavior).toBe("ask");
    const recon = createPolicy({ mode: "recon" });
    expect((await recon(req("git status"))).behavior).toBe("deny");
  });
  test("the safety guard still wins in cruise", async () => {
    const cruise = createPolicy({ mode: "cruise" });
    expect((await cruise(req("ls && rm -rf /"))).behavior).toBe("deny");
  });
});
