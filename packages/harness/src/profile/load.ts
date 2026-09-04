import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type {
  EvalSuite,
  ModelPolicy,
  Profile,
  ProfileSource,
  RequiresPolicy,
  SafetyPolicy,
  TuningPolicy,
} from "./types";
import { PROFILE_SPEC_ID } from "./types";
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
    mcp: z.array(z.object({ name: z.string().min(1) }).strict()).default([]),
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
    budgets: z.object({ maxTurns: z.number().int().positive().optional() }).strict().default({}),
    telemetry: z.object({ taskType: z.string().optional() }).strict().default({}),
    evals: z.array(evalSuiteSchema).default([]),
    tuning: tuningSchema.optional(),
    model: modelSchema.optional(),
    requires: requiresSchema.optional(),
    safety: safetySchema.optional(),
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
  return {
    binaries: mergeByName(parent?.binaries ?? [], child?.binaries ?? []),
    mcp: mergeByName(parent?.mcp ?? [], child?.mcp ?? []),
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
  const evals = withGatesDefaults(y.evals.length > 0 ? y.evals : parent.evals);
  const tuning = composeTuning(parent.tuning, y.tuning, y.name);
  if (tuning) validateTuning(tuning, evals, y.name);
  const model = composeModel(parent.model, y.model, y.name);
  const modelWarnings = model ? validateModel(model, y.name) : [];
  const requires = composeRequires(parent.requires, y.requires);
  const safety = composeSafety(parent.safety, y.safety);
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

  return {
    spec: PROFILE_SPEC_ID,
    name: y.name,
    version: y.version,
    description: y.description || parent.description,
    source,
    dir,
    extendsChain: [...parent.extendsChain, parent.name],
    prompts: {
      system: y.prompts.system ? resolvePromptText(y.prompts.system, dir, "prompts.system") : parent.prompts.system,
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
    tools: { include: y.tools.include ?? parent.tools.include },
    budgets: { maxTurns: y.budgets.maxTurns ?? parent.budgets.maxTurns },
    telemetry: { taskType: y.telemetry.taskType ?? parent.telemetry.taskType },
    evals,
    ...(tuning ? { tuning } : {}),
    ...(model ? { model } : {}),
    ...(requires ? { requires } : {}),
    ...(safety ? { safety } : {}),
    locked,
    tunable,
    ...(modelWarnings.length ? { warnings: modelWarnings } : {}),
  };
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
