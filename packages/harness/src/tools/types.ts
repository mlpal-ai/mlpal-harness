import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { ToolResultBlocks } from "@mlpal/harness-protocol";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { host } from "../host";

export interface ToolContext {
  cwd: string;
  /** Allowed filesystem roots for path-based tools. Always includes cwd; extended by
   *  --add-dir. A hard safety rail (independent of permission mode) so file tools can't
   *  read/write outside the workspace — and the basis of tenant isolation in hosted mode. */
  roots?: string[];
  signal?: AbortSignal;
  /** The calling session — for tools that record provenance (e.g. Memorize → memory
   *  graph `subject.chat_id`) or scope by session. */
  sessionId?: string;
}

export interface ToolResult {
  /** A plain string, or rich content blocks (images/documents) the model can read. */
  content: string | ToolResultBlocks;
  isError?: boolean;
  /** Render-only metadata that rides on the ToolResultEvent but is NEVER sent to the model
   *  (kept out of the tool_result blocks). `diff` is a unified patch for Write/Edit. */
  meta?: { diff?: string };
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  /** Read-only tools can be auto-allowed by default policy. */
  readOnly: boolean;
  /** Mutates the workspace by editing files (Write/Edit). Auto-approved in accept-edits
   *  mode — edits are cheap and git-reversible, unlike command execution. */
  edits?: boolean;
  /** Executes arbitrary commands (Bash). The loop sniffs `input.command` on these tools
   *  for verification signals — a capability tag, so profiles with renamed toolsets keep
   *  self-check/anti-churn instead of silently losing them to name matching. */
  executes?: boolean;
  /** v1.1 — this tool can APPLY real-world/infra changes (mutative or destructive). The safety
   *  evaluator (§10) gates these; the specific class (mutative vs destructive) of an individual
   *  call is resolved against the HOP's `safety.toolClasses`, since two tags cannot encode three
   *  classes. A `readOnly`-role subagent is denied every `applies`-tagged tool. */
  applies?: boolean;
  /** v1.1 — this tool touches cloud/infra control planes (aws/az/gcloud/kubectl/terraform via
   *  Bash, or an infra MCP). Pairs with `applies` for the safety envelope; informational for
   *  routing/telemetry. */
  infra?: boolean;
  /** Per-CALL read-only classification for tools whose safety depends on their input
   *  (Agent with read_only/run_in_background). The loop's concurrency gate prefers this
   *  over the static flag; permission policy still uses `readOnly`. */
  isCallReadOnly?: (input: unknown) => boolean;
  schema: z.ZodType<I>;
  /** JSON Schema handed to the model as `input_schema`. Derived from `schema`. */
  jsonSchema: Record<string, unknown>;
  call(input: I, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * Strip JSON-Schema keys some providers reject (Google rejects `additionalProperties`),
 * recursively and in place. The wire schema only needs to guide the model — inputs are
 * re-validated downstream — so dropping these is safe and maximizes portability. Used
 * for built-in tools and for MCP tool schemas alike.
 */
export function sanitizeJsonSchema(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) sanitizeJsonSchema(item);
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    delete o.additionalProperties;
    delete o.$schema;
    for (const v of Object.values(o)) sanitizeJsonSchema(v);
  }
}

export function defineTool<I>(def: {
  name: string;
  description: string;
  readOnly: boolean;
  edits?: boolean;
  executes?: boolean;
  applies?: boolean;
  infra?: boolean;
  isCallReadOnly?: (input: unknown) => boolean;
  schema: z.ZodType<I>;
  call: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}): Tool<I> {
  const js = zodToJsonSchema(def.schema, { $refStrategy: "none" }) as Record<string, unknown>;
  sanitizeJsonSchema(js);
  return {
    name: def.name,
    description: def.description,
    readOnly: def.readOnly,
    edits: def.edits,
    executes: def.executes,
    applies: def.applies,
    infra: def.infra,
    isCallReadOnly: def.isCallReadOnly,
    schema: def.schema,
    jsonSchema: js,
    call: def.call,
  };
}

export function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
}

/** Allowed roots for a context (cwd is always permitted). */
export function contextRoots(ctx: ToolContext): string[] {
  return ctx.roots && ctx.roots.length > 0 ? ctx.roots : [ctx.cwd];
}

/** Realpath of the deepest EXISTING ancestor of `p`, with the non-existent tail re-appended.
 *  Lexical resolve() alone is fooled by a symlink inside the workspace pointing out of it
 *  (`ln -s ~/.ssh link` → `Read("link/id_rsa")` passed the boundary); resolving the real path
 *  of what actually exists on disk closes that escape while still allowing a not-yet-created
 *  file (a Write target) whose parent dir is legitimately inside a root. */
function realResolve(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (let guard = 0; guard < 256; guard++) {
    try {
      return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p); // reached fs root without existence — lexical fallback
      tail.unshift(cur.slice(parent.length + 1));
      cur = parent;
    }
  }
  return resolve(p);
}

/** True if `p` resolves inside one of the allowed roots, after resolving symlinks on the
 *  parts that exist — so a symlink escape out of the workspace is caught. */
export function withinRoots(p: string, roots: string[]): boolean {
  const target = realResolve(p);
  return roots.some((r) => {
    const root = realResolve(r);
    return target === root || target.startsWith(root + sep);
  });
}

/**
 * Resolve `p` against cwd and enforce the workspace boundary. Returns the absolute path,
 * or an error ToolResult (caller returns it directly) when the path escapes the roots.
 */
export function resolveInRoots(
  ctx: ToolContext,
  p: string,
): { path: string } | { error: ToolResult } {
  const roots = contextRoots(ctx);
  const abs = resolvePath(ctx.cwd, p);
  if (!withinRoots(abs, roots)) {
    return {
      error: err(
        `Path is outside the allowed directories: ${p}\n` +
          `Allowed: ${roots.join(", ")}\n` +
          `Grant access by starting ${host().name} with --add-dir <dir>.`,
      ),
    };
  }
  return { path: abs };
}

export function ok(content: string, meta?: ToolResult["meta"]): ToolResult {
  return { content: content || "(no output)", ...(meta ? { meta } : {}) };
}

export function err(content: string): ToolResult {
  return { content, isError: true };
}
