import { describe, expect, test } from "bun:test";
import { ABUSE_MARKER_PREFIX, MarkerHoldback, stripAbuseMarker } from "../src/index";

const msg = (...texts: string[]) => ({ role: "assistant" as const, content: texts.map((text) => ({ type: "text" as const, text })) });
const stream = (chunks: string[]) => {
  const h = new MarkerHoldback();
  return chunks.map((c) => h.push(c)).join("") + h.flush();
};

describe("C1 §7.4: the HOP's abuse marker, wherever the model put it", () => {
  test("a trailing marker line is stripped and its reason returned", () => {
    expect(stripAbuseMarker(msg("I can only help with MLPal.\n[[mlpal:abuse reason=off_topic]]"))).toEqual({ message: msg("I can only help with MLPal."), reason: "off_topic" });
    expect(stripAbuseMarker(msg("No.\n[[mlpal:abuse reason=injection]]  \n"))).toEqual({ message: msg("No."), reason: "injection" });
  });

  test("inline, first, or in another block: every marker is stripped; the first well-formed reason is the one", () => {
    expect(stripAbuseMarker(msg("No. [[mlpal:abuse reason=spam]] I only help with MLPal."))).toEqual({ message: msg("No. I only help with MLPal."), reason: "spam" });
    expect(stripAbuseMarker(msg("[[mlpal:abuse reason=harassment]]\nPlease keep it civil."))).toEqual({ message: msg("Please keep it civil."), reason: "harassment" });
    expect(stripAbuseMarker(msg("a [[mlpal:abuse reason=spam]]", "b [[mlpal:abuse reason=injection]] c"))).toEqual({ message: msg("a", "b c"), reason: "spam" });
    expect(stripAbuseMarker(msg("x [[mlpal:abuse reason=Bad!]] y [[mlpal:abuse reason=off_topic]]"))).toEqual({ message: msg("x y"), reason: "off_topic" });
  });

  test("a malformed marker is stripped and raises no flag; an unclosed one at the end is stripped too", () => {
    expect(stripAbuseMarker(msg("No.\n[[mlpal:abuse reason=Bad Reason!]]"))).toEqual({ message: msg("No."), reason: null });
    expect(stripAbuseMarker(msg("No. [[mlpal:abuse reason=off_top"))).toEqual({ message: msg("No."), reason: null });
  });

  test("no marker: the message is returned as it was", () => {
    const m = msg("Here are your agents: [[x]] and [link].");
    expect(stripAbuseMarker(m).message).toBe(m);
  });

  test("the stream never shows a marker, whole, inline or split across chunks", () => {
    expect(stream(["Sorry, ", "I can't help.\n[[ml", "pal:abuse reason=", "off_topic]]"])).toBe("Sorry, I can't help.\n");
    expect(stream(["No. [", "[mlpal:ab", "use reason=spam]] I only help", " with MLPal."])).toBe("No.  I only help with MLPal.");
    expect(stream(["No. [[mlpal:abuse reason=spam]] ok"])).toBe("No.  ok");
    for (const cut of [1, 3, 7, 12, 20, 28]) {
      const whole = "Hi [[mlpal:abuse reason=injection]] there";
      expect(stream([whole.slice(0, cut), whole.slice(cut)])).not.toContain("mlpal");
    }
  });

  test("brackets that are not a marker are released, in order", () => {
    expect(stream(["see [[x]]\n[", "note] done\n"])).toBe("see [[x]]\n[note] done\n");
    expect(stream(["a list [", "1] and [[mlpal:reveal kind=api_key]]"])).toBe("a list [1] and [[mlpal:reveal kind=api_key]]");
    expect(stream(["ends with ["])).toBe("ends with [");
    expect(ABUSE_MARKER_PREFIX).toBe("[[mlpal:abuse");
  });
});
