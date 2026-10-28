import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type {
  EvalSuite,
  HopCredential,
  HopProcesses,
  HopSandbox,
  HopWorkspace,
  ModelPolicy,
  Profile,
  ProfileSource,
  RequiresPolicy,
  SafetyPolicy,
  TuningPolicy,
} from "./types";
import { PROFILE_SPEC_ID, DEVIATION_KINDS, MEMORY_FEEDS, RECORD_KINDS, TOPIC_KINDS, READ_SCOPES } from "./types";
import { pinsOutsidePolicy } from "./model-policy";
import { CODING_PROFILE, CODING_ENV_BROKEN_RE, CODING_VERIFY_CMD_RE } from "./builtins/coding";
import { REVIEWER_PROFILE } from "./builtins/reviewer";
import { hostDir } from "../host";

/**
 * Profile loading: discovery → parse → validate → compose the extends chain → lock
 * enforcement. External HOPs are a directory holding `hop.yaml` (+ referenced
 * prompt files); builtins are precompiled instances. Trust follows the discovery root
 * (builtin > user > project > explicit path), never fields in the file.
 *
 * Merge model (deliberate anti-dsh decision — no whole-row replacement): the child
 * starts from its parent's composed Profile and overrides per present leaf. Named
 * collections (`tools.include`, `tunable` per path) replace whole-value. `locked`
 * accumulates down the chain and an override of a locked path — by a child profile, by
 * user settings, or later by the tuner — is a hard error naming the locking profile.
 *
 * v1 scope: prompt slots overridable from YAML are the plain-string ones (system,
 * verifierAgent, summarizer, condenser — inline or `file:<relpath>`); the templated
 * slots (nudges, classifier, verifierTask) inherit from the extends parent and are only
 * definable in builtin (code) profiles. Documented in the spec as a v1 limitation.
 */

const evalSuiteSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    tasks: z.string().min(1),
    scorer: z.string().min(1),
    runs: z.number().int().positive().default(1),
    passBar: z.number().min(0).max(1).default(1),
    role: z.enum(["golden", "frontier", "probe"]).optional(),
    gates: z.boolean().optional(),
  })
  .strict();

// All fields optional so a leaf can override single tuning leaves over a parent's block; the
// composed result is validated for completeness + reference integrity in composeProfile.
// v1.1 §9.2 — memory.policy: closed sets, loud on an unknown kind (the error names the value),
// and a policy that feeds nothing is refused: recording deviations nobody reads is a mistake.
const uniqueMembers = (xs: readonly string[]) => new Set(xs).size === xs.length;
const memoryPolicySchema = z
  .object({
    record: z
      .array(z.enum(RECORD_KINDS, { errorMap: (_i, ctx) => ({ message: `memory.policy.record: unknown kind ${JSON.stringify(ctx.data)}; one of ${RECORD_KINDS.join(", ")}` }) }))
      .min(1, "memory.policy.record must name at least one deviation kind")
      .refine(uniqueMembers, "memory.policy.record lists a kind twice"),
    feeds: z
      .array(z.enum(MEMORY_FEEDS, { errorMap: (_i, ctx) => ({ message: `memory.policy.feeds: unknown consumer ${JSON.stringify(ctx.data)}; one of ${MEMORY_FEEDS.join(", ")}` }) }))
      .min(1, "memory.policy.feeds must name at least one consumer (tune, evals)")
      .default(["tune", "evals"]),   // personalize is opt-in: a HOP says when a person's own memories may shape their sessions
  })
  .strict();

// v1.1 §9.3 — the memory contract: topics are typed streams; a state topic needs a real key; every
// declared topic must be covered by `writes`; ids are unique. Errors name the value.
const HALF_LIFE = /^(none|\d+[dwy]|\d+x)$/;
const memoryTopicSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9{}][a-z0-9{}._-]*(\/[a-z0-9{}][a-z0-9{}._-]*)*$/, "memory.topics[].id must be slash-separated segments (placeholders {target}, {me} allowed)"),
    kind: z.enum(TOPIC_KINDS, { errorMap: (_i, ctx) => ({ message: `memory.topics[].kind: unknown kind ${JSON.stringify(ctx.data)}; one of ${TOPIC_KINDS.join(", ")}` }) }),
    key: z.string().min(1),
    halfLife: z.string().regex(HALF_LIFE, "memory.topics[].halfLife must be none, <n>d, <n>w, <n>y or <n>x (refresh cadences)").optional(),
    read: z.enum(READ_SCOPES, { errorMap: (_i, ctx) => ({ message: `memory.topics[].read: unknown scope ${JSON.stringify(ctx.data)}; one of ${READ_SCOPES.join(", ")}` }) }),
    inject: z.boolean().default(false),
    // memory v7 (design §1 phase axis): build memory is the builder's (what users asked, what each
    // version scored), deploy memory is the users'. Same store; the projection injects deploy
    // topics, the builder's brief reads build topics. Default deploy.
    phase: z.enum(["build", "deploy"]).default("deploy"),
    // managed HOPs (decided model 2026-10-08): what of this topic may cross from a runner's
    // instance into the publisher's HOP store. off = nothing; declared-only = the publication's
    // own distillation path; ask = consented items too (the host asks the person). Default off.
    feedback: z.enum(["off", "declared-only", "ask"], { errorMap: (_i, ctx) => ({ message: `memory.topics[].feedback: ${JSON.stringify(ctx.data)} is not one of off, declared-only, ask` }) }).optional(),
  })
  .strict();
const HALF_LIFE_DEFAULT: Record<string, string> = { state: "2x", record: "none", learning: "1y", preference: "none", deviation: "90d" };
const globToRegExp = (g: string) => new RegExp("^" + g.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
const memorySchema = z
  .object({
    workspace: z.string().min(1).optional(),
    tenant: z.string().min(1).optional(),
    policy: memoryPolicySchema.optional(),
    topics: z.array(memoryTopicSchema).default([]),
    reads: z.array(z.string().min(1)).default([]),
    writes: z.array(z.string().min(1)).default([]),
    // memory v7 WP7: the HOP's ontology extension — domain classes as subclasses of the core
    // (`Volume: Artifact`); the memory service registers them per tenant and constrains extraction.
    ontology: z.array(z.object({ name: z.string().regex(/^[A-Z][A-Za-z0-9]{1,40}$/), parent: z.string().min(1), description: z.string().max(200).optional() }).strict()).default([]),
    // memory v7 WP8: registry fields the service keeps per HOP (owner, mode, sharing)
    owner: z.string().min(1).optional(),
    mode: z.enum(["auto", "review", "manual"]).optional(),
    sharing: z.enum(["none", "org", "fleet"]).optional(),
    // managed HOPs: the publication this HOP version is published as (hop-service id); the
    // consent call names it and the HOP store is keyed by it.
    publication: z.string().min(1).optional(),
    // P5: how a run's staged claims are promoted, and the limits the HOP asks for (validation only).
    promotion: z.enum(["auto", "review"]).optional(),
    limits: z
      .object({ max_nodes: z.number().int().positive().optional(), max_bytes: z.number().int().positive().optional(), max_write_bytes: z.number().int().positive().optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.topics.some((t) => t.feedback === "ask") && !c.publication)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "memory.topics: a topic with feedback: ask needs memory.publication (the publication the consent goes to)" });
    const seen = new Set<string>();
    for (const t of c.topics) {
      if (seen.has(t.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `memory.topics: duplicate id ${JSON.stringify(t.id)}` });
      seen.add(t.id);
      if (t.kind === "state" && t.key === "dedup") ctx.addIssue({ code: z.ZodIssueCode.custom, message: `memory.topics: state topic ${JSON.stringify(t.id)} needs a key other than dedup` });
      if (c.writes.length > 0 && !c.writes.some((w) => globToRegExp(w).test(t.id)))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `memory.topics: ${JSON.stringify(t.id)} is declared but not covered by writes ${JSON.stringify(c.writes)}` });
    }
  })
  .transform((c) => ({ ...c, topics: c.topics.map((t) => ({ ...t, halfLife: t.halfLife ?? HALF_LIFE_DEFAULT[t.kind]! })), writes: c.writes.length ? c.writes : c.topics.map((t) => t.id) }));


const tuningSchema = z
  .object({
    // `on-incident` is a trigger, not a cadence (§6.2) — the scheduled clock only.
    cadence: z
      .union([z.enum(["daily", "weekly", "monthly"]), z.string().regex(/^per-\d+-runs$/)])
      .optional(),
    maxAge: z.string().regex(/^\d+[dw]$/, "maxAge is a duration like 4w or 14d").optional(),
    minRunsSinceLast: z.number().int().min(0).optional(),
    canaryFraction: z.number().min(0).max(1).optional(),
    canaryMinRuns: z.number().int().min(0).optional(),
    promote: z.enum(["auto", "human"]).optional(),
    frontierMetric: z.string().min(1).optional(),
    promotionMargin: z.string().min(1).optional(),
    goldenSuite: z.string().min(1).optional(),
    triggers: z.array(z.enum(["on-model-release", "on-api-change", "on-incident"])).optional(),
  })
  .strict();

// v1.1 blocks. All fields optional so a leaf can override single leaves over a parent's block.
const modelSchema = z
  .object({
    main: z.string().min(1).optional(),
    subagents: z
      .object({ readOnly: z.string().min(1).optional(), verify: z.string().min(1).optional() })
      .strict()
      .optional(),
    allowInvokeAny: z.boolean().optional(),
    tiers: z
      .record(z.object({ primary: z.string().min(1), fallbacks: z.array(z.string().min(1)).default([]) }).strict())
      .optional(),
    subscribe: z.string().regex(/^[a-z0-9-]+@[\w.-]+$/, "subscribe must be <profile>@<version>").optional(),
  })
  .strict();

const requiresSchema = z
  .object({
    binaries: z
      .array(
        z
          .object({
            name: z.string().min(1),
            detect: z.string().min(1), // a shell string or a `builtin:<domain>` detector
            setup: z.string().optional(),
            timeoutMs: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .default([]),
    // `optional`: a local or org server the HOP degrades without (e.g. an alert channel) — a
    // registration does not fail when it cannot resolve it, and preflight reports it softly.
    mcp: z.array(z.object({ name: z.string().min(1), optional: z.boolean().optional() }).strict()).default([]),
    // Keyring rungs (logical names; the platform resolves endpoints and mints the bundle).
    models: z.object({ tiers: z.array(z.string().min(1)).min(1) }).strict().optional(),
    agents: z.array(z.object({ name: z.string().min(1), optional: z.boolean().optional() }).strict()).default([]),
    skills: z.array(z.string().min(1)).default([]),
    memory: z.object({ read: z.boolean().default(true), write: z.boolean().default(false) }).strict().optional(),
  })
  .strict();

const safetySchema = z
  .object({
    toolClasses: z
      .object({
        readOnly: z.array(z.string()).default([]),
        mutative: z.array(z.string()).default([]),
        destructive: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
    preApply: z
      .object({ requirePlanArtifact: z.boolean().default(true), hash: z.array(z.string()).default([]) })
      .strict()
      .default({}),
    blastRadius: z
      .object({
        maxResources: z.number().int().positive().optional(),
        accounts: z.array(z.string()).optional(),
        regions: z.array(z.string()).optional(),
        requireTag: z.string().optional(),
      })
      .strict()
      .default({}),
    approval: z
      .object({
        destructive: z.enum(["always", "never"]).default("always"),
        outOfScope: z.enum(["always", "never"]).default("always"),
        costCeilingUsdMonth: z.number().positive().optional(),
      })
      .strict()
      .default({}),
    identities: z
      .object({ read: z.string().optional(), write: z.string().optional(), neverSelfGrant: z.boolean().default(true) })
      .strict()
      .default({}),
    // §10.3 — the execution sandbox. Optional inside the block so a v1.1 safety block without it
    // keeps loading; when present it is locked with the rest of the envelope.
    sandbox: z
      .object({
        filesystem: z
          .object({
            mode: z.enum(["workspace", "readOnly"]).optional(),
            allowWrite: z.array(z.string().min(1)).optional(),
            allowRead: z.array(z.string().min(1)).optional(),
            denyRead: z.array(z.string().min(1)).optional(),
          })
          .strict()
          .optional(),
        network: z
          .object({
            mode: z.enum(["all", "none", "allowlist"]).optional(),
            allow: z.array(z.string().min(1)).optional(),
          })
          .strict()
          .optional(),
        env: z.object({ keep: z.array(z.string().min(1)).optional() }).strict().optional(),
        required: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// P4 — the sandbox router's own grammar, checked here so a bad HOP fails at load, not at create.
const EGRESS_ENTRY = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)(?::(\d{1,5}))?$/;
const validEgressEntry = (e: string): boolean => {
  const m = EGRESS_ENTRY.exec(e);
  return Boolean(m) && (m![2] === undefined || (Number(m![2]) >= 1 && Number(m![2]) <= 65535));
};
const egressEntry = z.string().refine(validEgressEntry, (e) => ({ message: `not a host or host:port entry: ${JSON.stringify(e)} (no wildcard, no scheme)` }));
const sandboxSchema = z
  .object({
    size_class: z.enum(["1c2g", "2c4g"]).optional(),
    template: z
      .string()
      .regex(/^(hands|[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*)$/, "template must be hands or <name>@<version>")
      .optional(),
    egress: z.array(egressEntry).optional(),
  })
  .strict();
const workspaceSchema = z.object({ policy: z.enum(["ephemeral", "session", "persistent"]).optional() }).strict();
// P6: by reference only; a `value` is refused with its own message, any other unknown key as usual.
const credentialSchema = z
  .object({})
  .passthrough()
  .refine((c) => !("value" in c), "a credential is a reference (ref); a value never appears in a HOP")
  .pipe(
    z
      .object({
        ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/, "ref names a vault secret (an id or a name), never a value"),
        tool: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "tool is the MCP server that uses it, or sandbox"),
        host: z.string().refine((h) => validEgressEntry(h) && !h.includes(":"), "host is a bare host name"),
        header: z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "header is an HTTP field name"),
      })
      .strict(),
  );
const processesSchema = z
  .object({
    mcp_stdio: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "name must be [A-Za-z0-9_-]{1,64} (it names the server's tools)"),
            argv: z.array(z.string().min(1)).min(1),
            env_names: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an environment variable name")).default([]),
          })
          .strict(),
      )
      .superRefine((servers, ctx) => {
        const seen = new Set<string>();
        for (const s of servers) {
          if (seen.has(s.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: `processes.mcp_stdio: duplicate name "${s.name}"` });
          seen.add(s.name);
        }
      })
      .optional(),
    hooks: z.boolean().optional(),
    lsp: z.boolean().optional(),
  })
  .strict();

export const profileYamlSchema = z
  .object({
    spec: z.literal(PROFILE_SPEC_ID, {
      errorMap: () => ({
        message: `hop.yaml must declare spec: ${PROFILE_SPEC_ID} (unversioned HOPs are refused so future spec revisions can migrate them)`,
      }),
    }),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "name must be lowercase kebab-case (it names directories and telemetry dimensions)"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "version must be semver (x.y.z)"),
    description: z.string().default(""),
    /** Builtin name or relative directory path. Single inheritance. */
    extends: z.string().default("coding"),
    prompts: z
      .object({
        system: z.string().optional(),
        verifierAgent: z.string().optional(),
        summarizer: z.string().optional(),
        condenser: z.string().optional(),
      })
      .strict()
      .default({}),
    verification: z
      .object({
        observe: z.enum(["builtin:coding", "builtin:none"]).optional(),
        selfCheck: z
          .object({ enabled: z.boolean().optional(), minEdits: z.number().int().positive().optional() })
          .strict()
          .default({}),
        antiChurn: z
          .object({ enabled: z.boolean().optional(), threshold: z.number().int().positive().optional() })
          .strict()
          .default({}),
        agent: z
          .object({
            enabled: z.boolean().optional(),
            tier: z.enum(["max", "frontier", "mid", "cheap"]).optional(),
            riskGateMinChangedLines: z.number().int().min(0).optional(),
            riskGate: z.enum(["changed-lines", "actions"]).optional(),
            failMode: z.enum(["open", "closed"]).optional(),
            // v1.1 — the verifier's user-turn framing, definable in YAML (was builtin-only). `{task}`
            // and `{deliverable}` are substituted. A HOP whose deliverable is TEXT (not an on-disk
            // diff) needs this, or the inherited coding framing audits a filesystem that can't hold it.
            task: z.string().min(1).optional(),
          })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    catalog: z.object({ profile: z.string().optional() }).strict().default({}),
    routing: z
      .object({
        subagents: z
          .union([z.enum(["catalog", "inherit"]), z.string().regex(/^budget:(economy|balanced|quality)$/)])
          .optional(),
        classifyStart: z.boolean().optional(),
        escalation: z
          .object({ ladder: z.enum(["catalog", "off"]).optional(), patience: z.number().int().min(1).optional() })
          .strict()
          .default({}),
      })
      .strict()
      .default({}),
    permissions: z
      .object({
        defaultMode: z.enum(["recon", "manual", "cruise", "autopilot"]).optional(),
        allow: z.array(z.string()).optional(),
        deny: z.array(z.string()).optional(),
      })
      .strict()
      .default({}),
    tools: z.object({ include: z.array(z.string()).optional() }).strict().default({}),
    /** memory v10: capability modules — a named prompt section (and optional tools) the HOP carries
     *  for one provider or domain, switchable as a whole. `enabled` is a tunable knob
     *  (`modules.<name>.enabled`, range ["on","off"]) so the tune loop can propose switching an
     *  unused provider off from the capability-mix facts, and the owner approves. Prompt text of
     *  enabled modules is appended to the system prompt in declaration order; a module's tools join
     *  `tools.include` when enabled (nothing to join when it is absent: that is every tool).
     *  `off` keeps the module in the artifact for a later `on`. */
    modules: z
      .record(
        z
          .object({
            prompt: z.string(),
            tools: z.array(z.string()).optional(),
            enabled: z.union([z.boolean(), z.enum(["on", "off"])]).default(true),
            description: z.string().optional(),
          })
          .strict(),
      )
      .default({}),
    budgets: z.object({ maxTurns: z.number().int().positive().optional() }).strict().default({}),
    telemetry: z.object({ taskType: z.string().optional() }).strict().default({}),
    evals: z.array(evalSuiteSchema).default([]),
    tuning: tuningSchema.optional(),
    model: modelSchema.optional(),
    requires: requiresSchema.optional(),
    safety: safetySchema.optional(),
    memory: memorySchema.default({ topics: [], reads: [], writes: [] }),
    // HOP model policy: the gateway's allow/deny globs (one model, a list, `claude-*`, `*`).
    model_policy: z.object({ allow: z.array(z.string().min(1)).optional(), deny: z.array(z.string().min(1)).optional() }).strict().optional(),
    sandbox: sandboxSchema.optional(),
    workspace: workspaceSchema.optional(),
    processes: processesSchema.optional(),
    credentials: z.array(credentialSchema).optional(),
    locked: z.array(z.string()).default([]),
    tunable: z
      .array(
        z
          .object({
            path: z.string(),
            // numeric interval [min,max] OR an enum-set of allowed string values [a,b,…] (v1.1).
            range: z.union([z.tuple([z.number(), z.number()]), z.array(z.string().min(1)).min(1)]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict(); // unknown top-level keys are a loud error, not a silent ignore

export type ProfileYaml = z.infer<typeof profileYamlSchema>;

export function builtinProfiles(): Record<string, Profile> {
  return { coding: CODING_PROFILE, reviewer: REVIEWER_PROFILE };
}

export interface LoadProfileOptions {
  cwd: string;
  home: string;
}

/** Resolve a `file:<relpath>` prompt reference against the profile dir; inline otherwise. */
function resolvePromptText(value: string, dir: string, field: string): string {
  if (!value.startsWith("file:")) return value;
  const rel = value.slice("file:".length);
  const abs = isAbsolute(rel) ? rel : join(dir, rel);
  if (!existsSync(abs)) {
    throw new Error(`profile ${field} references ${value} but ${abs} does not exist`);
  }
  return readFileSync(abs, "utf8").replace(/\n$/, "");
}

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Dot paths of every leaf PRESENT in a parsed YAML object (used for lock checks). */
function presentLeafPaths(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...presentLeafPaths(v as Record<string, unknown>, p));
    else if (v !== undefined) out.push(p);
  }
  return out;
}

function lockViolation(locked: string[], paths: string[]): string | null {
  for (const p of paths) {
    if (locked.some((l) => p === l || p.startsWith(`${l}.`))) return p;
  }
  return null;
}

const OBSERVE_SOURCES: Record<string, { verify: RegExp | null; envBroken: RegExp | null }> = {
  "builtin:coding": { verify: CODING_VERIFY_CMD_RE, envBroken: CODING_ENV_BROKEN_RE },
  "builtin:none": { verify: null, envBroken: null },
};

/** Resolve gates defaults by role: golden and probe gate promotion; frontier and role-less suites
 *  do not (frontier is the scored metric, not a pass/fail gate). An explicit `gates` always wins,
 *  so an LLM-judged golden suite can opt out with gates:false (the deterministic-gates-only rule). */
function withGatesDefaults(evals: EvalSuite[]): EvalSuite[] {
  return evals.map((e) => ({ ...e, gates: e.gates ?? (e.role === "golden" || e.role === "probe") }));
}

const TUNING_REQUIRED = [
  "cadence",
  "minRunsSinceLast",
  "canaryFraction",
  "canaryMinRuns",
  "promote",
  "frontierMetric",
  "promotionMargin",
  "goldenSuite",
] as const;

/** Merge a child's tuning leaves over the parent's block (per-leaf, like verification). The
 *  composed block must be COMPLETE — a half-specified tuning is a loud error, not a silent partial. */
function composeTuning(
  parent: TuningPolicy | undefined,
  child: ProfileYaml["tuning"],
  name: string,
): TuningPolicy | undefined {
  if (!parent && !child) return undefined;
  const merged: Record<string, unknown> = { ...(parent ?? {}) };
  for (const [k, v] of Object.entries(child ?? {})) if (v !== undefined) merged[k] = v;
  for (const k of TUNING_REQUIRED) {
    if (merged[k] === undefined) {
      throw new Error(
        `profile "${name}" declares a tuning block missing required field "${k}" — ` +
          `a HOP either has a complete tuning policy or none`,
      );
    }
  }
  return merged as unknown as TuningPolicy;
}

/** Tuning references must resolve to eval suites with the right role, and auto-promote needs a real
 *  mandatory-pass gate. Blast-radius / read-only gating of auto-promote is enforced by the tuner (it
 *  needs capability-tag resolution the loader does not have) — the engine enforces reference integrity. */
function validateTuning(tuning: TuningPolicy, evals: EvalSuite[], name: string): void {
  const byName = new Map(evals.map((e) => [e.name, e]));
  const frontier = byName.get(tuning.frontierMetric);
  if (!frontier || frontier.role !== "frontier") {
    throw new Error(
      `profile "${name}" tuning.frontierMetric "${tuning.frontierMetric}" must name an eval suite with role: frontier`,
    );
  }
  const golden = byName.get(tuning.goldenSuite);
  if (!golden || golden.role !== "golden") {
    throw new Error(
      `profile "${name}" tuning.goldenSuite "${tuning.goldenSuite}" must name an eval suite with role: golden`,
    );
  }
  if (tuning.promote === "auto" && !golden.gates) {
    throw new Error(
      `profile "${name}" sets tuning.promote: auto but its golden suite "${golden.name}" does not gate ` +
        `(gates: false) — auto-promotion requires a mandatory-pass gate`,
    );
  }
}

/** Merge a child's model leaves over the parent's. `main` is required whenever a model block
 *  exists; `allowInvokeAny` defaults true. `tiers` compose per name (inline overrides a subscribed
 *  baseline and a parent's tiers); `subscribe` is a single pinned baseline. */
function composeModel(
  parent: ModelPolicy | undefined,
  child: ProfileYaml["model"],
  name: string,
): ModelPolicy | undefined {
  if (!parent && !child) return undefined;
  const main = child?.main ?? parent?.main;
  if (!main) {
    throw new Error(`profile "${name}" declares a model block without model.main`);
  }
  const tiers = parent?.tiers || child?.tiers ? { ...(parent?.tiers ?? {}), ...(child?.tiers ?? {}) } : undefined;
  const subscribe = child?.subscribe ?? parent?.subscribe;
  return {
    main,
    subagents: { ...(parent?.subagents ?? {}), ...(child?.subagents ?? {}) },
    allowInvokeAny: child?.allowInvokeAny ?? parent?.allowInvokeAny ?? true,
    ...(tiers ? { tiers } : {}),
    ...(subscribe ? { subscribe } : {}),
  };
}

/** Canonical tier ordering for the downward-fallback check; custom tier names have no order. */
const TIER_RANK: Record<string, number> = { cheap: 0, mid: 1, frontier: 2, max: 3 };
/** Tier NAMES are a constrained grammar (lowercase + hyphens, no digits/uppercase) so a tier name
 *  can never collide with a pinned model id. Classification is then pure table membership. */
const TIER_NAME_RE = /^[a-z][a-z-]{0,31}$/;

/** Validate the model block (§8 load-time rules) and return non-fatal warnings; throws on error. */
function validateModel(model: ModelPolicy, name: string): string[] {
  const warnings: string[] = [];
  const tiers = model.tiers;

  // Tier NAMES follow a grammar so they can't be mistaken for a pinned model id (claude-opus-5).
  if (tiers) {
    for (const key of Object.keys(tiers)) {
      if (!TIER_NAME_RE.test(key)) {
        throw new Error(
          `profile "${name}" model.tiers name "${key}" must match ${TIER_NAME_RE} (lowercase + hyphens, ` +
            `no digits or uppercase) so it cannot collide with a pinned model id`,
        );
      }
    }
  }

  // Classification is by table membership: a reference present in the resolved tier table is a
  // tier; any other token is a pinned model id the serving layer validates (a `sol`-style id
  // resolves precisely because it is not in the table). With no tiers AND no subscribe, model.*
  // resolves against the catalog (v1.0 back-compat) — the model set is then unpinned.
  if (!tiers && !model.subscribe) {
    warnings.push("model.* resolves against the catalog (no tiers/subscribe declared) — the model set is unpinned");
  }

  // A model.main fallback that is a known LOWER tier's primary is a load error; unknown-tier
  // fallbacks are allowed with a warning. Only meaningful when main is a canonically-ranked tier.
  if (tiers && model.main in tiers && model.main in TIER_RANK) {
    const mainRank = TIER_RANK[model.main]!;
    const primaryToTier = new Map(Object.entries(tiers).map(([t, d]) => [d.primary, t]));
    for (const fb of tiers[model.main]!.fallbacks) {
      const fbTier = primaryToTier.get(fb);
      if (fbTier && fbTier in TIER_RANK && TIER_RANK[fbTier]! < mainRank) {
        throw new Error(
          `profile "${name}" model.main tier "${model.main}" lists fallback "${fb}" — the primary of lower ` +
            `tier "${fbTier}"; a main loop may not silently degrade downward`,
        );
      }
      if (!fbTier) {
        warnings.push(`model.main fallback "${fb}" is not a declared tier's primary (author-vouched, unpinned quality)`);
      }
    }
  }
  return warnings;
}

/** Union parent + child requirements by name (child wins on collision) — extending a HOP ADDS
 *  prerequisites rather than replacing them. */
function composeRequires(
  parent: RequiresPolicy | undefined,
  child: ProfileYaml["requires"],
): RequiresPolicy | undefined {
  if (!parent && !child) return undefined;
  const mergeByName = <T extends { name: string }>(a: T[], b: T[]): T[] => {
    const m = new Map(a.map((x) => [x.name, x]));
    for (const x of b) m.set(x.name, x);
    return [...m.values()];
  };
  const models = child?.models ?? parent?.models;
  const agents = mergeByName(parent?.agents ?? [], child?.agents ?? []);
  const skills = [...new Set([...(parent?.skills ?? []), ...(child?.skills ?? [])])];
  const memory = child?.memory ?? parent?.memory;
  return {
    binaries: mergeByName(parent?.binaries ?? [], child?.binaries ?? []),
    mcp: mergeByName(parent?.mcp ?? [], child?.mcp ?? []),
    ...(models ? { models } : {}),
    ...(agents.length ? { agents } : {}),
    ...(skills.length ? { skills } : {}),
    ...(memory ? { memory } : {}),
  };
}

/** Safety is LOCKED whenever present, so a child overriding a parent's safety is already a lock
 *  violation. This therefore only INTRODUCES safety where the parent had none, or inherits it. */
function composeSafety(
  parent: SafetyPolicy | undefined,
  child: ProfileYaml["safety"],
): SafetyPolicy | undefined {
  return (child ?? parent) as SafetyPolicy | undefined;
}

/** P4 blocks: a child overrides its parent per field (a list, such as `mcp_stdio`, whole). */
function composeBlock<T extends object>(parent: T | undefined, child: T | undefined): T | undefined {
  if (!parent && !child) return undefined;
  const merged: Record<string, unknown> = { ...(parent ?? {}) };
  for (const [k, v] of Object.entries(child ?? {})) if (v !== undefined) merged[k] = v;
  return merged as T;
}

/** `include` absent = every registered tool, which already has every module's tools; `[]` = none,
 *  and an enabled module's tools join it as they join a list. */
function composeTools(include: string[] | undefined, modules: Profile["modules"]): Profile["tools"] {
  if (include === undefined) return {};
  const extra = Object.values(modules).filter((m) => m.enabled).flatMap((m) => m.tools ?? []);
  return { include: extra.length ? [...new Set([...include, ...extra])] : include };
}

function p4Blocks(parent: Profile, y: ProfileYaml): Pick<Profile, "sandbox" | "workspace" | "processes" | "credentials"> {
  const sandbox = composeBlock<HopSandbox>(parent.sandbox, y.sandbox);
  const workspace = composeBlock<HopWorkspace>(parent.workspace, y.workspace);
  const processes = composeBlock<HopProcesses>(parent.processes, y.processes);
  const credentials: HopCredential[] | undefined = y.credentials ?? parent.credentials;
  return { ...(sandbox ? { sandbox } : {}), ...(workspace ? { workspace } : {}), ...(processes ? { processes } : {}), ...(credentials ? { credentials } : {}) };
}

/** Compose a parsed hop.yaml over its parent Profile. Pure; throws on lock violations. */
export function composeProfile(
  parent: Profile,
  y: ProfileYaml,
  dir: string,
  source: ProfileSource,
): Profile {
  // A child may not override what an ancestor locked. `permissions.deny` is exempt: it
  // concatenates down the chain and can never remove a parent entry, so a child touching
  // it is always a TIGHTENING — a lock guards against weakening, not against stricter.
  // (`permissions.allow` also concatenates but additions can LOOSEN policy, so it stays
  // lock-checked.)
  const raw = y as unknown as Record<string, unknown>;
  const overriddenPaths = presentLeafPaths(raw).filter(
    (p) =>
      !["spec", "name", "version", "description", "extends", "locked", "tunable", "evals"].some(
        (meta) => p === meta || p.startsWith(`${meta}.`),
      ) && !p.startsWith("permissions.deny"),
  );
  const violation = lockViolation(parent.locked, overriddenPaths);
  if (violation) {
    throw new Error(
      `profile "${y.name}" overrides "${violation}", which is locked by its parent ` +
        `"${parent.name}" — remove the override or extend a profile that does not lock it`,
    );
  }

  const observe = y.verification.observe ?? parent.verification.observe;
  const observed = OBSERVE_SOURCES[observe]!;
  const tunable = [...parent.tunable.filter((t) => !y.tunable.some((o) => o.path === t.path)), ...y.tunable];
  // memory v10: modules are the artifact's own (a variant re-declares what it carries); prompt text
  // resolves like prompts.system; `enabled` accepts on/off (the tune loop's enum knob) or a boolean
  const modules: Record<string, { prompt: string; tools?: string[]; enabled: boolean; description?: string }> = Object.fromEntries(
    Object.entries(y.modules).map(([n, m]) => [
      n,
      {
        prompt: resolvePromptText(m.prompt, dir, `modules.${n}.prompt`),
        ...(m.tools ? { tools: m.tools } : {}),
        enabled: m.enabled === true || m.enabled === "on",
        ...(m.description ? { description: m.description } : {}),
      },
    ]),
  );
  const evals = withGatesDefaults(y.evals.length > 0 ? y.evals : parent.evals);
  const tuning = composeTuning(parent.tuning, y.tuning, y.name);
  if (tuning) validateTuning(tuning, evals, y.name);
  const model = composeModel(parent.model, y.model, y.name);
  const modelWarnings = model ? validateModel(model, y.name) : [];
  const requires = composeRequires(parent.requires, y.requires);
  const safety = composeSafety(parent.safety, y.safety);
  const memoryWorkspace = y.memory.workspace ?? parent.memory?.workspace;
  // §9.2: a child's policy replaces the parent's whole block (a closed set does not merge).
  const memoryPolicy = y.memory.policy ?? parent.memory?.policy;
  // §9.3: tenant, topics, reads and writes are the HOP's own; a child that declares topics replaces
  // the parent's set (a closed set does not merge), a child without any inherits the parent's
  const memoryTenant = y.memory.tenant ?? parent.memory?.tenant;
  const ownTopics = y.memory.topics.length > 0 || y.memory.writes.length > 0 || y.memory.reads.length > 0;
  const topics = ownTopics ? y.memory.topics : parent.memory?.topics ?? [];
  const reads = ownTopics ? y.memory.reads : parent.memory?.reads ?? [];
  const writes = ownTopics ? y.memory.writes : parent.memory?.writes ?? [];
  // memory v7: the ontology extension and the registry fields inherit like tenant does
  const ontology = y.memory.ontology.length ? y.memory.ontology : parent.memory?.ontology ?? [];
  const memoryOwner = y.memory.owner ?? parent.memory?.owner;
  const memoryMode = y.memory.mode ?? parent.memory?.mode;
  const memorySharing = y.memory.sharing ?? parent.memory?.sharing;
  const memoryPromotion = y.memory.promotion ?? parent.memory?.promotion;
  const memoryLimits = y.memory.limits ?? parent.memory?.limits;
  // A publication is this HOP version's own (hop-service id); a child never inherits a parent's.
  const memoryPublication = y.memory.publication;
  const memory =
    memoryWorkspace || memoryPolicy || memoryTenant || topics.length || reads.length || writes.length || ontology.length || memoryPromotion || memoryLimits
      ? {
          ...(memoryWorkspace ? { workspace: memoryWorkspace } : {}),
          ...(memoryTenant ? { tenant: memoryTenant } : {}),
          ...(memoryPolicy ? { policy: memoryPolicy } : {}),
          ...(topics.length ? { topics } : {}),
          ...(reads.length ? { reads } : {}),
          ...(writes.length ? { writes } : {}),
          ...(ontology.length ? { ontology } : {}),
          ...(memoryOwner ? { owner: memoryOwner } : {}),
          ...(memoryMode ? { mode: memoryMode } : {}),
          ...(memorySharing ? { sharing: memorySharing } : {}),
          ...(memoryPublication ? { publication: memoryPublication } : {}),
          ...(memoryPromotion ? { promotion: memoryPromotion } : {}),
          ...(memoryLimits ? { limits: memoryLimits } : {}),
        }
      : undefined;
  // Safety is LOCKED whenever present — no child, user setting, or tuner may override it.
  const locked = [...new Set([...parent.locked, ...y.locked, ...(safety ? ["safety"] : [])])];
  if (safety) {
    // A safety block IS a declaration of apply capability; two consequences (§10, §6.2 review 22/24):
    const effectiveDefaultMode = y.permissions.defaultMode ?? parent.permissions.defaultMode;
    if (effectiveDefaultMode === "autopilot") {
      throw new Error(
        `profile "${y.name}" declares a safety block with defaultMode: autopilot — autopilot may not ` +
          `auto-approve a destructive or out-of-scope plan; use cruise (the safety block is enforced in every mode)`,
      );
    }
    if (tuning?.promote === "auto") {
      throw new Error(
        `profile "${y.name}" sets tuning.promote: auto with a safety block present — an apply-capable ` +
          `HOP may not self-promote; use promote: human`,
      );
    }
  }

  const composed: Profile = {
    spec: PROFILE_SPEC_ID,
    name: y.name,
    version: y.version,
    description: y.description || parent.description,
    source,
    dir,
    extendsChain: [...parent.extendsChain, parent.name],
    modules,
    prompts: {
      system: [
        y.prompts.system ? resolvePromptText(y.prompts.system, dir, "prompts.system") : parent.prompts.system,
        ...Object.entries(modules).filter(([, m]) => m.enabled).map(([n, m]) => `\n\n<!-- module: ${n} -->\n${m.prompt}`),
      ].join(""),
      verifierAgent: y.prompts.verifierAgent
        ? resolvePromptText(y.prompts.verifierAgent, dir, "prompts.verifierAgent")
        : parent.prompts.verifierAgent,
      verifierTask: y.verification.agent.task
        ? (task: string, deliverable?: string) =>
            y.verification.agent
              .task!.replaceAll("{task}", task)
              .replaceAll("{deliverable}", deliverable ?? "(no deliverable on disk)")
        : parent.prompts.verifierTask,
    },
    loop: {
      ...parent.loop,
      taskType: y.telemetry.taskType ?? parent.loop.taskType,
      verifyCommandRe: observed.verify,
      envBrokenRe: observed.envBroken,
      churnThreshold: y.verification.antiChurn.threshold ?? parent.loop.churnThreshold,
      summarizerSystem: y.prompts.summarizer
        ? resolvePromptText(y.prompts.summarizer, dir, "prompts.summarizer")
        : parent.loop.summarizerSystem,
      condenserSystem: y.prompts.condenser
        ? resolvePromptText(y.prompts.condenser, dir, "prompts.condenser")
        : parent.loop.condenserSystem,
    },
    verification: {
      observe,
      selfCheck: {
        enabled: y.verification.selfCheck.enabled ?? parent.verification.selfCheck.enabled,
        minEdits: y.verification.selfCheck.minEdits ?? parent.verification.selfCheck.minEdits,
      },
      antiChurn: {
        enabled: y.verification.antiChurn.enabled ?? parent.verification.antiChurn.enabled,
        threshold: y.verification.antiChurn.threshold ?? parent.verification.antiChurn.threshold,
      },
      agent: {
        enabled: y.verification.agent.enabled ?? parent.verification.agent.enabled,
        tier: y.verification.agent.tier ?? parent.verification.agent.tier,
        riskGateMinChangedLines:
          y.verification.agent.riskGateMinChangedLines ?? parent.verification.agent.riskGateMinChangedLines,
        riskGate: y.verification.agent.riskGate ?? parent.verification.agent.riskGate,
        failMode: y.verification.agent.failMode ?? parent.verification.agent.failMode,
      },
    },
    catalog: { profile: y.catalog.profile ?? parent.catalog.profile },
    routing: {
      subagents: (y.routing.subagents ?? parent.routing.subagents) as Profile["routing"]["subagents"],
      classifyStart: y.routing.classifyStart ?? parent.routing.classifyStart,
      escalation: {
        ladder: (y.routing.escalation.ladder ?? parent.routing.escalation.ladder) as "catalog" | "off",
        patience: y.routing.escalation.patience ?? parent.routing.escalation.patience,
      },
    },
    permissions: {
      defaultMode: y.permissions.defaultMode ?? parent.permissions.defaultMode,
      // Deny/allow CONCATENATE down the chain: a child can add rules but never remove a
      // parent's deny — the same one-way-ratchet property the permission cascade has.
      allow: [...parent.permissions.allow, ...(y.permissions.allow ?? [])],
      deny: [...parent.permissions.deny, ...(y.permissions.deny ?? [])],
    },
    tools: composeTools(y.tools.include ?? parent.tools.include, modules),
    budgets: { maxTurns: y.budgets.maxTurns ?? parent.budgets.maxTurns },
    telemetry: { taskType: y.telemetry.taskType ?? parent.telemetry.taskType },
    evals,
    ...(tuning ? { tuning } : {}),
    ...(model ? { model } : {}),
    ...(requires ? { requires } : {}),
    ...(safety ? { safety } : {}),
    ...(memory ? { memory } : {}),
    locked,
    tunable,
    ...(y.model_policy ? { modelPolicy: { allow: y.model_policy.allow ?? [], deny: y.model_policy.deny ?? [] } } : {}),
    ...p4Blocks(parent, y),
    ...(modelWarnings.length ? { warnings: modelWarnings } : {}),
  };
  // Rule 6: a HOP's own pins must fit its own policy (the publisher refuses the same with a 422).
  const outside = pinsOutsidePolicy(composed);
  if (outside.length) {
    throw new Error(`profile "${composed.name}" pins ${outside.join(", ")} but its model_policy denies ${outside.length === 1 ? "it" : "them"}`);
  }
  return composed;
}

function loadFromDir(dir: string, source: ProfileSource, opts: LoadProfileOptions, depth: number): Profile {
  const file = join(dir, "hop.yaml");
  if (!existsSync(file)) {
    throw new Error(`HOP directory ${dir} has no hop.yaml`);
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not valid YAML: ${(e as Error).message}`);
  }
  const result = profileYamlSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0]!;
    const at = first.path.length ? ` at ${first.path.join(".")}` : "";
    throw new Error(`${file} is not a valid profile${at}: ${first.message}`);
  }
  const y = result.data;
  if (depth > 4) {
    throw new Error(`profile extends chain deeper than 4 at ${file} — flatten the hierarchy`);
  }
  const parent = resolveProfile(y.extends, opts, depth + 1, dir);
  return composeProfile(parent, y, dir, source);
}

/** Split a named ref into name + optional `@version` pin. Paths and builtins never reach here. */
function parseHopRef(ref: string): { name: string; version?: string } {
  const at = ref.lastIndexOf("@");
  return at > 0 ? { name: ref.slice(0, at), version: ref.slice(at + 1) } : { name: ref };
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  return 0;
}

/**
 * Resolve a named HOP's directory under a hops root, honoring the flat and versioned layouts (§2).
 * Returns the directory holding hop.yaml, or null if the name is not present here. Throws on an
 * ambiguous layout (both flat and versioned in one `hops/<name>/`) or an unresolvable `@version`.
 */
function resolveNamedHopDir(root: string, ref: string): string | null {
  const { name, version } = parseHopRef(ref);
  const base = hostDir(root, "hops", name);
  if (!existsSync(base)) return null;
  const flat = existsSync(join(base, "hop.yaml"));
  const versions = readdirSync(base).filter((e) => SEMVER_RE.test(e) && existsSync(join(base, e, "hop.yaml")));
  if (flat && versions.length > 0) {
    throw new Error(
      `HOP "${name}" has both a flat hop.yaml and versioned subdirs under ${base} — a single hops/${name}/ ` +
        `must use one layout, not both`,
    );
  }
  if (flat) {
    if (version) {
      throw new Error(
        `HOP "${name}" uses the flat layout (no versions); drop the @${version} pin or move it under ` +
          `hops/${name}/${version}/`,
      );
    }
    return base;
  }
  if (versions.length > 0) {
    if (version) {
      if (!versions.includes(version)) {
        throw new Error(`HOP "${name}@${version}" not found under ${base} (have: ${[...versions].sort(cmpSemver).join(", ")})`);
      }
      return join(base, version);
    }
    return join(base, [...versions].sort(cmpSemver).at(-1)!);
  }
  return null;
}

function resolveProfile(ref: string, opts: LoadProfileOptions, depth: number, fromDir?: string): Profile {
  const builtins = builtinProfiles();
  if (builtins[ref]) return builtins[ref]!;
  // A builtin pinned by version (`coding@1.1.0`, as a session record or a serve names it): the
  // builtin when the version is the one compiled in, an error naming it otherwise.
  if (!ref.includes("/") && ref.includes("@")) {
    const { name, version } = parseHopRef(ref);
    const builtin = builtins[name];
    if (builtin) {
      if (version && version !== builtin.version) throw new Error(`builtin HOP "${name}" is version ${builtin.version} in this build; "${ref}" is not available`);
      return builtin;
    }
  }
  // Explicit or extends-relative path (contains a separator, or is absolute).
  if (ref.includes("/") || isAbsolute(ref)) {
    const base = isAbsolute(ref) ? ref : resolve(fromDir ?? opts.cwd, ref);
    if (!existsSync(base)) {
      throw new Error(`profile path ${base} does not exist`);
    }
    return loadFromDir(base, "path", opts, depth);
  }
  // Named lookup: project then user; each honors flat + versioned layouts and `name@version` pins.
  const project = resolveNamedHopDir(opts.cwd, ref);
  if (project) return loadFromDir(project, "project", opts, depth);
  const user = resolveNamedHopDir(opts.home, ref);
  if (user) return loadFromDir(user, "user", opts, depth);
  throw new Error(
    `unknown HOP "${ref}" — not a builtin (${Object.keys(builtins).join(", ")}), and no hops/${parseHopRef(ref).name}/ ` +
      `(flat or versioned) found under the project or user root; create one with a hop.yaml declaring ` +
      `spec: ${PROFILE_SPEC_ID}`,
  );
}

/** Load and compose a profile. `ref` may be a builtin name, a discovered name, or a path. */
export function loadProfile(ref: string | undefined, opts: LoadProfileOptions): Profile {
  return resolveProfile(ref ?? "coding", opts, 0);
}

/**
 * Apply user/project settings over a composed profile. The user outranks the artifact
 * they installed — EXCEPT for locked paths, where an explicit user override is a hard
 * error naming the locking profile (silent ignoring would make the lock a lie).
 *
 * `explicit` are dot paths present in the merged raw settings layers (pre-defaults), so
 * schema defaults never count as user intent.
 */
export function assertSettingsRespectLocks(
  profile: Profile,
  explicit: Record<string, unknown>,
): void {
  // settings path → profile path it would override. Every settings key that a downstream
  // layer merges onto a profile field must appear here, or a lock on that field is a lie:
  // e.g. a profile locking permissions.allow was silently overridden by a user settings.json
  // allow list (the stronger adversary — the model can be asked to edit that file).
  const map: [string, string][] = [
    ["mode", "permissions.defaultMode"],
    ["maxTurns", "budgets.maxTurns"],
    ["permissions.allow", "permissions.allow"],
    ["permissions.deny", "permissions.deny"],
    ["routing.subtasks", "routing.subagents"],
    ["routing.budget", "routing.subagents"],
    ["routing.escalation", "routing.escalation.ladder"],
    ["routing.escalationPatience", "routing.escalation.patience"],
    ["routing.classifyStart", "routing.classifyStart"],
    ["verify.command", "verification.command"],
    ["verify.auto", "verification.command"],
    ["verify.selfCheck", "verification.selfCheck.enabled"],
    ["verify.selfCheckMinEdits", "verification.selfCheck.minEdits"],
    ["verify.antiChurn", "verification.antiChurn.enabled"],
    ["verify.agent", "verification.agent.enabled"],
  ];
  for (const [settingsPath, profilePath] of map) {
    if (getPath(explicit, settingsPath) === undefined) continue;
    if (profile.locked.some((l) => profilePath === l || profilePath.startsWith(`${l}.`))) {
      throw new Error(
        `settings set "${settingsPath}", but profile "${profile.name}" locks "${profilePath}" — ` +
          `remove the setting or use a profile that does not lock it`,
      );
    }
  }
}

/**
 * memory v13 (DESIGN §2, §5): a HOP's memory contract may name the feature workspace as
 * `{workspace}` (the built-in coding HOP does, with `memory.workspace: from-host`). The host knows
 * the workspace (settings, the HOP, or the directory name) and fills the placeholder once, at load,
 * in every place the model or the service will read it: the system prompt (which carries the
 * work-memory module), module prompts, topic ids, and the reads/writes globs. The memory service
 * resolves `{me}` and `{target}` itself, so those stay. Pure: returns a new profile.
 */
export function fillWorkspace(profile: Profile, workspace: string): Profile {
  const fill = (s: string) => s.replaceAll("{workspace}", workspace);
  const memory = profile.memory
    ? {
        ...profile.memory,
        workspace: profile.memory.workspace === undefined || profile.memory.workspace === "from-host" ? workspace : profile.memory.workspace,
        topics: profile.memory.topics?.map((t) => ({ ...t, id: fill(t.id) })),
        reads: profile.memory.reads?.map(fill),
        writes: profile.memory.writes?.map(fill),
      }
    : profile.memory;
  return {
    ...profile,
    memory,
    modules: Object.fromEntries(Object.entries(profile.modules).map(([n, m]) => [n, { ...m, prompt: fill(m.prompt) }])),
    prompts: { ...profile.prompts, system: fill(profile.prompts.system) },
  };
}
