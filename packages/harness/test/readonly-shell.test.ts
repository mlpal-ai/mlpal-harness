import { describe, expect, test } from "bun:test";
import { createPolicy } from "../src/permission/engine";
import { isReadOnlyShell } from "../src/permission/readonly-shell";

const yes = ["pwd", "ls -la", "git status", "git log --oneline -5", "git diff HEAD~1 -- src", "ps aux | grep node", "readlink -f .", "cat package.json | head -20", "which bun && bun --version", "node --version", "find . -name '*.ts' | wc -l", "grep -rn TODO src", "rg --files", "sed -n '1,5p' README.md", "git branch -a", "git stash list", "git remote -v", "git config --get user.name", "env | sort", "env git status", "env", "command -v git", "command git status", "command -p ls", "du -sh .; df -h", "git worktree list", "echo 'a > b'",
  // Port and process inspection (B2 field report: `ss -ltnp` prompted; the image may only have netstat/lsof).
  "ss -ltnp", "netstat -an | grep 8010", "lsof -i :8010", "lsof -nP -iTCP -sTCP:LISTEN",
  // Redirects that never touch the workspace: /dev/null and fd duplication.
  "ls >/dev/null", "lsof -i :8010 > /dev/null", "grep -q foo f 2>/dev/null", "cat f 2>&1 | head", "ps aux 2>&1 >/dev/null", "ls &>/dev/null", "git status 1>&2", "ls>/dev/null"];
const no = ["rm -rf dist", "git status && rm x", "cat a > b", "ls | tee out.txt", "echo $(whoami)", "find . -delete", "find . -name x -exec rm {} \;", "sed -i 's/a/b/' f", "git branch new-branch", "git branch -D old", "git stash", "git stash pop", "git config user.name me", "git log --output=log.txt", "npm test", "node script.js", "python3 -c 'print(1)'", "sudo ls", "xargs rm < list", "sleep 60 &", "ls; echo hi > f", "curl https://x", "eval ls", "git push", "bun run build", "", "   ",
  // `ss -K` closes sockets; a redirect anywhere but /dev/null or an fd still writes; `<` reads from a file we do not model.
  "ss -K dst 1.2.3.4", "ss -ltnpK", "ss --kill", "ls > /dev/nul", "ls >/dev/null/x", "ls 2>/tmp/err", "ls >/dev/null; rm x", "cat </etc/passwd", "ls >&/tmp/x", "ls2>/dev/null", "echo hi > out 2>&1",
  // D-27 round 5: an environment change on the line, a git global option, an rc-reading shell or an undecomposable line
  // is not read-only, even before a read-only program (the decomposer's judgement, as for an allow rule).
  "FOO=1 ls", "PATH=. git status", "PATH=/tmp/x; git status", "env -i git status", "git --no-pager log", "git --exec-path=/tmp/x status", "git --git-dir=/tmp/x status", "git --config-env=core.fsmonitor=EVIL status", "git -C /tmp/x status", "zsh -c 'ls'", "ls 'unbalanced",
  // `env` and `command` run their arguments as a command: that command must be read-only itself.
  "env rm -rf dist", "env touch x", "command rm x", "command -p touch x", "env npm test"];

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
    expect((await cruise(req("env touch x"))).behavior).toBe("ask");
    expect((await cruise(req("command rm x"))).behavior).toBe("ask");
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

/**
 * D-27 round 5, the read-only list swept (controller ruling): an entry that runs, writes or deletes something named in
 * its arguments is read-only only when that part is absent (or, for a wrapper, the command it runs is read-only).
 * Per family: what must ask, the plain form that stays read-only, and (`offList`) forms that asked before and still
 * ask because the program is not on the list (the sweep adds no entries).
 */
const SWEEP: Record<string, { ask: string[]; readOnly: string[]; offList?: string[] }> = {
  wrappers: {
    ask: ["env rm x", "command rm x", "command -p touch x", "arch -x86_64 rm x", "arch -arch arm64 sh", "arch -e PATH=. ls", "nice rm x", "nohup rm x", "timeout 5 rm x", "time rm x", "stdbuf -oL rm x", "xargs rm", "exec rm x", "eval ls", "sudo ls", "doas ls"],
    readOnly: ["env git status", "env", "command -v git", "command git status", "arch"],
    offList: ["nice -n 5 git status", "timeout 5 git status", "xargs -0 cat", "builtin echo x"],
  },
  find: {
    ask: ["find . -exec rm {} ;", "find . -execdir rm {} +", "find . -ok rm {} ;", "find . -okdir rm {} ;", "find . -delete", "find . -fprint out", "find . -fprint0 out", "find . -fprintf out %p", "find . -fls out"],
    readOnly: ["find . -name '*.ts'", "find . -type f -newer x", "find src -maxdepth 2 -print0"],
  },
  "sort, tee and the other entries that write a named file": {
    ask: ["sort -o out f", "sort -ro out f", "sort -oout f", "sort --output=out f", "sort --output out f", "sort --out=x f", "sort --compress-program=sh f", "sort --co=sh f", "tee out", "tee -a out", "tee", "uniq f out", "uniq -c f out", "xxd f out", "xxd -r f out", "file -C -m magic"],
    readOnly: ["sort f", "sort -rn f", "sort -u -k2 f", "sort -t , -k2 f", "uniq f", "uniq -c f", "uniq -f 1 f", "xxd f", "xxd -l 16 f", "file f"],
  },
  "pagers and man": {
    ask: ["less -o log f", "less -Olog f", "less --log-file=x f", "less '+!rm x' f", "less +F f", "less -R f", "more +/x f", "more -d f"],
    readOnly: ["less f", "more f", "less a b"],
    offList: ["man git"],
  },
  awk: {
    ask: ["awk 'BEGIN{system(\"rm x\")}'", "awk 'BEGIN{print 1 > \"x\"}'", "awk 'BEGIN{print 1 >> \"x\"}'", "awk 'BEGIN{print 1 | \"sh\"}'", "awk 'BEGIN{while (getline l < \"f\") n++}'", "awk -f prog.awk f", "awk --file=prog.awk f", "gawk -l ext 'NR==1' f", "gawk -i inc 'NR==1' f", "gawk -E prog.awk f", "gawk '@load \"x\"' f", "awk -v x=1 'NR==1' f", "awk 'NR>1' f", "awk 'NR==1||NR==2' f", "awk 'BEGIN { print 1 > \"x\" }'", "awk 'NR==1 { print | \"sh\" }' f"],
    readOnly: ["awk 'NR==1' f", "awk 'NR==1 { print }' f", "awk -F, 'NR==1' f", "awk -F : 'NR<3' f", "gawk 'NR==1' f", "awk -vn=1 'NR==n' f"],
    offList: ["awk '{print $1}' f"],
  },
  sed: {
    ask: ["sed -n '1e rm x' f", "sed 'e rm x' f", "sed 's/a/b/e' f", "sed 's/a/b/w out' f", "sed -n '1w out' f", "sed -n '1W out' f", "sed -n '/x/w out' f", "sed 'bs/x/;e rm x;/' f", "sed -f s.sed f", "sed --file=s.sed f", "sed -i 's/a/b/' f", "sed -ni p f", "sed -i.bak p f", "sed -Ei p f", "sed -I p f", "sed --in-place p f", "sed --in=p f", "sed '1i hello' f", "sed '/x/r f' f", "sed ':a;N;ba' f", "sed -e p -e 'w out' f",
      // the splitter drops quotes, so a quoted script with a space reaches the check as several words
      "sed 'p; w out' f", "sed -n '1 e rm x' f", "sed 's/a b/c/' f"],
    readOnly: ["sed -n 1p f", "sed -n '1,5p' f", "sed 's/a/b/' f", "sed 's/a/b/g' f", "sed -E 's/a+/b/2' f", "sed -n '/x/,/y/p' f", "sed -e p -e 's/x/y/g' f", "sed '1d' f", "sed -n -e '2{p;q}' f", "sed 's#a#b#gI' f", "sed --expression=p f"],
  },
  "git output and external diff": {
    ask: ["git diff --ext-diff", "git diff --textconv", "git diff --output=x", "git log --output=x", "git log -p --ext-diff", "git show --textconv", "git show --ext-diff HEAD", "git diff-tree --ext-diff HEAD", "git grep -O x", "git grep -Ocat x", "git grep --open-files-in-pager x", "git cat-file --filters HEAD:f", "git cat-file --textconv HEAD:f", "git symbolic-ref HEAD refs/heads/x", "git symbolic-ref -d HEAD", "git symbolic-ref --delete HEAD", "git reflog expire --expire=now --all", "git reflog delete HEAD@{1}", "git branch --edit-description", "git branch --unset-upstream"],
    readOnly: ["git diff HEAD~1", "git log --oneline", "git diff --no-ext-diff", "git log --no-textconv -p", "git show HEAD", "git symbolic-ref HEAD", "git symbolic-ref --short HEAD", "git reflog", "git reflog show", "git grep -n x", "git cat-file -p HEAD", "git branch -a"],
  },
  "version and help that run a file, a target or a script": {
    ask: ["python3 help", "python version", "node version", "node help", "ruby help", "php help", "java help", "make help", "make version", "cmake help", "bun version", "bun help", "yarn version", "deno version", "gcc help", "tsc help", "rustc help", "pnpm version"],
    readOnly: ["python3 --version", "node -v", "make --version", "bun --version", "npm version", "npm help", "go version", "go help", "docker version", "gh help", "cargo help", "kubectl version", "terraform version", "aws help", "pip help", "gcloud version", "az version"],
  },
  "search tools that run a command": {
    ask: ["rg --pre sh x", "rg --pre=sh x", "rg --hostname-bin=sh x", "rg --hostname-bin sh x", "ag --pager sh x", "ag --pager=sh x"],
    readOnly: ["rg x", "rg -n x src", "rg --pre-glob '*.gz' x", "ag x"],
  },
};

describe("D-27 round 5: the read-only list swept", () => {
  for (const [family, { ask, readOnly, offList = [] }] of Object.entries(SWEEP)) {
    test(family, () => {
      const got = (cs: string[]) => Object.fromEntries(cs.map((c) => [c, isReadOnlyShell(c)]));
      const want = (cs: string[], v: boolean) => Object.fromEntries(cs.map((c) => [c, v]));
      expect(got(ask)).toEqual(want(ask, false));
      expect(got(readOnly)).toEqual(want(readOnly, true));
      expect(got(offList)).toEqual(want(offList, false));
    });
  }
});

/**
 * D-27 round 6 (controller ruling 3), cruise with no rules: brace expansion and a backslash rewrite an argument after the
 * check has read it (`find . {-delete,}` runs `find . -delete`; `find . -de\lete` runs `find . -delete`), and `git stash
 * list|show` takes `log`/`diff`'s options that write a file or run a program. Each ran with no prompt on 22701ca too.
 */
const ROUND6: Record<string, { ask: string[]; readOnly: string[] }> = {
  "an unquoted brace expansion or a backslash in an argument": {
    ask: ["find . {-delete,}", "sort {-o,/tmp/x} f", "git log {--output=/tmp/x,}", "rg {--pre=sh,x} .", "less {+!id,f}", "ls {a..c}", "cat {a,b}", "cat x{'a',b}", "find . -de\\lete", "find . -name x\\*", "echo a\\ b", "grep -r 'x' \\-n ."],
    readOnly: ["echo '{a,b}'", "echo \"{a,b}\"", "git log HEAD@{1}", "git stash show -p stash@{0}", "ls a,b", "awk 'NR==1 { print }' f", "sed -n -e '2{p;q}' f"],
  },
  // a backslash inside single quotes is literal: the program receives it as written; elsewhere bash consumes it
  "a backslash is refused outside single quotes only": {
    ask: ["find . -de\\lete", "find . \"-de\\lete\"", "grep \"a\\.b\" f", "echo \\'x' f", "find . -de\"'\"\\l\"'\"ete", "grep 'a' -de\\lete"],
    readOnly: ["grep 'a\\.b' f", "rg '\\bfoo\\b' src", "sed 's/\\./x/' f", "grep 'a\\' f"],
  },
  "git stash list|show take the read subcommands' flag checks": {
    ask: ["git stash show --output=/tmp/x", "git stash show --ext-diff", "git stash show -p --textconv", "git stash list --output=x", "git stash list -p --ext-diff", "git stash show --textconv stash@{0}"],
    readOnly: ["git stash list", "git stash show", "git stash show -p", "git stash list --oneline", "git stash show --stat stash@{0}"],
  },
};

describe("D-27 round 6: cruise reads the argument the program receives", () => {
  for (const [family, { ask, readOnly }] of Object.entries(ROUND6)) {
    test(family, async () => {
      const cruise = createPolicy({ mode: "cruise" });
      const got = async (cs: string[]) => Object.fromEntries(await Promise.all(cs.map(async (c) => [c, isReadOnlyShell(c) || (await cruise({ toolName: "Bash", input: { command: c }, readOnly: false, isEdit: false, principal: { type: "human" } })).behavior === "allow"] as const)));
      const want = (cs: string[], v: boolean) => Object.fromEntries(cs.map((c) => [c, v]));
      expect(await got(ask)).toEqual(want(ask, false));
      expect(await got(readOnly)).toEqual(want(readOnly, true));
    });
  }
});
