/**
 * Remote hands: the file and shell tools of the harness (Bash, BashOutput, Kill, Read, Write,
 * Edit, Glob, Grep, List) backed by a sandbox session instead of the local filesystem, with the
 * same names, schemas and result shapes, so prompts and HOPs need no change
 * (`yodex/docs/harness-profiles/SANDBOX-HANDS.md`).
 *
 * The harness never speaks the sandbox wire protocol itself: it takes a `HandsClient`, which the
 * host adapts from the sandbox SDK (`mlpal-sandbox/sdk/typescript`). Paths are guest paths,
 * relative to the guest working directory (`/workspace` by default); the guest enforces its own
 * roots, and its refusals come back as the tool's error text.
 */
import type { SandboxRefusal } from "@mlpal/harness-protocol";
import { z } from "zod";
import { unifiedDiff } from "../builtin/diff";
import { defineTool, err, ok, type Tool, type ToolResult } from "../types";

export interface HandsExecResult {
  execId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Inline output was capped; the full output is readable by exec id. */
  truncated: boolean;
  state: "running" | "exited" | "killed" | "failed" | "refused";
}

/** What every call carries: the turn's abort signal. A client that waits (a sandbox mid-pause) must not start the
 *  call once it fired: the loop has already answered the tool as interrupted and moved on. */
export interface HandsCallOptions {
  signal?: AbortSignal;
}

export interface HandsExecOptions extends HandsCallOptions {
  cwd?: string;
  timeoutMs?: number;
  detach?: boolean;
  env?: Record<string, string>;
  /** Written to the command's stdin whole (a hook's event JSON). */
  stdin?: string;
}

export interface HandsClient {
  /** Run `argv`; a string runs under `sh -c`. */
  exec(argv: string[] | string, opts?: HandsExecOptions): Promise<HandsExecResult>;
  /** Everything an exec wrote so far, by id; `wait` blocks until it finishes. */
  readOutput(execId: string, opts?: { wait?: boolean } & HandsCallOptions): Promise<HandsExecResult>;
  /** Stop a detached exec. Absent when the service has no kill route yet. */
  killExec?(execId: string, opts?: HandsCallOptions): Promise<void>;
  readFile(path: string, opts?: HandsCallOptions): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string, opts?: HandsCallOptions): Promise<void>;
  listDir(path: string, opts?: HandsCallOptions): Promise<{ name: string; type?: string; is_dir?: boolean }[]>;
}

export interface SandboxHandsOptions {
  client: HandsClient;
  /** The guest working directory relative paths resolve against. */
  cwd?: string;
  /** Inline output cap for Bash, in characters (the tail is kept). */
  maxOutput?: number;
}

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const DEFAULT_READ_LINES = 2000;
const MAX_MATCHES = 200;
const MAX_OUTPUT_DEFAULT = 30_000;

export const GUEST_CWD = "/workspace";

export function guestPath(p: string | undefined, cwd: string): string {
  if (!p || p === ".") return cwd;
  if (p.startsWith("/")) return p;
  return `${cwd.replace(/\/$/, "")}/${p.replace(/^\.\//, "")}`;
}

const shellQuote = (s: string): string => (/^[A-Za-z0-9_./=:,+@-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

function tail(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `[output truncated — showing the last ${max} characters]\n${s.slice(s.length - max)}`, truncated: true };
}

function renderExec(r: HandsExecResult, max: number): ToolResult {
  const combined = r.stderr ? `${r.stdout}${r.stdout && !r.stdout.endsWith("\n") ? "\n" : ""}${r.stderr}` : r.stdout;
  const { text } = tail(combined, max);
  const notes: string[] = [];
  if (r.timedOut) notes.push("[timed out]");
  if (r.truncated) notes.push(`[inline output capped by the sandbox; read the rest with BashOutput ${r.execId}]`);
  const body = [text, ...notes].filter(Boolean).join("\n");
  if (r.state === "running") return ok(`[still running: ${r.execId}]\n${body}`);
  if (r.exitCode === 0 || r.exitCode === null) return ok(body);
  return { content: `[exit ${r.exitCode}]\n${body}`, isError: false };
}

/** The router's capacity reasons (all 429/503 with Retry-After); `rate_limited` is not one. */
export const CAPACITY_REASONS: ReadonlySet<string> = new Set(["quota_global", "quota_tenant", "host_full", "no_hosts"]);

/** The remote sandbox refused for lack of capacity. The host adapter throws it in place of its
 *  SDK's error, so the tools and the host speak one SDK-agnostic type. */
export class HandsCapacityError extends Error {
  constructor(
    readonly reason: SandboxRefusal["reason"],
    readonly retryAfterS: number | null,
    readonly sandboxId?: string,
  ) {
    super(`remote sandbox at capacity (${reason}): ${retryAfterS === null ? "no retry hint" : `retry after ${retryAfterS} s`}`);
    this.name = "HandsCapacityError";
  }

  /** The SandboxRefusal for a tool result or a run result. */
  refusal(): SandboxRefusal {
    return {
      code: "sandbox_capacity",
      reason: this.reason,
      ...(this.retryAfterS === null ? {} : { retryAfterS: this.retryAfterS }),
      ...(this.sandboxId ? { sandboxId: this.sandboxId } : {}),
      message: this.message,
    };
  }
}

const failed = (what: string, e: unknown): ToolResult =>
  e instanceof HandsCapacityError ? err(e.message, { sandboxRefusal: e.refusal() }) : err(`${what}: ${String((e as Error)?.message ?? e)}`);

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

/** The nine tools, over one session. Same names and schemas as the local builtins. */
export function createSandboxHands(opts: SandboxHandsOptions): Tool<unknown>[] {
  const { client } = opts;
  const cwd = opts.cwd ?? GUEST_CWD;
  const maxOutput = opts.maxOutput ?? MAX_OUTPUT_DEFAULT;

  const bash = defineTool({
    name: "Bash",
    hands: "routed",
    description:
      "Execute a shell command in the sandbox's working directory. Returns combined stdout+stderr. Set run_in_background for long-lived commands (dev servers, watchers): returns an exec id immediately; read output later with BashOutput and stop it with Kill. A foreground command that outlives its timeout (default 120s, max 600s) is reported as timed out.",
    readOnly: false,
    executes: true,
    schema: z.object({
      command: z.string(),
      timeout: z.number().int().positive().max(MAX_TIMEOUT).optional().describe(`timeout in ms (default ${DEFAULT_TIMEOUT})`),
      run_in_background: z.boolean().optional().describe("start the command as a background task and return its id immediately"),
    }),
    async call(input, ctx) {
      const signal = ctx.signal;
      try {
        if (input.run_in_background) {
          const r = await client.exec(input.command, { cwd, timeoutMs: MAX_TIMEOUT, detach: true, signal });
          return ok(`Started background task ${r.execId}. Read its output with BashOutput, stop it with Kill.`);
        }
        const r = await client.exec(input.command, { cwd, timeoutMs: input.timeout ?? DEFAULT_TIMEOUT, signal });
        return renderExec(r, maxOutput);
      } catch (e) {
        return failed("sandbox exec failed", e);
      }
    },
  });

  const bashOutput = defineTool({
    name: "BashOutput",
    hands: "routed",
    description: "Read the output so far of a background task started with Bash (run_in_background), by its id.",
    readOnly: true,
    schema: z.object({ id: z.string().describe("exec id from Bash") }),
    async call(input, ctx) {
      try {
        return renderExec(await client.readOutput(input.id, { wait: false, signal: ctx.signal }), maxOutput);
      } catch (e) {
        return failed(`cannot read ${input.id}`, e);
      }
    },
  });

  const kill = defineTool({
    name: "Kill",
    hands: "routed",
    description: "Stop a background task started with Bash (run_in_background).",
    readOnly: false,
    executes: true,
    schema: z.object({ id: z.string() }),
    async call(input, ctx) {
      if (!client.killExec) return err("the sandbox service has no exec kill route yet; the task runs to its timeout");
      try {
        await client.killExec(input.id, { signal: ctx.signal });
        return ok(`Killed ${input.id}`);
      } catch (e) {
        return failed(`cannot kill ${input.id}`, e);
      }
    },
  });

  const read = defineTool({
    name: "Read",
    hands: "routed",
    description: "Read a file from the sandbox. Returns numbered lines. Supports offset/limit for large files.",
    readOnly: true,
    schema: z.object({
      path: z.string().describe("File path (absolute in the guest, or relative to its working directory)"),
      offset: z.number().int().min(1).optional().describe("1-based start line"),
      limit: z.number().int().min(1).optional().describe("max lines to read"),
    }),
    async call(input, ctx) {
      let text: string;
      try {
        text = decode(await client.readFile(guestPath(input.path, cwd), { signal: ctx.signal }));
      } catch (e) {
        return failed(`cannot read ${input.path}`, e);
      }
      const lines = text.split("\n");
      const start = (input.offset ?? 1) - 1;
      const end = input.limit ? start + input.limit : Math.min(lines.length, start + DEFAULT_READ_LINES);
      const numbered = lines.slice(start, end).map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join("\n");
      const truncated = !input.limit && lines.length > end ? `\n[read ${end}/${lines.length} lines — pass offset:${end + 1} to continue, or Grep for a specific match]` : "";
      return ok(numbered + truncated);
    },
  });

  const write = defineTool({
    name: "Write",
    hands: "routed",
    description: "Write a file in the sandbox (creates or overwrites; parent directories are made).",
    readOnly: false,
    edits: true,
    schema: z.object({ path: z.string(), content: z.string() }),
    async call(input, ctx) {
      const path = guestPath(input.path, cwd);
      let before = "";
      try {
        before = decode(await client.readFile(path, { signal: ctx.signal }));
      } catch {
        before = "";
      }
      try {
        await client.writeFile(path, input.content, { signal: ctx.signal });
      } catch (e) {
        return failed(`cannot write ${input.path}`, e);
      }
      const diff = unifiedDiff(before, input.content);
      return ok(`Wrote ${new TextEncoder().encode(input.content).length} bytes to ${input.path}`, diff ? { diff } : undefined);
    },
  });

  const edit = defineTool({
    name: "Edit",
    hands: "routed",
    description: "Replace an exact string in a sandbox file. old_string must be unique unless replace_all is set.",
    readOnly: false,
    edits: true,
    schema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
    async call(input, ctx) {
      const path = guestPath(input.path, cwd);
      let text: string;
      try {
        text = decode(await client.readFile(path, { signal: ctx.signal }));
      } catch (e) {
        return failed(`cannot read ${input.path}`, e);
      }
      const count = text.split(input.old_string).length - 1;
      if (count === 0) return err("old_string not found in file");
      if (count > 1 && !input.replace_all) return err(`old_string is not unique (${count} matches); set replace_all or add context`);
      const next = input.replace_all ? text.split(input.old_string).join(input.new_string) : text.replace(input.old_string, () => input.new_string);
      try {
        await client.writeFile(path, next, { signal: ctx.signal });
      } catch (e) {
        return failed(`cannot write ${input.path}`, e);
      }
      const diff = unifiedDiff(text, next);
      return ok(`Replaced ${input.replace_all ? count : 1} occurrence(s) in ${input.path}`, diff ? { diff } : undefined);
    },
  });

  const rg = async (args: string[], base: string, signal: AbortSignal | undefined): Promise<HandsExecResult> =>
    client.exec(`cd ${shellQuote(base)} && rg ${args.map(shellQuote).join(" ")}`, { cwd, timeoutMs: 20_000, signal });

  const globTool = defineTool({
    name: "Glob",
    hands: "routed",
    description: "Find files in the sandbox matching a glob pattern (e.g. '**/*.ts'). Respects .gitignore. Returns matching paths.",
    readOnly: true,
    schema: z.object({ pattern: z.string(), path: z.string().optional().describe("base dir (default the working directory)") }),
    async call(input, ctx) {
      try {
        const r = await rg(["--files", "-g", input.pattern], guestPath(input.path, cwd), ctx.signal);
        if (r.exitCode === 1) return ok("No files matched");
        if (r.exitCode !== 0) return err(`glob failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
        const files = r.stdout.split("\n").filter(Boolean).sort();
        return ok(files.length ? files.join("\n") : "No files matched");
      } catch (e) {
        return failed("glob failed", e);
      }
    },
  });

  const grep = defineTool({
    name: "Grep",
    hands: "routed",
    description: "Search sandbox file contents with a regular expression (ripgrep-backed; respects .gitignore). Returns file:line:match. Optionally scoped by a glob.",
    readOnly: true,
    schema: z.object({
      pattern: z.string(),
      path: z.string().optional().describe("base dir (default the working directory)"),
      glob: z.string().optional().describe("file glob to scope the search"),
    }),
    async call(input, ctx) {
      const args = ["--line-number", "--max-columns", "500"];
      if (input.glob) args.push("-g", input.glob);
      args.push("--regexp", input.pattern);
      try {
        const r = await rg(args, guestPath(input.path, cwd), ctx.signal);
        if (r.exitCode === 1) return ok("No matches");
        if (r.exitCode !== 0) return err(`grep failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
        const lines = r.stdout.split("\n").filter(Boolean);
        if (lines.length > MAX_MATCHES) return ok([...lines.slice(0, MAX_MATCHES), `[truncated at ${MAX_MATCHES} matches]`].join("\n"));
        return ok(lines.length ? lines.join("\n") : "No matches");
      } catch (e) {
        return failed("grep failed", e);
      }
    },
  });

  const list = defineTool({
    name: "List",
    hands: "routed",
    description: "List the entries of a sandbox directory. Directories are suffixed with '/'.",
    readOnly: true,
    schema: z.object({ path: z.string().optional().describe("directory (default the working directory)") }),
    async call(input, ctx) {
      try {
        const entries = await client.listDir(guestPath(input.path, cwd), { signal: ctx.signal });
        const rows = entries
          .filter((e) => e.name !== "node_modules" && e.name !== ".git")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => (e.is_dir || e.type === "dir" || e.type === "directory" ? `${e.name}/` : e.name));
        return ok(rows.join("\n") || "(empty)");
      } catch (e) {
        return failed(`cannot list ${input.path ?? "."}`, e);
      }
    },
  });

  return [bash, bashOutput, kill, read, write, edit, globTool, grep, list] as Tool<unknown>[];
}

/** The local builtins these replace, by name. */
export const SANDBOX_HANDS_NAMES = ["Bash", "BashOutput", "Kill", "Read", "Write", "Edit", "Glob", "Grep", "List"] as const;
