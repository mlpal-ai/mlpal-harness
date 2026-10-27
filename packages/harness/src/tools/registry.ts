import type { ToolSchema } from "../gateway/client";
import { MALFORMED_INPUT_KEY } from "./json";
import { redactResult } from "../obs/redact";
import type { Tool, ToolContext, ToolResult } from "./types";

export class ToolRegistry {
  private readonly map = new Map<string, Tool<unknown>>();
  private lateResolver?: (name: string) => Promise<void>;
  /** Which registered tools the model is shown (tool deferral); default: all. */
  private schemaFilter: (t: Tool<unknown>) => boolean = () => true;

  /** Restrict `schemas()` to tools the predicate admits. A tool the filter hides stays
   *  registered and resolvable, but calling it before it is shown is refused (see runTool),
   *  so the model can never call a schema it has not seen. Propagated by filter(). */
  setSchemaFilter(pred: (t: Tool<unknown>) => boolean): void {
    this.schemaFilter = pred;
  }

  /** Whether the model currently sees this tool's schema. */
  shown(t: Tool<unknown>): boolean {
    return this.schemaFilter(t);
  }

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
    out.setSchemaFilter(this.schemaFilter);
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
    return this.list().filter(this.schemaFilter).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema,
    }));
  }
}

/** Keys whose values a validation error's echo of the input never repeats. */
const SECRET_LIKE_KEY = /secret|token|password|api[_-]?key/i;

/** Validate raw model-supplied input against the tool schema, then execute. */
export async function runTool(
  registry: ToolRegistry,
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = await registry.resolve(name);
  if (!tool) return { content: `Unknown tool: ${name}`, isError: true };
  if (!registry.shown(tool)) {
    return { content: `${name} is a deferred tool: load it first with ToolSearch (query "select:${name}"), then call it.`, isError: true };
  }
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
    // A secret sent alongside another schema error would otherwise be repeated verbatim; a number or boolean under
    // such a key (`max_tokens`) is no secret and stays readable.
    let received: string;
    try {
      received = JSON.stringify(rawInput, (k, v) => (k !== "" && SECRET_LIKE_KEY.test(k) && (typeof v === "string" || (typeof v === "object" && v !== null)) ? "[redacted]" : v)) ?? String(rawInput);
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
  // Every result passes the redactor: a registered secret (a loaded key, a scrubbed env value)
  // never reaches the model, the conversation log or the terminal, whichever tool surfaced it.
  try {
    return redactResult(await tool.call(parsed.data, ctx));
  } catch (e) {
    return redactResult({ content: `Tool ${name} threw: ${(e as Error).message}`, isError: true });
  }
}
