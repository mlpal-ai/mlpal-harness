import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundTasks } from "../src/tools/builtin/background";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settle = async (pred: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await Bun.sleep(50);
  return pred();
};

describe("background task reaping", () => {
  test("killAll ends a non-durable task's whole process group", async () => {
    const tasks = new BackgroundTasks();
    const t = tasks.start("sleep 30 & sleep 30 & wait", process.cwd(), "s");
    expect(t.pid).toBeDefined();
    await Bun.sleep(150);
    expect(alive(t.pid!)).toBe(true);
    tasks.killAll();
    expect(await settle(() => !alive(t.pid!))).toBe(true);
  });

  test("a SIGTERM that goes through process exit reaps the group; an unhandled one would not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yodex-reap-"));
    const script = join(dir, "host.ts");
    writeFileSync(
      script,
      `import { backgroundTasks } from ${JSON.stringify(join(import.meta.dir, "..", "src", "tools", "builtin", "background.ts"))};
       const t = backgroundTasks.start("sleep 30", process.cwd(), "s");
       if (process.argv[2] === "handled") process.on("SIGTERM", () => process.exit(0));
       console.log(JSON.stringify({ pid: t.pid }));
       setInterval(() => {}, 1000);`,
    );
    const run = async (mode: "handled" | "unhandled") => {
      const child = Bun.spawn(["bun", script, mode], { stdout: "pipe", stderr: "inherit" });
      const reader = child.stdout.getReader();
      const { value } = await reader.read();
      const { pid } = JSON.parse(new TextDecoder().decode(value!).trim()) as { pid: number };
      expect(alive(pid)).toBe(true);
      child.kill("SIGTERM");
      await child.exited;
      const gone = await settle(() => !alive(pid), 2500);
      if (!gone) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // the orphan is ours to clean
        }
      }
      return gone;
    };
    expect(await run("handled")).toBe(true);
    expect(await run("unhandled")).toBe(false); // the bug the serve's signal handlers fix
  }, 20000);
});
