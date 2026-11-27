import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DisplayCaps, EngineEvent } from "@mlpal/harness-protocol";
import { GatewayError, type ModelClient, type ModelRequest, type ModelResult } from "../../../src/gateway/client";
import { AgentSession } from "../../../src/loop/agent";
import { createPolicy } from "../../../src/permission/engine";
import { LocalStore } from "../../../src/store/local";
import { defaultRegistry } from "../../../src/tools";

/**
 * A run by a client that says nothing about display: one Read, then an answer. Everything random or
 * machine-specific (uuids, times, the temp directory) is replaced by a fixed token, so the recording is comparable
 * across engines. `no-display-run.golden.json` is this recording made on origin/main 9ede1ea, before the display
 * protocol existed: the contract is that such a client sees exactly that, byte for byte.
 */
export interface NoDisplayRecording {
  events: unknown[];
  requests: unknown[];
}

class Scripted implements ModelClient {
  private i = 0;
  readonly seen: ModelRequest[] = [];
  constructor(private readonly scripts: ModelResult[]) {}
  async *stream(req: ModelRequest): AsyncGenerator<never, ModelResult, void> {
    this.seen.push(structuredClone({ ...req, signal: undefined }));
    const r = this.scripts[this.i++];
    if (!r) throw new GatewayError("script exhausted", 500);
    return r;
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;

function normalize(x: unknown, root: string): unknown {
  return JSON.parse(JSON.stringify(x).split(root).join("<root>").replace(UUID, "<uuid>").replace(ISO, "<ts>"));
}

/** `display`: what the client declares; one that does not declare the block level must record exactly the golden. */
export async function recordNoDisplayRun(root: string, display?: DisplayCaps): Promise<NoDisplayRecording> {
  const cwd = join(root, "work");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "stock.csv"), "week,onhand\n2026-11-30,2140\n2026-12-07,1340\n");
  const model = new Scripted([
    {
      model: "test",
      message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Read", input: { path: "stock.csv" } }] },
      usage: { input_tokens: 10, output_tokens: 5 },
      stopReason: "tool_use",
    },
    {
      model: "test",
      message: { role: "assistant", content: [{ type: "text", text: "Stock falls from 2,140 to 1,340 in a week." }] },
      usage: { input_tokens: 8, output_tokens: 4 },
      stopReason: "end_turn",
    },
  ]);
  const session = new AgentSession({
    agentId: "ag1",
    sessionId: "s1",
    workspace: "w",
    cwd,
    model: "test",
    systemPrompt: "You are a test.",
    tools: defaultRegistry(),
    store: new LocalStore(root),
    model_client: model,
    canUseTool: createPolicy({ mode: "autopilot" }),
    ...(display ? { display } : {}),
  });
  const events: EngineEvent[] = [];
  for await (const e of session.run({ text: "How fast is stock falling?" })) events.push(e);
  return { events: normalize(events, root) as unknown[], requests: normalize(model.seen, root) as unknown[] };
}
