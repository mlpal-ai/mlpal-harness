import { describe, expect, test } from "bun:test";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { answerAside } from "../src/input/aside";

class Fixed implements ModelClient {
  readonly seen: { system?: string; content: unknown }[] = [];
  constructor(private readonly reply: string) {}
  async *stream(req: { system?: string; messages: { content: unknown }[] }): AsyncGenerator<never, ModelResult, void> {
    this.seen.push({ system: req.system, content: req.messages.at(-1)?.content });
    return {
      model: "cheap",
      message: { role: "assistant", content: [{ type: "text", text: this.reply }] },
      usage: { input_tokens: 20, output_tokens: 10 },
      stopReason: "end_turn",
    };
  }
}

class Throws implements ModelClient {
  async *stream(): AsyncGenerator<never, ModelResult, void> {
    throw new Error("gateway down");
  }
}

describe("answerAside", () => {
  test("returns the model's brief answer", async () => {
    const a = await answerAside({ model_client: new Fixed("It uses bun test."), model: "cheap", question: "what runs the tests?" });
    expect(a).toBe("It uses bun test.");
  });

  test("grounds the answer in the provided transcript", async () => {
    const client = new Fixed("about 40k tokens");
    await answerAside({ model_client: client, model: "cheap", question: "how big is the context", transcript: "Agent: loaded 40k tokens of files" });
    const sent = JSON.stringify(client.seen[0]!.content);
    expect(sent).toContain("40k tokens of files");
    expect(sent).toContain("how big is the context");
  });

  test("an empty question is a no-op, not a model call", async () => {
    expect(await answerAside({ model_client: new Fixed("x"), model: "cheap", question: "   " })).toBe("(no question)");
  });

  test("fails safe to a short string instead of throwing", async () => {
    const a = await answerAside({ model_client: new Throws(), model: "cheap", question: "anything?" });
    expect(a).toBe("(couldn't answer that just now)");
  });
});
