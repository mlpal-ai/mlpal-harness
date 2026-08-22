import { describe, expect, test } from "bun:test";
import type { ModelClient, ModelResult } from "../src/gateway/client";
import { suggestCompletion } from "../src/input/suggest";

/** A model client that returns a fixed reply, and records the request it was given. */
class Fixed implements ModelClient {
  readonly seen: { system?: string; content: unknown }[] = [];
  constructor(private readonly reply: string) {}
  async *stream(req: { system?: string; messages: { content: unknown }[] }): AsyncGenerator<never, ModelResult, void> {
    this.seen.push({ system: req.system, content: req.messages.at(-1)?.content });
    return {
      model: "cheap",
      message: { role: "assistant", content: [{ type: "text", text: this.reply }] },
      usage: { input_tokens: 6, output_tokens: 2 },
      stopReason: "end_turn",
    };
  }
}

class Throws implements ModelClient {
  async *stream(): AsyncGenerator<never, ModelResult, void> {
    throw new Error("gateway down");
  }
}

const run = (reply: string, draft: string, context?: string) =>
  suggestCompletion({ model_client: new Fixed(reply), model: "cheap", draft, context });

describe("suggestCompletion", () => {
  test("returns the continuation, joined with a space when both sides are words", async () => {
    expect(await run("for the parser", "add tests")).toBe(" for the parser");
  });

  test("does not add a space when the join is non-word (e.g. closing a call)", async () => {
    expect(await run(")", "wrap it in foo(")).toBe(")");
  });

  test("takes only the first line and strips wrapping quotes", async () => {
    expect(await run('"and a changelog entry"\nplus more', "also add docs")).toBe(" and a changelog entry");
  });

  test("rejects an echo of what's already typed", async () => {
    expect(await run("add tests", "add tests")).toBeNull();
    expect(await run("tests", "add tests")).toBeNull(); // draft already ends with it
  });

  test("empty draft and empty reply both yield null", async () => {
    expect(await run("something", "   ")).toBeNull();
    expect(await run("", "add tests")).toBeNull();
  });

  test("fails safe to null when the model call throws", async () => {
    expect(
      await suggestCompletion({ model_client: new Throws(), model: "cheap", draft: "add tests" }),
    ).toBeNull();
  });

  test("passes the recent context through to the model", async () => {
    const client = new Fixed("to the config loader");
    await suggestCompletion({ model_client: client, model: "cheap", draft: "add validation", context: "Agent: touched config.ts" });
    expect(JSON.stringify(client.seen[0]!.content)).toContain("config.ts");
  });
});
