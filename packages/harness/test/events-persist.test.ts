import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentEvent, EventInbox } from "../src/events/inbox";
import { persistInbox, restoreInbox } from "../src/events/persist";

function ev(over: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    source: "mon1",
    sourceType: "monitor",
    kind: "complete",
    label: "watch",
    body: "done",
    ts: 1,
    ...over,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yodex-evpersist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("event persistence", () => {
  test("crash with a pending event → resume delivers it exactly once", async () => {
    // Session 1: an event arrives but is never drained (crash before the next boundary).
    const inbox1 = new EventInbox();
    const p1 = persistInbox(dir, "s1", inbox1, () => []);
    inbox1.emit(ev({ id: "pending-1", body: "unseen result" }));
    await p1.flush();

    // Session 2 (the restart): the event is there…
    const inbox2 = new EventInbox();
    const restored = await restoreInbox(dir, "s1", inbox2);
    expect(restored).toBe(1);
    const drained = inbox2.drain();
    expect(drained.length).toBe(1);
    expect(drained[0]!.body).toBe("unseen result");
    // …a producer replay of the same id is deduped…
    expect(inbox2.emit(ev({ id: "pending-1" }))).toBe(false);
    // …and a THIRD restore from the same file doesn't re-queue it (ids stay in seen).
    const p2 = persistInbox(dir, "s1", inbox2, () => []);
    await p2.flush();
    const inbox3 = new EventInbox();
    await restoreInbox(dir, "s1", inbox3);
    expect(inbox3.drain().find((e) => e.id === "pending-1")).toBeUndefined();
  });

  test("delivered-then-crash → resume does NOT re-deliver (drain state persisted)", async () => {
    const inbox1 = new EventInbox();
    const p1 = persistInbox(dir, "s1", inbox1, () => []);
    inbox1.emit(ev({ id: "seen-1" }));
    inbox1.drain(); // injected into the conversation before the crash
    await p1.flush();

    const inbox2 = new EventInbox();
    const restored = await restoreInbox(dir, "s1", inbox2);
    expect(restored).toBe(0);
    expect(inbox2.size()).toBe(0);
    expect(inbox2.emit(ev({ id: "seen-1" }))).toBe(false); // replay still deduped
  });

  test("work live at crash time becomes ONE interrupted error event, idempotent across restores", async () => {
    const inbox1 = new EventInbox();
    const p1 = persistInbox(dir, "s1", inbox1, () => [
      { id: "mon3", kind: "monitor", label: "watch CI" },
    ]);
    inbox1.emit(ev({ id: "any" })); // trigger a save cycle
    await p1.flush();

    const inbox2 = new EventInbox();
    await restoreInbox(dir, "s1", inbox2);
    const events = inbox2.drain();
    const interrupted = events.find((e) => e.id === "mon3#interrupted")!;
    expect(interrupted.kind).toBe("error");
    expect(interrupted.body).toContain("did not survive the restart");

    // Restore again into the same inbox (double-attach) — no duplicate marker.
    await restoreInbox(dir, "s1", inbox2);
    expect(inbox2.drain().find((e) => e.id === "mon3#interrupted")).toBeUndefined();
  });

  test("debounced auto-save fires without an explicit flush", async () => {
    const inbox = new EventInbox();
    persistInbox(dir, "s1", inbox, () => []);
    inbox.emit(ev({ id: "auto" }));
    await new Promise((r) => setTimeout(r, 500)); // > SAVE_DEBOUNCE_MS
    const raw = await readFile(join(dir, "s1.events.json"), "utf8");
    expect(raw).toContain("auto");
  });

  test("a corrupt persisted file is dropped, not resurrected", async () => {
    await writeFile(join(dir, "s1.events.json"), "{ torn json", "utf8");
    const inbox = new EventInbox();
    const restored = await restoreInbox(dir, "s1", inbox);
    expect(restored).toBe(0);
    expect(inbox.size()).toBe(0);
    // the bad file is gone — the next restore is a clean no-op
    expect(await restoreInbox(dir, "s1", new EventInbox())).toBe(0);
  });

  test("no persisted file → clean zero", async () => {
    expect(await restoreInbox(dir, "never-existed", new EventInbox())).toBe(0);
  });
});
