import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@mlpal/harness-protocol";
import { DeltaCoalescer } from "../src/store/remote/coalescer";
import { FakeClock } from "./fake-clock";

function setup() {
  const clock = new FakeClock();
  const out: EngineEvent[] = [];
  const c = new DeltaCoalescer({ sink: (e) => out.push(e), timers: clock });
  return { clock, out, c };
}

const text = (t: string): EngineEvent => ({ type: "text_delta", text: t });
const thinking = (t: string): EngineEvent => ({ type: "thinking_delta", text: t });

describe("DeltaCoalescer", () => {
  test("consecutive text deltas become one event per 250 ms window", () => {
    const { clock, out, c } = setup();
    c.push(text("a"));
    clock.advance(100);
    c.push(text("b"));
    c.push(text("c"));
    clock.advance(149);
    expect(out).toEqual([]);
    clock.advance(1);
    expect(out).toEqual([text("abc")]);
    c.push(text("d"));
    clock.advance(249);
    c.push(text("e"));
    clock.advance(1);
    expect(out).toEqual([text("abc"), text("de")]);
    expect(clock.pending()).toBe(0);
  });

  test("a change of delta kind ends the window; thinking merges like text", () => {
    const { clock, out, c } = setup();
    c.push(thinking("x"));
    c.push(thinking("y"));
    c.push(text("a"));
    expect(out).toEqual([thinking("xy")]);
    c.push(text("b"));
    clock.advance(250);
    expect(out).toEqual([thinking("xy"), text("ab")]);
  });

  test("flush emits the open window at once and cancels its timer; an empty flush emits nothing", () => {
    const { clock, out, c } = setup();
    c.push(text("a"));
    c.flush();
    expect(out).toEqual([text("a")]);
    expect(clock.pending()).toBe(0);
    c.flush();
    clock.advance(1000);
    expect(out).toEqual([text("a")]);
  });

  test("every other frame passes through unchanged and in order, after the deltas before it", () => {
    const { clock, out, c } = setup();
    const start: EngineEvent = { type: "tool_use_start", id: "tu1", name: "Bash" };
    const reset: EngineEvent = { type: "reset" };
    const asst = { type: "assistant", message: { role: "assistant", content: "hi" }, ts: "t" } as EngineEvent;
    c.push(text("a"));
    c.push(start);
    c.push(text("b"));
    c.push(reset);
    c.push(asst);
    expect(out).toEqual([text("a"), start, text("b"), reset, asst]);
    expect(out[1]).toBe(start);
    expect(out[4]).toBe(asst);
    expect(clock.pending()).toBe(0);
  });
});
