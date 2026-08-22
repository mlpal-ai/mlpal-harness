import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AgentSession } from "../src/loop/agent";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { ToolRegistry } from "../src/tools/registry";
import { defineTool } from "../src/tools/types";

/**
 * Mid-loop peer delivery: a message posted to this session's mailbox WHILE a tool runs must
 * be injected at that tool round's boundary — i.e. the model sees it on its NEXT step, with
 * the run still going — not at the finish boundary after the work is done.
 */
describe("peer messages fold in between tool rounds", () => {
  test("mail posted during a tool round reaches the model before its next turn", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "yodex-peer-mid-"));
    const store = new LocalStore(mkdtempSync(join(tmpdir(), "yodex-peer-store-")));
    const sessionId = "midloop-sess";

    // Slow tool: while it "works", a peer message lands in the mailbox.
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: "SlowProbe",
        description: "test tool",
        readOnly: true,
        schema: z.object({}),
        call: async () => {
          await store.mailbox.post(sessionId, {
            type: "peer_message",
            from: { type: "agent", id: "sess-aaaa", displayName: "other-repo" },
            toSession: sessionId,
            text: "MIDLOOP-PING: acknowledge me",
          });
          return { content: "probe done" };
        },
      }),
    );

    // Turn 1: call the tool. Turn 2: whatever the model sees, finish.
    let turn = 0;
    const seenByModel: string[] = [];
    const client: ModelClient = {
      async *stream(req): AsyncGenerator<never, ModelResult, void> {
        turn++;
        seenByModel.push(JSON.stringify(req.messages));
        if (turn === 1) {
          return {
            model: "test",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "tu_1", name: "SlowProbe", input: {} }],
            },
            usage: { input_tokens: 1, output_tokens: 1 },
            stopReason: "tool_use",
          };
        }
        return {
          model: "test",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
          usage: { input_tokens: 1, output_tokens: 1 },
          stopReason: "end_turn",
        };
      },
    };

    const sess = new AgentSession({
      agentId: "ag1",
      sessionId,
      workspace: "w",
      cwd,
      model: "test",
      systemPrompt: "test",
      tools,
      store,
      model_client: client,
      canUseTool: createPolicy({ mode: "autopilot" }),
      maxTurns: 4,
    });

    const events: Array<{ type: string; author?: unknown; text?: string }> = [];
    for await (const ev of sess.run({ text: "go" })) {
      if (ev.type === "user") {
        const c = (ev as { message: { content: unknown } }).message.content;
        events.push({ type: "user", author: (ev as { author?: unknown }).author, text: typeof c === "string" ? c : JSON.stringify(c) });
      } else if (ev.type === "assistant") {
        events.push({ type: "assistant" });
      }
    }

    // The peer message became an author-tagged user event DURING the run…
    const peerEvent = events.find((e) => e.type === "user" && e.text?.includes("MIDLOOP-PING"));
    expect(peerEvent).toBeDefined();
    expect((peerEvent!.author as { displayName?: string })?.displayName).toBe("other-repo");
    // …and turn 2's model request already contained it (injected at the tool boundary,
    // not after the run finished).
    expect(turn).toBe(2);
    expect(seenByModel[1]).toContain("MIDLOOP-PING");
  });
});
