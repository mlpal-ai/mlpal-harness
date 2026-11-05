import { describe, expect, test } from "bun:test";
import { ABUSE_MARKER_PREFIX, MarkerHoldback, stripAbuseMarker } from "../src/index";

const msg = (...texts: string[]) => ({ role: "assistant" as const, content: texts.map((text) => ({ type: "text" as const, text })) });

describe("C1 §7.4: the HOP's trailing abuse marker", () => {
  test("a trailing marker line is stripped and its reason returned", () => {
    expect(stripAbuseMarker(msg("I can only help with MLPal.\n[[mlpal:abuse reason=off_topic]]"))).toEqual({ message: msg("I can only help with MLPal."), reason: "off_topic" });
    expect(stripAbuseMarker(msg("No.\n[[mlpal:abuse reason=injection]]  \n"))).toEqual({ message: msg("No."), reason: "injection" });
  });

  test("only the last text block's last line counts; a marker elsewhere is text", () => {
    const mid = msg("[[mlpal:abuse reason=spam]]\nthen more");
    expect(stripAbuseMarker(mid)).toEqual({ message: mid, reason: null });
    const twoBlocks = msg("[[mlpal:abuse reason=spam]]", "answer");
    expect(stripAbuseMarker(twoBlocks)).toEqual({ message: twoBlocks, reason: null });
  });

  test("a malformed trailing marker is stripped but raises no flag", () => {
    expect(stripAbuseMarker(msg("No.\n[[mlpal:abuse reason=Bad Reason!]]"))).toEqual({ message: msg("No."), reason: null });
  });

  test("no marker: the message is returned as it was", () => {
    const m = msg("Here are your agents.");
    expect(stripAbuseMarker(m).message).toBe(m);
  });

  test("the stream holds back a trailing [[mlpal: line until it is complete, and drops a complete marker", () => {
    const h = new MarkerHoldback();
    const out = ["Sorry, ", "I can't help.\n[[ml", "pal:abuse reason=", "off_topic]]"].map((t) => h.push(t));
    expect(out.join("")).toBe("Sorry, I can't help.\n");
    expect(h.flush()).toBe("");
  });

  test("a held line that turns out not to be the marker is released", () => {
    const h = new MarkerHoldback();
    expect(h.push("see [[x]]\n[")).toBe("see [[x]]\n");
    expect(h.push("note] done\n")).toBe("[note] done\n");
    expect(h.push("[[mlpal:reveal kind=api_key")).toBe("");
    expect(h.flush()).toBe("[[mlpal:reveal kind=api_key");
    expect(ABUSE_MARKER_PREFIX).toBe("[[mlpal:abuse");
  });
});
