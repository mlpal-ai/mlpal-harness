import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { DisplayEnvelope, ModelRefusal, SandboxRefusal, SubagentEvent, SubagentStreamEvent, ToolResultBlocks } from "@mlpal/harness-protocol";
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
  /** telemetry v1: the run (turn) the call belongs to; a tool that spawns work or calls a service
   *  stamps it on. */
  runId?: string;
  /** How command-running tools spawn: the execution sandbox (OS confinement + scrubbed env).
   *  Absent = plain spawn with the agent's own environment. */
  exec?: ExecPolicy;
  /** The tool_use id of this call, for a tool that spawns work the stream should attribute to
   *  this step (the Agent tool stamps it on its sub-agent events). */
  toolUseId?: string;
  /** Raise an event on the calling session's stream while this call runs (a sub-agent's
   *  lifecycle, a child's forwarded events). Absent when the host has no stream to carry it. */
  emit?: (e: SubagentEvent | SubagentStreamEvent) => void;
}

/** What a command-running tool consults before it spawns. Implemented by the sandbox. */
export interface ExecPolicy {
  /** Wrap a command's argv in the OS confinement; identity when nothing confines. */
  wrap(argv: string[]): string[];
  /** The environment the child sees. */
  env(): Record<string, string>;
  /** Ruling R22: why the run may not write `path` (absolute), or null. The file tools ask before they write, since
   *  they run in the engine, outside the OS confinement. Absent = nothing is refused. */
  writeDenied?(path: string): string | null;
  /** Ruling R22i: a foreground command runs in its own process group, which the tool kills when the command returns,
   *  so nothing it put in the background outlives it and the checks made at its end (seatbelt has no PID namespace
   *  to do that; bubblewrap's ends with the command). Background tasks are the engine's own feature and keep running. */
  ownGroup?: boolean;
  /** Start watching what the sandbox takes back (R22d, R22g) for something that holds no lease (a durable monitor);
   *  `settle` when it ends answers what was removed. */
  watch?(): { settle(): string[] };
  /** Run those checks now, for everything still running under the sandbox (R22i: a background task writes after the
   *  command that started it returned): before the engine's own git, when a task's output is read, at close.
   *  Answers what was removed. */
  check?(): string[];
  /** What to add to a failed command's output when the failure is the sandbox's doing and the OS's message does not
   *  say what to do about it (R22b: a git command that needs `.git/config`). Null when there is nothing to add. */
  explain?(output: string): string | null;
  /** A command's own environment, held for the life of its process: what `env()` gives plus anything granted to this
   *  one command (D-55: a governed kube mutation's one-time capability). The tool calls `release` once the process
   *  exits, however it ends. Absent, every command sees `env()`. */
  lease?(command: string): ExecLease;
}

/** One command's environment and the hold behind it (`ExecPolicy.lease`). */
export interface ExecLease {
  env: Record<string, string>;
  /** Called once the process exits. Answers the paths the sandbox removed because the command created them where it
   *  may not (ruling R22d); the tool reports the command as failed and names them. */
  release(): string[] | void;
}

/** Kill a command's own process group (R22i: what it left in the background must not outlive it). No-op without a
 *  pid, or when the group is already gone. */
export function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** What a tool appends to a command's output when the sandbox took back what it left behind (R22d: a protected path
 *  it created; R22g: an index entry naming a path inside `.git`). */
export function revertedNotice(removed: string[]): string {
  return `[sandbox: this command left behind ${removed.length === 1 ? "something" : `${removed.length} things`} the harness or git would later load or run with your authority, which a sandboxed session may not create. Removed: ${removed.join(", ")}. The command is reported as failed.]`;
}

/** The environment for one command under `exec`, and the release the caller owes when the process exits. */
export function leaseFor(exec: ExecPolicy, command: string): ExecLease {
  return exec.lease ? exec.lease(command) : { env: exec.env(), release: () => {} };
}

export interface ToolResult {
  /** A plain string, or rich content blocks (images/documents) the model can read. */
  content: string | ToolResultBlocks;
  isError?: boolean;
  /** Render-only metadata that rides on the ToolResultEvent but is NEVER sent to the model
   *  (kept out of the tool_result blocks). `diff` is a unified patch for Write/Edit. `refused` marks
   *  a result the TOOL's own boundary produced (the permission cascade had allowed the call), so
   *  the attempt trace records the effective outcome as a denial, not an access. */
  meta?: {
    diff?: string;
    refused?: "outside_roots";
    /** the step named a model the HOP may not use */
    refusal?: ModelRefusal;
    /** 0.22.4: the remote sandbox had no capacity for the call */
    sandboxRefusal?: SandboxRefusal;
    /** 0.27.0: what the call showed the person (Show), copied onto the event like `diff` */
    display?: DisplayEnvelope[];
    /** The step's display string when it is not what the model reads: Show's model reads a short line, while a client
     *  that draws no display shows the line and the fallback. Absent = the display string is derived from `content`. */
    displayText?: string;
  };
}

/**
 * Where a tool's model-chosen paths, commands, URLs and code land:
 * - `pure`: nowhere outside the engine's own state and its platform services at fixed endpoints (the gateway, the
 *   session store, the scheduler, the memory store); no model input names a path, command, URL or code that reaches the
 *   host's filesystem, processes or network;
 * - `routed`: only a remote sandbox (its execs and fs) or the egress proxy;
 * - `local`: the host itself (its filesystem, its processes, its network).
 * A host with no local hands (an engine pod) offers only `pure` and `routed` tools (ToolRegistry.restrictHands), and
 * a tool without a class is refused there like a `local` one.
 */
export type ToolHands = "pure" | "routed" | "local";

export interface Tool<I = unknown> {
  name: string;
  description: string;
  /** See ToolHands. Absent = unclassified: admitted only by a registry nobody restricted. */
  hands?: ToolHands;
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
  /** Writes the run's working MEMORY (claims to the memory service), never the estate or the
   *  workspace. Memory is not a change the modes guard: recon admits it, the safety envelope
   *  classes it read-only unless the HOP lists it explicitly, and the actions risk gate ignores
   *  it — the same standing the builtin Memorize tool has. Set by the host on the tools of the
   *  MCP server it names as the memory server (memory v6, E5). */
  memory?: boolean;
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
    // Gemini's function-declaration schema rejects the draft-2020 exclusive bounds outright
    // (a whole run on gemini-3.8-flash died on an MCP tool's `id: exclusiveMinimum 0`). Fold them
    // into the inclusive bounds every provider accepts; the semantics differ by one unit at the
    // edge, which no tool argument has ever hinged on.
    if (typeof o.exclusiveMinimum === "number") {
      if (typeof o.minimum !== "number") o.minimum = o.exclusiveMinimum;
      delete o.exclusiveMinimum;
    }
    if (typeof o.exclusiveMaximum === "number") {
      if (typeof o.maximum !== "number") o.maximum = o.exclusiveMaximum;
      delete o.exclusiveMaximum;
    }
    for (const v of Object.values(o)) sanitizeJsonSchema(v);
  }
}

export function defineTool<I>(def: {
  name: string;
  description: string;
  hands?: ToolHands;
  readOnly: boolean;
  edits?: boolean;
  executes?: boolean;
  applies?: boolean;
  infra?: boolean;
  memory?: boolean;
  isCallReadOnly?: (input: unknown) => boolean;
  schema: z.ZodType<I>;
  call: (input: I, ctx: ToolContext) => Promise<ToolResult>;
}): Tool<I> {
  const js = zodToJsonSchema(def.schema, { $refStrategy: "none" }) as Record<string, unknown>;
  sanitizeJsonSchema(js);
  return {
    name: def.name,
    description: def.description,
    ...(def.hands ? { hands: def.hands } : {}),
    readOnly: def.readOnly,
    edits: def.edits,
    executes: def.executes,
    applies: def.applies,
    infra: def.infra,
    memory: def.memory,
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
export function realResolve(p: string): string {
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
      error: {
        ...err(
          `Path is outside the allowed directories: ${p}\n` +
            `Allowed: ${roots.join(", ")}\n` +
            `Grant access by starting ${host().name} with --add-dir <dir>.`,
        ),
        meta: { refused: "outside_roots" },
      },
    };
  }
  return { path: abs };
}

export function ok(content: string, meta?: ToolResult["meta"]): ToolResult {
  return { content: content || "(no output)", ...(meta ? { meta } : {}) };
}

export function err(content: string, meta?: ToolResult["meta"]): ToolResult {
  return { content, isError: true, ...(meta ? { meta } : {}) };
}
