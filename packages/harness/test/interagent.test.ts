import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentAuthor, type EngineEvent, type PeerMessage } from "@mlpal/harness-protocol";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { AgentSession } from "../src/loop/agent";
import { createPolicy } from "../src/permission/engine";
import { LocalStore } from "../src/store/local";
import { defaultRegistry } from "../src/tools";

let root: string;
beforeEach(() => {
  root = join(tmpdir(), `yodex-ia-${crypto.randomUUID()}`);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function text(t: string): ModelResult {
  return {
    model: "test",
    message: { role: "assistant", content: [{ type: "text", text: t }] },
    usage: { input_tokens: 5, output_tokens: 3 },
    stopReason: "end_turn",
  };
}

class Scripted implements ModelClient {
  private i = 0;
  readonly seen: string[] = [];
  constructor(private readonly out: ModelResult[]) {}
  async *stream(req: { messages: { content: unknown }[] }): AsyncGenerator<never, ModelResult, void> {
    const last = req.messages.at(-1)?.content;
    this.seen.push(typeof last === "string" ? last : JSON.stringify(last));
    return this.out[Math.min(this.i++, this.out.length - 1)]!;
  }
}

async function collect(gen: AsyncGenerator<EngineEvent, void, void>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("mailbox primitive", () => {
  test("post, peek, atomic drain", async () => {
    const store = new LocalStore(root);
    const msg: PeerMessage = {
      type: "peer_message",
      from: agentAuthor("reviewer"),
      toSession: "b",
      text: "hello",
    };
    await store.mailbox.post("b", msg);
    expect(await store.mailbox.peek("b")).toHaveLength(1);
    const drained = await store.mailbox.drain("b");
    expect(drained).toHaveLength(1);
    expect(drained[0]!.text).toBe("hello");
    // drained clears the mailbox
    expect(await store.mailbox.drain("b")).toHaveLength(0);
  });
});

describe("inter-agent collaboration", () => {
  test("a peer message is injected as an author-tagged turn and processed", async () => {
    const store = new LocalStore(root);

    // reviewer (agent A) posts guidance into builder (B)'s mailbox before B runs.
    await store.mailbox.post("sessB", {
      type: "peer_message",
      from: agentAuthor("reviewer", "reviewer"),
      toSession: "sessB",
      text: "Also handle the empty-input edge case before finishing.",
    });

    const model = new Scripted([text("Implemented the feature."), text("Handled the edge case.")]);
    const builder = new AgentSession({
      agentId: "builder",
      sessionId: "sessB",
      workspace: "w",
      cwd: root,
      model: "test",
      systemPrompt: "You are the builder.",
      tools: defaultRegistry(),
      store,
      model_client: model,
      canUseTool: createPolicy({ mode: "autopilot" }),
    });

    const events = await collect(builder.run({ text: "Build the feature." }));

    // the reviewer's message appears in B's stream as an agent-authored user turn
    const peerTurn = events.find(
      (e): e is Extract<EngineEvent, { type: "user" }> =>
        e.type === "user" && e.author.type === "agent",
    );
    expect(peerTurn).toBeTruthy();
    const content = peerTurn?.message.content ?? "";
    expect(typeof content === "string" ? content : JSON.stringify(content)).toContain("edge case");

    // builder actually processed it (a second model turn happened after the injection)
    expect(model.seen.length).toBe(2);

    // and it's durable in B's transcript — which reviewer A can read from the shared store
    const transcript = await new LocalStore(root).conversation.read("sessB");
    const agentAuthored = transcript.filter(
      (e) => e.payload.type === "user" && e.payload.author.type === "agent",
    );
    expect(agentAuthored).toHaveLength(1);

    const result = events.find((e) => e.type === "result");
    expect(result && "subtype" in result ? result.subtype : "").toBe("success");
  });
});
