import type { HopView } from "@mlpal/harness-protocol";
import type { Profile } from "./types";

/**
 * The serialisable view of a composed HOP, for a frontend's HOP panel (`describe_hop`). It is
 * the Profile minus what cannot cross a wire: the nudge and classifier functions and the
 * loop's regexes (shown as their source), with every policy block as the data it is. Nothing
 * here is secret: a HOP's prompts, tools and policies are what the person installed.
 */
export function describeProfile(p: Profile): HopView {
  return {
    name: p.name,
    version: p.version,
    description: p.description,
    source: p.source,
    dir: p.dir,
    extendsChain: p.extendsChain,
    prompts: { system: p.prompts.system, verifierAgent: p.prompts.verifierAgent },
    loop: {
      taskType: p.loop.taskType,
      verifyCommand: p.loop.verifyCommandRe?.source ?? null,
      envBroken: p.loop.envBrokenRe?.source ?? null,
      churnThreshold: p.loop.churnThreshold,
      summarizerSystem: p.loop.summarizerSystem,
      condenserSystem: p.loop.condenserSystem,
      checkpointNudge: Boolean(p.loop.checkpointNudge),
    },
    verification: { ...p.verification },
    catalog: p.catalog,
    routing: { ...p.routing },
    permissions: p.permissions,
    // Absent include (= every registered tool) stays absent on the wire: HopView defers to the
    // Profile's shapes, but protocol 0.22 still types `include` as required (it predates
    // absent = all, [] = none). Widen it to `include?` at the next protocol bump.
    tools: p.tools as HopView["tools"],
    budgets: p.budgets,
    telemetry: p.telemetry,
    evals: p.evals.map((e) => ({ ...e })),
    ...(p.tuning ? { tuning: { ...p.tuning } } : {}),
    ...(p.model ? { model: { ...p.model } } : {}),
    ...(p.requires ? { requires: { ...p.requires } } : {}),
    ...(p.safety ? { safety: { ...p.safety } } : {}),
    ...(p.memory ? { memory: { ...p.memory } } : {}),
    ...(p.modelPolicy ? { modelPolicy: { allow: [...p.modelPolicy.allow], deny: [...p.modelPolicy.deny] } } : {}),
    locked: p.locked,
    tunable: p.tunable,
    modules: p.modules,
    ...(p.warnings?.length ? { warnings: p.warnings } : {}),
  };
}
