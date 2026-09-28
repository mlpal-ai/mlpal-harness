import { estimateTokens } from "../context/compaction";
import type { ToolSchema } from "../gateway/client";
import type { Tool } from "./types";

/**
 * Tool deferral. An MCP server with forty tools costs thousands of tokens of schema on every
 * model call whether or not a tool is used. A deferred tool stays registered and callable
 * but is left out of the `tools` the model sees until ToolSearch loads it; the model learns
 * which servers are deferred from ToolSearch's own description, searches by keyword or exact
 * name, and the matched schemas appear on the next call.
 *
 * One instance per process: which tools are deferred is a property of the tool, and which
 * are loaded is a property of the conversation the host runs — sub-agents inherit both,
 * which costs a sub-agent at most the schemas the main loop already paid for.
 */
export class DeferredTools {
  private readonly deferred = new Map<string, string>(); // tool name → server
  private readonly loaded = new Set<string>();

  defer(name: string, server: string): void {
    this.deferred.set(name, server);
  }

  /** A server that disconnects takes its deferral entries with it. */
  forget(name: string): void {
    this.deferred.delete(name);
    this.loaded.delete(name);
  }

  isDeferred(name: string): boolean {
    return this.deferred.has(name);
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  /** Whether a tool's schema is shown to the model. */
  visible = (t: Tool<unknown>): boolean => !this.deferred.has(t.name) || this.loaded.has(t.name);

  load(names: string[]): void {
    for (const n of names) if (this.deferred.has(n)) this.loaded.add(n);
  }

  /** Deferred tools not yet loaded, grouped by server. */
  pending(): { server: string; names: string[] }[] {
    const by = new Map<string, string[]>();
    for (const [name, server] of this.deferred) {
      if (this.loaded.has(name)) continue;
      by.set(server, [...(by.get(server) ?? []), name]);
    }
    return [...by.entries()].map(([server, names]) => ({ server, names: names.sort() }));
  }

  get size(): number {
    return this.deferred.size;
  }
}

/** Estimated prompt tokens a set of tool schemas costs on every model call. */
export function schemaTokens(tools: Tool<unknown>[]): number {
  return estimateTokens(JSON.stringify(tools.map((t): ToolSchema => ({ name: t.name, description: t.description, input_schema: t.jsonSchema }))));
}
