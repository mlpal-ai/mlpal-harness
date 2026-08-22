import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Profile, ProfileSource } from "./types";
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

const evalSuiteSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  tasks: z.string().min(1),
  scorer: z.string().min(1),
  runs: z.number().int().positive().default(1),
  passBar: z.number().min(0).max(1).default(1),
});

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
    locked: z.array(z.string()).default([]),
    tunable: z
      .array(z.object({ path: z.string(), range: z.tuple([z.number(), z.number()]) }).strict())
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
      verifierTask: parent.prompts.verifierTask,
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
    evals: y.evals.length > 0 ? y.evals : parent.evals,
    locked: [...new Set([...parent.locked, ...y.locked])],
    tunable,
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
  // Named lookup: project then user.
  const project = hostDir(opts.cwd, "hops", ref);
  if (existsSync(join(project, "hop.yaml"))) return loadFromDir(project, "project", opts, depth);
  const user = hostDir(opts.home, "hops", ref);
  if (existsSync(join(user, "hop.yaml"))) return loadFromDir(user, "user", opts, depth);
  throw new Error(
    `unknown HOP "${ref}" — not a builtin (${Object.keys(builtins).join(", ")}), and neither ` +
      `${project} nor ${user} contains a hop.yaml; create one with a hop.yaml declaring ` +
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
  // settings path → profile path it would override
  const map: [string, string][] = [
    ["mode", "permissions.defaultMode"],
    ["maxTurns", "budgets.maxTurns"],
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
