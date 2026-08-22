import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventInbox } from "../src/events/inbox";
import { persistInbox, restoreInbox } from "../src/events/persist";
import { BackgroundTasks } from "../src/tools/builtin/background";

const SID = "durmon-session";

function until(pred: () => boolean, ms = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      if (pred()) {
        clearInterval(t);
        resolve(true);
      } else if (Date.now() - t0 > ms) {
        clearInterval(t);
        resolve(false);
      }
    }, 25);
  });
}

let outDir: string;
let evDir: string;
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), "yodex-durmon-"));
  evDir = await mkdtemp(join(tmpdir(), "yodex-durmon-ev-"));
});
afterEach(async () => {
  await rm(outDir, { recursive: true, force: true });
  await rm(evDir, { recursive: true, force: true });
});

describe("durable monitors", () => {
  test("file-backed output still streams progress and completion; log is tidied after", async () => {
    const inbox = new EventInbox();
    const reg = new BackgroundTasks();
    reg.configureMonitors({ outDir });
    reg.attachInbox(inbox, SID);
    const t = reg.start("echo alpha; sleep 0.4; echo omega", "/tmp", SID, {
      monitor: true,
      timeoutMs: 30_000,
    });
    expect(t.outFile).toBeDefined();
    expect(await until(() => inbox.peek().some((e) => e.kind === "complete"))).toBe(true);
    const done = inbox.drain().find((e) => e.kind === "complete")!;
    expect(done.body).toContain("omega");
    // output file cleaned up once the in-memory buffer holds the result
    expect(await readdir(outDir)).toEqual([]);
    reg.detachInbox();
  });

  test("adopt: a live detached monitor from a 'previous process' is re-attached end-to-end", async () => {
    // Process 1 starts a durable monitor and "dies" (we drop the registry, keep the process).
    const reg1 = new BackgroundTasks();
    reg1.configureMonitors({ outDir });
    const inbox1 = new EventInbox();
    reg1.attachInbox(inbox1, SID);
    const t1 = reg1.start("sleep 1; echo SURVIVED-RESTART", "/tmp", SID, {
      monitor: true,
      timeoutMs: 30_000,
    });
    const persist1 = persistInbox(evDir, SID, inbox1, () => [
      {
        id: t1.id,
        kind: "monitor",
        label: t1.command,
        pid: t1.pid,
        outFile: t1.outFile,
        filePos: t1.filePos,
        startedAt: t1.startedAt,
        timeoutAt: t1.timeoutAt,
      },
    ]);
    inbox1.emit({ id: "seed", source: "x", sourceType: "shell", kind: "progress", label: "x", body: "x", ts: 1 });
    inbox1.drain();
    await persist1.flush();
    reg1.detachInbox(); // "process 1" is gone; the detached child lives on

    // Process 2 restores: the monitor is alive → adopted; its completion arrives normally.
    const reg2 = new BackgroundTasks();
    reg2.configureMonitors({ outDir });
    const inbox2 = new EventInbox();
    reg2.attachInbox(inbox2, SID);
    let adopted = 0;
    await restoreInbox(evDir, SID, inbox2, {
      adopt: (ref) => {
        adopted++;
        reg2.adopt({ id: ref.id, command: ref.label, sessionId: SID, pid: ref.pid, outFile: ref.outFile, filePos: ref.filePos, timeoutAt: ref.timeoutAt });
        return true;
      },
    });
    expect(adopted).toBe(1);
    expect(inbox2.peek().find((e) => e.id.endsWith("#interrupted"))).toBeUndefined();

    expect(await until(() => inbox2.peek().some((e) => e.kind === "complete"))).toBe(true);
    const done = inbox2.drain().find((e) => e.kind === "complete")!;
    expect(done.source).toBe(t1.id);
    expect(done.body).toContain("SURVIVED-RESTART");
    expect(done.body).toContain("exit status unknown"); // honest: we weren't its parent
    reg2.detachInbox();
  });

  test("finished-while-down: dead pid → one complete event with the file tail, file removed", async () => {
    const outFile = join(outDir, "monX-1.log");
    await writeFile(outFile, "line-a\nFINAL-RESULT\n", "utf8");
    const inbox1 = new EventInbox();
    const persist1 = persistInbox(evDir, SID, inbox1, () => [
      { id: "mon9", kind: "monitor", label: "watch thing", pid: 999999999, outFile, filePos: 0 },
    ]);
    inbox1.emit({ id: "seed", source: "x", sourceType: "shell", kind: "progress", label: "x", body: "x", ts: 1 });
    await persist1.flush();

    const inbox2 = new EventInbox();
    await restoreInbox(evDir, SID, inbox2, { adopt: () => true }); // adopt never called: pid is dead
    const events = inbox2.drain();
    const done = events.find((e) => e.id === "mon9#offline-end")!;
    expect(done.kind).toBe("complete");
    expect(done.body).toContain("finished while yodex was not running");
    expect(done.body).toContain("FINAL-RESULT");
    expect(await readdir(outDir)).toEqual([]); // tidied
    // idempotent on a second restore
    await restoreInbox(evDir, SID, inbox2, {});
    expect(inbox2.drain().find((e) => e.id === "mon9#offline-end")).toBeUndefined();
  });

  test("orphan self-kill: with NO yodex process attached, the in-shell timeout guard fires", async () => {
    const reg = new BackgroundTasks();
    reg.configureMonitors({ outDir });
    // No inbox attached, and we never touch the registry again — the process is on its own.
    const t = reg.start("sleep 60", "/tmp", SID, { monitor: true, timeoutMs: 1_000 });
    const pid = t.pid!;
    const alive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(pid)).toBe(true);
    // The guard is `sleep 1 && kill -TERM -$$` inside the detached shell itself.
    expect(await until(() => !alive(pid), 4_000)).toBe(true);
  });

  test("adopted monitor is killable by process group", async () => {
    const reg1 = new BackgroundTasks();
    reg1.configureMonitors({ outDir });
    const inbox1 = new EventInbox();
    reg1.attachInbox(inbox1, SID);
    const t1 = reg1.start("sleep 30", "/tmp", SID, { monitor: true, timeoutMs: 60_000 });
    reg1.detachInbox();

    const reg2 = new BackgroundTasks();
    reg2.configureMonitors({ outDir });
    const inbox2 = new EventInbox();
    reg2.attachInbox(inbox2, SID);
    const adopted = reg2.adopt({ id: t1.id, command: t1.command, sessionId: SID, pid: t1.pid!, outFile: t1.outFile!, timeoutAt: t1.timeoutAt });
    expect(reg2.kill(adopted.id)).toBe(true);
    expect(await until(() => adopted.exitCode !== null)).toBe(true);
    reg2.detachInbox();
  });
});
