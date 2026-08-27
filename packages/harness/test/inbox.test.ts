import { describe, expect, test } from "bun:test";
import { type AgentEvent, EventInbox } from "../src/events/inbox";

function ev(over: Partial<AgentEvent> & { id: string }): AgentEvent {
  return {
    source: "bg1",
    sourceType: "shell",
    kind: "progress",
    label: "npm test",
    body: "running",
    ts: 1,
    ...over,
  };
}

describe("EventInbox", () => {
  test("drain returns events in arrival order and empties the queue", () => {
    const inbox = new EventInbox();
    inbox.emit(ev({ id: "a", source: "s1", kind: "complete" }));
    inbox.emit(ev({ id: "b", source: "s2", kind: "error" }));
    const drained = inbox.drain();
    expect(drained.map((e) => e.id)).toEqual(["a", "b"]);
    expect(inbox.size()).toBe(0);
    expect(inbox.drain()).toEqual([]);
  });

  test("duplicate id is an idempotent no-op — even after drain", () => {
    const inbox = new EventInbox();
    expect(inbox.emit(ev({ id: "x", kind: "complete" }))).toBe(true);
    expect(inbox.emit(ev({ id: "x", kind: "complete" }))).toBe(false);
    expect(inbox.size()).toBe(1);
    inbox.drain();
    // replay after delivery (crash-resume replays a producer) must not re-deliver
    expect(inbox.emit(ev({ id: "x", kind: "complete" }))).toBe(false);
    expect(inbox.size()).toBe(0);
  });

  test("progress coalesces per source — latest wins; other sources untouched", () => {
    const inbox = new EventInbox();
    for (let i = 0; i < 100; i++) inbox.emit(ev({ id: `p${i}`, source: "mon1", body: `step ${i}` }));
    inbox.emit(ev({ id: "other", source: "mon2", body: "other progress" }));
    const drained = inbox.drain();
    expect(drained.length).toBe(2);
    expect(drained[0]!.body).toBe("step 99");
    expect(drained[1]!.source).toBe("mon2");
  });

  test("complete/error never coalesce or drop, even amid progress floods", () => {
    const inbox = new EventInbox();
    inbox.emit(ev({ id: "c1", source: "mon1", kind: "complete", body: "done A" }));
    inbox.emit(ev({ id: "c2", source: "mon1", kind: "complete", body: "done B" }));
    for (let i = 0; i < 300; i++) inbox.emit(ev({ id: `f${i}`, source: `src${i}`, kind: "progress" }));
    const drained = inbox.drain();
    expect(drained.filter((e) => e.kind === "complete").length).toBe(2);
  });

  test("overflow evicts oldest progress first and counts drops", () => {
    const inbox = new EventInbox();
    // 200 distinct-source progress events fill the queue; the next emit evicts the oldest.
    for (let i = 0; i < 200; i++) inbox.emit(ev({ id: `p${i}`, source: `s${i}` }));
    inbox.emit(ev({ id: "last", source: "sLast", kind: "complete" }));
    expect(inbox.size()).toBe(200);
    expect(inbox.droppedCount()).toBe(1);
    const ids = inbox.drain().map((e) => e.id);
    expect(ids).not.toContain("p0"); // oldest progress evicted
    expect(ids).toContain("last"); // terminal event kept
  });

  test("body is capped with a truncation note pointing at detailPath", () => {
    const inbox = new EventInbox();
    inbox.emit(ev({ id: "big", body: "x".repeat(10_000), detailPath: "/tmp/out.log", kind: "complete" }));
    const [e] = inbox.drain();
    expect(e!.body.length).toBeLessThan(2_200);
    expect(e!.body).toContain("[truncated — full output: /tmp/out.log]");
  });

  test("subscribe fires on accepted emits only; a throwing listener never blocks delivery", () => {
    const inbox = new EventInbox();
    const got: string[] = [];
    inbox.subscribe(() => {
      throw new Error("broken listener");
    });
    const un = inbox.subscribe((e) => got.push(e.id));
    inbox.emit(ev({ id: "a", kind: "complete" }));
    inbox.emit(ev({ id: "a", kind: "complete" })); // dup — no callback
    expect(got).toEqual(["a"]);
    expect(inbox.size()).toBe(1);
    un();
    inbox.emit(ev({ id: "b", kind: "complete" }));
    expect(got).toEqual(["a"]); // unsubscribed
  });

  test("snapshot/restore round-trips pending events AND the idempotency filter", () => {
    const inbox = new EventInbox();
    inbox.emit(ev({ id: "delivered", kind: "complete" }));
    inbox.drain();
    inbox.emit(ev({ id: "pending1", source: "s1", kind: "error", body: "boom" }));

    const restored = EventInbox.restore(inbox.snapshot());
    expect(restored.size()).toBe(1);
    expect(restored.peek()[0]!.id).toBe("pending1");
    // both delivered and pending ids stay deduped after restore
    expect(restored.emit(ev({ id: "delivered", kind: "complete" }))).toBe(false);
    expect(restored.emit(ev({ id: "pending1", kind: "error" }))).toBe(false);
    expect(restored.emit(ev({ id: "new", kind: "complete" }))).toBe(true);
  });

  test("concurrent-style interleaved producers lose nothing", () => {
    const inbox = new EventInbox();
    const sources = ["bg1", "bg2", "task1", "mon1", "mon2"];
    for (let round = 0; round < 50; round++) {
      for (const s of sources) inbox.emit(ev({ id: `${s}-p${round}`, source: s }));
    }
    for (const s of sources) inbox.emit(ev({ id: `${s}-done`, source: s, kind: "complete" }));
    const drained = inbox.drain();
    // one coalesced progress + one complete per source
    expect(drained.filter((e) => e.kind === "progress").length).toBe(sources.length);
    expect(drained.filter((e) => e.kind === "complete").length).toBe(sources.length);
    for (const s of sources) {
      expect(drained.find((e) => e.id === `${s}-p49`)).toBeDefined();
      expect(drained.find((e) => e.id === `${s}-done`)).toBeDefined();
    }
  });
});

describe("commandLabel", () => {
  test("multi-line heredoc collapses to one clipped line", async () => {
    const { commandLabel } = await import("../src/events/inbox");
    const cmd = "cd ~/Downloads/Coding/mlpal/pitch && python3 - <<'PY' > .sol-out.md 2>.sol-err.txt\nimport json,os,urllib.request\nprint('x')\nPY";
    const label = commandLabel(cmd);
    expect(label).not.toContain("\n");
    expect(label.length).toBeLessThanOrEqual(64);
    expect(label.startsWith("cd ~/Downloads/Coding/mlpal/pitch && python3 - <<'PY'")).toBe(true);
    expect(label.endsWith("…")).toBe(true);
  });

  test("short single-line commands pass through untouched", async () => {
    const { commandLabel } = await import("../src/events/inbox");
    expect(commandLabel("npm test")).toBe("npm test");
  });
});
