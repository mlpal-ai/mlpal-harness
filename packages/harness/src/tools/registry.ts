import type { ToolSchema } from "../gateway/client";
import { MALFORMED_INPUT_KEY } from "./json";
import type { Tool, ToolContext, ToolResult } from "./types";

export class ToolRegistry {
  private readonly map = new Map<string, Tool<unknown>>();
  private lateResolver?: (name: string) => Promise<void>;

  register(tool: Tool<unknown>): void {
    this.map.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.map.delete(name);
  }

  get(name: string): Tool<unknown> | undefined {
    return this.map.get(name);
  }

  /**
   * Hook for tools that register asynchronously (MCP servers connecting in the
   * background): when a lookup misses, the resolver may await the pending connection,
   * after which the tool is retried. Makes an in-flight connect satisfy a tool call
   * instead of failing it with "Unknown tool".
   */
  setLateResolver(resolver: (name: string) => Promise<void>): void {
    this.lateResolver = resolver;
  }

  /** Get a tool, giving the late-resolver one chance to make it appear. */
  async resolve(name: string): Promise<Tool<unknown> | undefined> {
    const tool = this.map.get(name);
    if (tool || !this.lateResolver) return tool;
    await this.lateResolver(name).catch(() => {});
    return this.map.get(name);
  }

  list(): Tool<unknown>[] {
    return [...this.map.values()];
  }

  /**
   * A new registry containing only tools matching `pred` (profile/agent allowlists).
   * Late resolution is preserved but re-checked against `pred`, so a late-connecting
   * (MCP) tool outside the filter can never appear in the filtered view.
   */
  filter(pred: (t: Tool<unknown>) => boolean): ToolRegistry {
    const out = new ToolRegistry();
    for (const t of this.list()) if (pred(t)) out.register(t);
    const late = this.lateResolver;
    if (late) {
      out.setLateResolver(async (name) => {
        await late(name);
        const t = this.map.get(name);
        if (t && pred(t)) out.register(t);
      });
    }
    return out;
  }

  /** The tool definitions handed to the model as `tools`. */
  schemas(): ToolSchema[] {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema,
    }));
  }
}

/** Validate raw model-supplied input against the tool schema, then execute. */
export async function runTool(
  registry: ToolRegistry,
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = await registry.resolve(name);
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  // The gateway plants this marker when a tool call's JSON was unparseable even leniently —
  // tell the model exactly what it sent so the retry is a correction, not a guess.
  if (rawInput && typeof rawInput === "object" && MALFORMED_INPUT_KEY in rawInput) {
    const raw = String((rawInput as Record<string, unknown>)[MALFORMED_INPUT_KEY]);
    return {
      content:
        `Your ${name} tool call's input was not valid JSON and could not be repaired. ` +
        `Re-send it as well-formed JSON. What you sent (truncated):\n${raw}`,
      isError: true,
    };
  }
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    // Echo what was received: without it, neither the model nor a bug report can tell WHICH
    // character broke — the error was undebuggable from a screenshot.
    let received: string;
    try {
      received = JSON.stringify(rawInput) ?? String(rawInput);
    } catch {
      received = String(rawInput);
    }
    return {
      content:
        `Invalid input for ${name}: ${parsed.error.message}\n` +
        `Received (truncated): ${received.slice(0, 400)}`,
      isError: true,
    };
  }
  try {
    return await tool.call(parsed.data, ctx);
  } catch (e) {
    return { content: `Tool ${name} threw: ${(e as Error).message}`, isError: true };
  }
}
