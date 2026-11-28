import { describe, expect, test } from "bun:test";
import { renderEvents } from "../src/events/inbox";
import { INCOGNITO_FLOOR } from "../src/loop/agent";
import { fitPromptToIncognito } from "../src/memory/prompt-tools";
import { CODING_PEERS_HABIT, CODING_PEERS_INCOGNITO, CODING_SYSTEM_PROMPT } from "../src/profile/builtins/coding";

/** Protocol 0.26.5 (review R2-3): an incognito session is never told to use a tool the way it cannot. */
describe("the prompt as it is true of an incognito session", () => {
  test("memory on: the coding prompt still tells the model to message other sessions and create routines", () => {
    expect(CODING_SYSTEM_PROMPT).toContain(CODING_PEERS_HABIT);
    expect(CODING_SYSTEM_PROMPT).toContain("SendMessage reaches one by workspace name");
    expect(CODING_SYSTEM_PROMPT).toContain("create a routine with ScheduleCreate");
  });

  test("incognito: those sentences become the incognito one; nothing else changes", () => {
    const off = fitPromptToIncognito(CODING_SYSTEM_PROMPT);
    expect(off).not.toContain("SendMessage reaches one by workspace name");
    expect(off).not.toContain("create a routine with ScheduleCreate");
    expect(off).not.toContain("reply with SendMessage");
    expect(off).toContain(CODING_PEERS_INCOGNITO);
    expect(off.replace(CODING_PEERS_INCOGNITO, CODING_PEERS_HABIT)).toBe(CODING_SYSTEM_PROMPT);
    expect(fitPromptToIncognito("a HOP's own prompt")).toBe("a HOP's own prompt");
  });

  test("a peer's mail in an incognito session is not to be answered with SendMessage", () => {
    const mail = { id: "e1", source: "other", sourceType: "peer" as const, kind: "mail" as const, label: "other", body: "hi", ts: 0 };
    expect(renderEvents([mail])).toContain('reply with SendMessage(to="<source>")');
    const off = renderEvents([mail], { incognito: true });
    expect(off).not.toContain("reply with SendMessage");
    expect(off).toContain("cannot message other sessions");
  });

  test("the floor marker mlpal-code-server-base checks for is exported", () => {
    expect(INCOGNITO_FLOOR).toBe(1);
  });
});
