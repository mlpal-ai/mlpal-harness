import { spawn } from "node:child_process";
import type { ModelClient } from "../gateway/client";
import { type Logger, silentLogger } from "../obs/logger";
import type { Hook, HookContext, HookEvent, HookInput, HookResult, HookWhen } from "./types";

/** Hook output past this many characters is cut and marked: a runaway hook never floods a prompt. */
export const HOOK_OUTPUT_CAP = 16 * 1024;

export function clipHookResult(r: HookResult, cap = HOOK_OUTPUT_CAP): HookResult {
  const clip = (v: string | undefined): string | undefined => (v && v.length > cap ? `${v.slice(0, cap)}\n[hook output clipped at ${cap} characters]` : v);
  const out: HookResult = { ...r };
  if (out.injectContext) out.injectContext = clip(out.injectContext);
  if (out.reason) out.reason = clip(out.reason);
  if (out.updatedPrompt) out.updatedPrompt = clip(out.updatedPrompt);
  return out;
}

/** Does the event match a configured `when`? Unknown fields on the input never match. */
export function matchesWhen(when: HookWhen | undefined, input: HookInput): boolean {
  if (!when) return true;
  const i = input as unknown as Record<string, unknown>;
  const oneOf = (want: string | string[] | undefined, got: unknown): boolean => want === undefined || (typeof got === "string" && (Array.isArray(want) ? want.includes(got) : want === got));
  const re = (pattern: string | undefined, got: unknown): boolean => {
    if (pattern === undefined) return true;
    if (typeof got !== "string") return false;
    try {
      return new RegExp(pattern).test(got);
    } catch {
      return false;
    }
  };
  if (!oneOf(when.toolName, i.toolName)) return false;
  if (!oneOf(when.kind, i.kind)) return false;
  if (!oneOf(when.agentType, i.agentType)) return false;
  if (when.isError !== undefined && Boolean(i.isError) !== when.isError) return false;
  const inp = i.input as Record<string, unknown> | undefined;
  if (!re(when.command, inp?.command ?? i.command)) return false;
  if (!re(when.prompt, i.prompt)) return false;
  return true;
}

/** A hook that runs only when its `when` matches the event. */
export class FilteredHook implements Hook {
  readonly id: string;
  readonly events: readonly HookEvent[];
  constructor(
    private readonly inner: Hook,
    private readonly when: HookWhen,
  ) {
    this.id = inner.id;
    this.events = inner.events;
  }
  run(input: HookInput, ctx: HookContext): Promise<HookResult> {
    return matchesWhen(this.when, input) ? this.inner.run(input, ctx) : Promise.resolve({});
  }
}

export class HookEngine {
  private readonly hooks: Hook[] = [];

  constructor(private readonly logger: Logger = silentLogger) {}

  register(hook: Hook): void {
    this.hooks.push(hook);
  }

  has(event: HookEvent): boolean {
    return this.hooks.some((h) => h.events.includes(event));
  }

  /** Run every hook registered for the event, in registration order. A hook that
   *  throws is isolated (logged, treated as a no-op) so one bad hook can't break a run. */
  async run(input: HookInput, ctx: HookContext): Promise<HookResult[]> {
    const matching = this.hooks.filter((h) => h.events.includes(input.event));
    const out: HookResult[] = [];
    for (const hook of matching) {
      try {
        out.push(await hook.run(input, ctx));
      } catch (e) {
        this.logger.error("hook failed", { hook: hook.id, event: input.event, error: String(e) });
      }
    }
    return out;
  }
}

/** In-process hook — used for built-ins and tests. */
export class FunctionHook implements Hook {
  constructor(
    readonly id: string,
    readonly events: readonly HookEvent[],
    private readonly fn: (input: HookInput, ctx: HookContext) => Promise<HookResult> | HookResult,
  ) {}

  async run(input: HookInput, ctx: HookContext): Promise<HookResult> {
    return this.fn(input, ctx);
  }
}

export interface CommandHookOptions {
  timeoutMs?: number;
  logger?: Logger;
}

/**
 * Shell hook: the event JSON is written to the command's stdin; a JSON HookResult is
 * read from stdout. Exit code 2 = block (a common hook convention). This is arbitrary
 * code execution by config — the host must gate it off in multi-tenant/hosted mode.
 */
export class CommandHook implements Hook {
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(
    readonly id: string,
    readonly events: readonly HookEvent[],
    private readonly command: string,
    opts: CommandHookOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.logger = opts.logger ?? silentLogger;
  }

  run(input: HookInput, ctx: HookContext): Promise<HookResult> {
    return new Promise((resolve) => {
      const child = spawn("/bin/bash", ["-c", this.command], { cwd: ctx.cwd });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);

      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", () => {
        clearTimeout(timer);
        resolve({});
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const parsed = clipHookResult(parseHookOutput(stdout));
        // exit code 2 = block; stderr becomes the reason if not provided
        if (code === 2) {
          resolve({ ...parsed, block: true, reason: parsed.reason ?? (stderr.trim().slice(0, HOOK_OUTPUT_CAP) || "blocked by hook") });
        } else {
          resolve(parsed);
        }
      });

      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
  }
}

function parseHookOutput(stdout: string): HookResult {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const o = JSON.parse(trimmed) as HookResult;
    return o && typeof o === "object" ? o : {};
  } catch {
    // non-JSON stdout is treated as injected context (a plain message)
    return { injectContext: trimmed };
  }
}

export interface HttpHookOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/**
 * HTTP hook: the event JSON (plus the context's session, agent and run ids) is POSTed to a URL;
 * a JSON HookResult comes back. A non-2xx, a timeout or a bad body is a no-op, logged once per
 * hook, never a failed run. Secrets for the URL belong in the configured headers, not the URL.
 */
export class HttpHook implements Hook {
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private warned = false;
  constructor(
    readonly id: string,
    readonly events: readonly HookEvent[],
    private readonly url: string,
    private readonly opts: HttpHookOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.logger = opts.logger ?? silentLogger;
  }

  async run(input: HookInput, ctx: HookContext): Promise<HookResult> {
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.headers ?? {}) },
        body: JSON.stringify({ ...input, context: { sessionId: ctx.sessionId, agentId: ctx.agentId, runId: ctx.runId } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return clipHookResult(parseHookOutput(text));
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn("http hook failed; treated as a no-op", { hook: this.id, url: this.url, error: String((e as Error)?.message ?? e) });
      }
      return {};
    }
  }
}

export interface PromptHookOptions {
  client: Pick<ModelClient, "stream">;
  model: string;
  timeoutMs?: number;
  logger?: Logger;
}

const PROMPT_HOOK_SYSTEM =
  "You are a policy check inside an agent harness. You receive a rule and one event as JSON. Decide whether the rule says to BLOCK the event. " +
  'Answer with JSON only: {"block": true|false, "reason": "<one sentence>"}. Block only when the rule clearly applies; when in doubt, do not block.';

/**
 * Prompt hook: a cheap model judges the event against a rule written in plain words
 * ("block any git push to main", "flag a Bash command that deletes a volume"). The model's
 * answer is a HookResult; anything but a clear block is a no-op. One bounded call per event.
 */
export class PromptHook implements Hook {
  private readonly logger: Logger;
  constructor(
    readonly id: string,
    readonly events: readonly HookEvent[],
    private readonly rule: string,
    private readonly opts: PromptHookOptions,
  ) {
    this.logger = opts.logger ?? silentLogger;
  }

  async run(input: HookInput, _ctx: HookContext): Promise<HookResult> {
    try {
      const gen = this.opts.client.stream({
        model: this.opts.model,
        system: PROMPT_HOOK_SYSTEM,
        messages: [{ role: "user", content: `Rule: ${this.rule}\n\nEvent:\n${JSON.stringify(input).slice(0, 12_000)}` }],
        maxTokens: 200,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
      let r = await gen.next();
      while (!r.done) r = await gen.next();
      const content = r.value.message.content;
      const text = typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) return {};
      const parsed = JSON.parse(text.slice(start, end + 1)) as { block?: unknown; reason?: unknown };
      return parsed.block === true ? { block: true, reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 500) : `blocked by rule: ${this.rule}` } : {};
    } catch (e) {
      this.logger.warn("prompt hook failed; treated as a no-op", { hook: this.id, error: String((e as Error)?.message ?? e) });
      return {};
    }
  }
}

/**
 * The in-process plugin hook API (the "mods" shape). A plugin pack's hooks module exports a
 * default function that receives this api and registers handlers; each becomes a FunctionHook.
 * `tool.check` is PreToolUse with the tool's name and input, the common case, named plainly.
 */
export interface PluginHooksApi {
  on<E extends HookEvent>(event: E, handler: (input: Extract<HookInput, { event: E }>, ctx: HookContext) => Promise<HookResult> | HookResult): void;
  tool: {
    check(handler: (tool: { name: string; input: Record<string, unknown> }, ctx: HookContext) => Promise<HookResult> | HookResult): void;
  };
}

export type PluginHooksModule = (api: PluginHooksApi) => void | Promise<void>;

/** Register a plugin's hooks on the engine under `plugin:<name>:<event>` ids. Returns how many. */
export async function registerPluginHooks(engine: HookEngine, name: string, register: PluginHooksModule): Promise<number> {
  let n = 0;
  const api: PluginHooksApi = {
    on: (event, handler) => {
      n += 1;
      engine.register(new FunctionHook(`plugin:${name}:${event}#${n}`, [event], (input, ctx) => (input.event === event ? handler(input as never, ctx) : {})));
    },
    tool: {
      check: (handler) => {
        n += 1;
        engine.register(new FunctionHook(`plugin:${name}:tool.check#${n}`, ["PreToolUse"], (input, ctx) => (input.event === "PreToolUse" ? handler({ name: input.toolName, input: input.input }, ctx) : {})));
      },
    },
  };
  await register(api);
  return n;
}
