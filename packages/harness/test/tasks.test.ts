import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createTaskTools } from "../src/tasks/tools";
import { TaskStore, TaskTracker } from "../src/tasks/tracker";

let dir: string;
beforeEach(async () => {
  dir = join(tmpdir(), `yodex-tasks-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe("TaskTracker", () => {
  test("stable ids, individual updates, ordered list", () => {
    const t = new TaskTracker(join(dir, "s1.json"));
    const a = t.create({ subject: "Research the API" });
    const b = t.create({ subject: "Write the client", description: "retry + backoff", status: "in_progress" });
    expect([a.id, b.id]).toEqual([1, 2]);
    t.update(a.id, { status: "completed" });
    expect(t.get(1)!.status).toBe("completed");
    expect(t.get(2)!.description).toBe("retry + backoff");
    expect(t.list().map((x) => x.id)).toEqual([1, 2]);
    expect(t.update(99, { status: "completed" })).toBeUndefined();
  });

  test("persists and reloads — ids and seq survive a restart", async () => {
    const path = join(dir, "s2.json");
    const t = new TaskTracker(path);
    t.create({ subject: "one" });
    t.create({ subject: "two", status: "in_progress" });
    t.flush();
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.seq).toBe(2);

    const reloaded = new TaskTracker(path);
    expect(reloaded.list().map((x) => x.subject)).toEqual(["one", "two"]);
    const c = reloaded.create({ subject: "three" });
    expect(c.id).toBe(3); // seq continues — no id reuse after restart
  });

  test("snapshot renders the CURRENT plan for compaction; empty plan is null", () => {
    const t = new TaskTracker(join(dir, "s3.json"));
    expect(t.snapshot()).toBeNull();
    t.create({ subject: "alpha", description: "why it matters" });
    const s = t.snapshot()!;
    expect(s).toContain("#1 [pending] alpha — why it matters");
  });
});

describe("TaskStore + tools", () => {
  test("sessions are isolated; tools route by ctx.sessionId", async () => {
    const store = new TaskStore(dir);
    const [create, update, list] = createTaskTools(store);
    const main = { cwd: "/tmp", sessionId: "main" };
    const child = { cwd: "/tmp", sessionId: "child" };

    const r1 = await create!.call({ subject: "Main plan item" } as never, main);
    expect(r1.content).toContain("#1 created");
    await create!.call({ subject: "Child plan item" } as never, child);

    const mainList = await list!.call({} as never, main);
    expect(mainList.content).toContain("Main plan item");
    expect(mainList.content).not.toContain("Child plan item");

    // through the schema, like runTool does — "#1" and "1" coerce to the number 1
    const parsed = update!.schema.parse({ id: "#1", status: "completed" });
    const up = await update!.call(parsed as never, main);
    expect(up.content).toContain("#1 → completed");
    expect(up.content).toContain("1 done");
  });

  test("unknown id errors with the valid ids listed", async () => {
    const store = new TaskStore(dir);
    const [create, update] = createTaskTools(store);
    const ctx = { cwd: "/tmp", sessionId: "s" };
    await create!.call({ subject: "only one" } as never, ctx);
    const res = await update!.call({ id: 7, status: "completed" } as never, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain("No task #7");
    expect(res.content).toContain("#1");
  });
});

describe("hardening", () => {
  test("flushAll writes debounced state immediately (the exit-hook contract)", async () => {
    const store = new TaskStore(dir);
    const t = store.for("exiting");
    t.create({ subject: "last-second mutation" });
    // Within the debounce window nothing is on disk yet — a bare exit would lose it.
    store.flushAll();
    const raw = JSON.parse(await readFile(join(dir, "exiting.json"), "utf8"));
    expect(raw.items[0].subject).toBe("last-second mutation");
  });

  test("empty subjects are rejected at the schema", () => {
    const store = new TaskStore(dir);
    const [create, update] = createTaskTools(store);
    expect(create!.schema.safeParse({ subject: "" }).success).toBe(false);
    expect(update!.schema.safeParse({ id: 1, subject: "" }).success).toBe(false);
    expect(update!.schema.safeParse({ id: 1, status: "completed" }).success).toBe(true);
  });
});
