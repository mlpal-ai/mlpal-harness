import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { hostDir, hostEnv } from "../host";

/**
 * Layered configuration: defaults < ~/.yodex/config.json < <cwd>/.yodex/settings.json
 * < env < flags. The API key is intentionally NOT part of settings (env-only, never
 * written to a config file). MLPal-specific config (gateway endpoint, default model)
 * lives in the `gateway`/`model` blocks. See docs/05 §9.
 */
export const settingsSchema = z.object({
  gateway: z
    .object({ baseUrl: z.string().default("https://models.mlpal.ai") })
    .default({}),
  /** The pinned, harness-validated default. Deliberately concrete: the prompts/effort defaults
   *  are tuned and benchmarked against this model, so upgrades happen by release, not by a
   *  gateway routing edit. When a gateway doesn't serve it (small self-hosted boxes) and the
   *  user didn't pin a model, the CLI falls back to the availability-aware `mlpal` router tag
   *  — defaults are ours to make robust; explicit choices are never substituted. */
  model: z.string().default("claude-opus-5"),
  /** Reasoning effort for the main loop (output_config.effort). Unset by default — we don't override
   *  the model's own default reasoning; set it via --effort / YODEX_EFFORT (or here) to pin a level. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** HOP (harness optimization profile): builtin name (coding, reviewer), a name under
   *  .yodex/hops/, or a directory path. Unset => coding. Also --profile / YODEX_PROFILE. */
  profile: z.string().optional(),
  /** Default is full autonomy — the harness's deterministic safety layer (rule checks before
   *  permission logic) still guards every read/write/edit/shell call; users who want approval
   *  prompts opt DOWN via --mode / YODEX_MODE / config. */
  mode: z.enum(["recon", "manual", "cruise", "autopilot"]).default("autopilot"),
  /** Recap lines (after long autonomous stints and on resuming substantial sessions). */
  recap: z.enum(["auto", "off"]).default("auto"),
  /** Background work limits. Monitors are capped per session (each is a live watcher process);
   *  background sub-agents are deliberately uncapped — the gateway's rate limits are the real
   *  ceiling, and a read-only child is cheap to hold. */
  background: z
    .object({
      maxMonitors: z.number().int().positive().default(8),
    })
    .default({}),
  /** Per-skill state. Disabled skills stay discovered (the /skills panel lists them) but are
   *  dropped from the model's catalog and refused by the Skill tool. */
  skills: z
    .object({
      disabled: z.array(z.string()).default([]),
    })
    .default({}),
  maxTokens: z.number().int().positive().optional(),
  // Runaway backstop, not an operating limit: sits far above any real task so it never
  // truncates legitimate work (large-repo SWE tasks routinely need 60-120 turns). Override
  // per-run with --max-turns. Deeper cost control (a budget/$ ceiling) is tracked separately.
  maxTurns: z.number().int().positive().default(200),
  permissions: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({}),
  hooks: z
    .array(
      z.object({
        event: z.enum([
          "UserPromptSubmit",
          "PreToolUse",
          "PostToolUse",
          "Stop",
          "SessionStart",
          "SessionEnd",
          "PreCompact",
          "SubagentStop",
        ]),
        command: z.string(),
      }),
    )
    .default([]),
  mcpServers: z
    .record(
      z.union([
        // stdio server: a local process
        z.object({
          command: z.string(),
          args: z.array(z.string()).optional(),
          env: z.record(z.string()).optional(),
        }),
        // HTTP server: a URL + optional headers. Header values may reference env vars as
        // ${VAR} so secrets (API keys) stay out of settings files. `type` selects the wire
        // transport (default streamable-HTTP; "sse" for older SSE-only servers). `oauth`
        // enables an OAuth 2.0 token flow (tokens persisted under ~/.yodex/mcp-auth).
        z.object({
          url: z.string().url(),
          type: z.enum(["http", "sse"]).optional(),
          headers: z.record(z.string()).optional(),
          oauth: z
            .object({
              scope: z.string().optional(),
              /** Client id if the server requires static (non-dynamic) registration. */
              clientId: z.string().optional(),
            })
            .optional(),
        }),
      ]),
    )
    .default({}),
  routing: z
    .object({
      /**
       * Default model for subtask roles (sub-agents, compaction summaries, classifiers): a tier
       * alias (cheap|mid|frontier|max), a concrete model id, or "inherit" (= the main model).
       * When unset: "cheap" if the main model was NOT explicitly pinned (cost-optimized — cheap
       * subtasks save money), or "inherit" if it was (respect the model you asked for). Per-role
       * overrides below still win over this.
       */
      subtasks: z.string().optional(),
      /**
       * Budget-aware sub-agent routing (opt-in). economy | balanced | quality. When set, each
       * delegated sub-task is complexity-classified and run on the cheapest capable tier within
       * the strategy's ladder — the main loop stays on its own (premium/chosen) model, so its
       * warm cache is never touched. Unset => sub-agents use the fixed `subtasks` routing.
       */
      budget: z.enum(["economy", "balanced", "quality"]).optional(),
      summarize: z.string().optional(),
      subagent: z.string().optional(),
      classify: z.string().optional(),
      /**
       * Difficulty escalation ladder (cheap → strong model tags). When set, the main
       * loop starts on the cheapest rung and climbs one rung each time the verifier
       * blocks completion. Requires a verifier (verify.command/agent) to have a signal.
       */
      escalation: z.array(z.string()).optional(),
      /** Verifier failures per rung before climbing (lets a cheap model self-correct). Default 2. */
      escalationPatience: z.number().int().min(1).optional(),
      /** Run a cheap classifier at each turn's start to pick the ladder rung to begin on. */
      classifyStart: z.boolean().optional(),
    })
    .default({}),
  memory: z
    .object({
      /** local (default): filesystem only. graph: also mirror writes to mlpal-memory-graph. */
      backend: z.enum(["local", "graph"]).default("local"),
      /** memory-graph base URL (used when backend=graph). */
      graphUrl: z.string().optional(),
      /** Notes workspace name. Precedence: this setting > the HOP's memory.workspace > basename(cwd). */
      workspace: z.string().min(1).optional(),
    })
    .default({ backend: "local" }),
  verify: z
    .object({
      /** Run this command at "done"; non-zero blocks until fixed (e.g. "npm test"). */
      command: z.string().optional(),
      /**
       * When no explicit `command` is set, auto-detect the project's primary check (test >
       * typecheck > build) and run it as a Stop gate at "done", blocking until it passes. OFF by
       * default: it runs the tests on every task, which costs time/tokens. Opt in for high-stakes
       * or CI autonomy where a hard green gate is worth the cost.
       */
      auto: z.boolean().default(false),
      /** Spawn a reviewer model at "done" to judge completeness. */
      agent: z.boolean().optional(),
      /**
       * Built-in completion self-check: at "done", if the run made real edits but never ran a
       * test/build/typecheck, nudge once to verify-or-admit before finishing. Edit-gated and
       * one-shot, so trivial and already-verified runs pay nothing. Default on; steps aside
       * automatically when a Stop verifier (command/agent above, or a user Stop hook) is wired.
       */
      selfCheck: z.boolean().default(true),
      /** Minimum successful edits in a run before the self-check may fire. */
      selfCheckMinEdits: z.number().int().positive().default(3),
      /**
       * Mid-loop anti-churn breaker: when a single file is edited many times in one run with no
       * verification in between, inject one nudge to commit the best version and stop cycling.
       * Catches the doubt spiral (edit -> revert -> edit) that prompt guidance alone can miss.
       * Default on; inert when a Stop verifier is wired (that provides real feedback instead).
       */
      antiChurn: z.boolean().default(true),
    })
    .default({}),
  /**
   * Condense oversized tool outputs with a cheap side-model before they enter the main context.
   * A separate one-shot call (cache-safe — never a turn of the main conversation), it shrinks huge
   * reads/logs to what matters (errors + relevant lines preserved verbatim), saving cost AND keeping
   * the main context small. Off by default: it trades some fidelity and adds a small per-large-output
   * call, so opt in when runs bloat on giant outputs.
   */
  condense: z
    .object({
      enabled: z.boolean().default(false),
      /** Only outputs longer than this many characters are condensed. */
      threshold: z.number().int().min(1000).default(16000),
    })
    .default({}),
  /**
   * Input hints: while you type at the prompt, a cheap-model call proposes how to finish your
   * message from the recent conversation, shown as ghost text — Tab accepts it. Debounced and
   * cancellable (fires on a pause, not per keystroke) and interactive-TTY only. It trades a small
   * per-pause call for faster composing, so it's off by default; enable when you want it.
   */
  hints: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
});

export type Settings = z.infer<typeof settingsSchema>;

/** Where an MCP server definition came from — one entry per file that defines the name.
 *  More than one entry means a cross-scope conflict (later scope wins whole-value).
 *  "plugin" origins are added by the CLI when it loads installed packs. */
export interface McpOrigin {
  scope: "user" | "project" | "plugin";
  path: string;
}

export interface SettingsFlags {
  model?: string;
  mode?: string;
  maxTurns?: number;
  maxTokens?: number;
  gatewayUrl?: string;
}

export interface SettingsInputs {
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  flags?: SettingsFlags;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function mergeDeep(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = isObj(prev) && isObj(v) ? mergeDeep(prev, v) : v;
  }
  return out;
}

function readJsonFile(path: string): Obj | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Resolve effective settings. Throws (ZodError) on invalid values, e.g. a bad mode.
 *  `mcpOrigins` records which file(s) define each MCP server, for the /mcp manager's scope
 *  display and cross-scope conflict diagnostics. */
export function loadSettings(
  inp: SettingsInputs,
): Settings & { mcpOrigins: Record<string, McpOrigin[]>; modelPinned: boolean; raw: Record<string, unknown> } {
  const layers: Obj[] = [];

  const globalPath = hostDir(inp.home, "config.json");
  const global = readJsonFile(globalPath);
  if (global) layers.push(global);

  const projectPath = hostDir(inp.cwd, "settings.json");
  const project = readJsonFile(projectPath);
  if (project) layers.push(project);

  const envLayer: Obj = {};
  const gatewayUrl = hostEnv(inp.env, "GATEWAY_URL");
  if (gatewayUrl) envLayer.gateway = { baseUrl: gatewayUrl };
  const envModel = hostEnv(inp.env, "MODEL");
  if (envModel) envLayer.model = envModel;
  const envMode = hostEnv(inp.env, "MODE");
  if (envMode) envLayer.mode = envMode;
  const envProfile = hostEnv(inp.env, "PROFILE");
  if (envProfile) envLayer.profile = envProfile;
  layers.push(envLayer);

  const f = inp.flags ?? {};
  const flagLayer: Obj = {};
  if (f.model) flagLayer.model = f.model;
  if (f.mode) flagLayer.mode = f.mode;
  if (f.maxTurns !== undefined) flagLayer.maxTurns = f.maxTurns;
  if (f.maxTokens !== undefined) flagLayer.maxTokens = f.maxTokens;
  if (f.gatewayUrl) flagLayer.gateway = { baseUrl: f.gatewayUrl };
  layers.push(flagLayer);

  let merged: Obj = {};
  for (const l of layers) merged = mergeDeep(merged, l);

  // MCP servers merge whole-value per name: a project entry REPLACES a same-named user
  // entry. The generic deep merge would pair one scope's url with the other's headers —
  // a silent cross-scope hybrid no one wrote. Provenance is kept for /mcp diagnostics.
  const userServers = isObj(global?.mcpServers) ? (global.mcpServers as Obj) : {};
  const projectServers = isObj(project?.mcpServers) ? (project.mcpServers as Obj) : {};
  merged.mcpServers = { ...userServers, ...projectServers };
  const mcpOrigins: Record<string, McpOrigin[]> = {};
  for (const name of Object.keys(userServers)) {
    mcpOrigins[name] = [{ scope: "user", path: globalPath }];
  }
  for (const name of Object.keys(projectServers)) {
    (mcpOrigins[name] ??= []).push({ scope: "project", path: projectPath });
  }

  // `raw` is the merged pre-defaults object: the record of what the user EXPLICITLY set,
  // used by profile lock enforcement (schema defaults never count as user intent).
  return { ...settingsSchema.parse(merged), mcpOrigins, modelPinned: merged.model !== undefined, raw: merged };
}
