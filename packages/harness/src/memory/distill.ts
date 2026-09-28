import type { AttemptTraceEntry } from "../permission/safety-envelope";
import type { DeviationKind, MemoryPolicy } from "../profile/types";

/**
 * The host-side deviation distiller (hop-v1.1 §9.2, host obligation (c)). The host sees three
 * deviation kinds in its own trace that the model can only report second-hand: a permission
 * gate that refused or parked a call (`refusal`), a verifier that failed a turn (`verifier_fail`),
 * and a run that stopped at the envelope edge (`escalation`). At the end of a run — or a turn, in
 * a conversation — these are written as deviation memories in the §9.2 line grammar without a
 * model in the loop: deterministic, one per distinct deviation, never per retry. The model keeps
 * recording what the host cannot see (`unmodelled`, `correction`, `surprise`).
 */

export interface VerifierOutcome {
  verdict: "PASS" | "FAIL" | "PARTIAL" | "unparsed";
  /** The verifier's own text, from which the first substantive line becomes `observed`. */
  findings: string;
}

export interface RunTerminal {
  subtype: string;
  pending?: { command: string; reason: string };
}

export interface DistillInput {
  policy: MemoryPolicy | undefined;
  runId: string;
  attempts: AttemptTraceEntry[];
  verifier: VerifierOutcome[];
  terminal?: RunTerminal;
}

export interface Deviation {
  kind: DeviationKind;
  /** `dev-<kind>-<short-noun>` — reusing a slug updates the memory, so retries collapse. */
  slug: string;
  /** The §9.2 body: one field per line, parsed by the builder without a model. */
  body: string;
  /** One line for the session notice. */
  summary: string;
}

const HOST_KINDS: DeviationKind[] = ["refusal", "verifier_fail", "escalation"];

/** Which kinds the host records itself under this policy (the conformance statement). */
export function hostRecordedKinds(policy: MemoryPolicy | undefined): DeviationKind[] {
  if (!policy) return [];
  return HOST_KINDS.filter((k) => policy.record.includes(k));
}

function noun(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s/_.-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["the", "a", "an", "to", "of", "in", "on", "for", "and", "with"].includes(w));
  const base = words.slice(0, 3).join("-").replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return base.slice(0, 40) || "unnamed";
}

function body(fields: { kind: DeviationKind; expected: string; observed: string; cause: string; action: string; run: string }): string {
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  return [`kind: ${fields.kind}`, `expected: ${one(fields.expected)}`, `observed: ${one(fields.observed)}`, `cause: ${one(fields.cause)}`, `action: ${one(fields.action)}`, `run: ${fields.run}`].join("\n");
}

function refusals(input: DistillInput): Deviation[] {
  const seen = new Set<string>();
  const out: Deviation[] = [];
  for (const a of input.attempts) {
    if (a.disposition === "allowed") continue;
    const key = `${a.tool}\u0000${a.command.trim()}`;
    if (seen.has(key)) continue; // one per distinct deviation, not per retry
    seen.add(key);
    const what = a.command.trim() ? `${a.tool} ${a.command.trim().slice(0, 120)}` : a.tool;
    const how = a.disposition === "parked" ? "parked for approval" : "refused";
    const why = [a.reason, a.detail].filter(Boolean).join(": ");
    out.push({
      kind: "refusal",
      slug: `dev-refusal-${noun(a.command.trim() || a.tool)}`,
      body: body({
        kind: "refusal",
        expected: `${what} runs as part of the plan`,
        observed: `the permission gate ${how} it${why ? ` (${why})` : ""}`,
        cause: a.reason === "hard_deny" ? "host denial (bypass-immune)" : a.reason ? `policy (${a.reason})` : "policy",
        action: a.disposition === "parked" ? "a person approves the parked call, or the plan avoids it" : "a rule or mode that admits the call, or a plan that does not need it",
        run: input.runId,
      }),
      summary: `refusal: ${what} ${how}`,
    });
  }
  return out;
}

function verifierFails(input: DistillInput): Deviation[] {
  const out: Deviation[] = [];
  let n = 0;
  for (const v of input.verifier) {
    if (v.verdict !== "FAIL") continue;
    n += 1;
    const line = v.findings
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^VERDICT:/i.test(l)) ?? "no findings text";
    out.push({
      kind: "verifier_fail",
      slug: `dev-verifier-fail-${n}`,
      body: body({
        kind: "verifier_fail",
        expected: "the finishing turn passes independent verification",
        observed: `verifier FAIL: ${line.slice(0, 200)}`,
        cause: "unknown",
        action: "fix what the verifier named before finishing; verify it yourself first",
        run: input.runId,
      }),
      summary: `verifier_fail: ${line.slice(0, 80)}`,
    });
  }
  return out;
}

const EDGE: Record<string, string> = {
  needs_approval: "stopped at the approval edge",
  needs_clarification: "stopped for a clarification",
  refused: "refused at the envelope",
};

function escalations(input: DistillInput): Deviation[] {
  const t = input.terminal;
  if (!t || !EDGE[t.subtype]) return [];
  const cmd = t.pending?.command?.trim();
  return [
    {
      kind: "escalation",
      slug: `dev-escalation-${noun(cmd || t.subtype)}`,
      body: body({
        kind: "escalation",
        expected: "the run completes inside the envelope",
        observed: `${EDGE[t.subtype]} (${t.subtype})${cmd ? `: ${cmd.slice(0, 120)}` : ""}${t.pending?.reason ? ` — ${t.pending.reason}` : ""}`,
        cause: "policy: the edge is where a person decides",
        action: cmd ? "a person approves or declines the pending action" : "a person answers, then the run resumes",
        run: input.runId,
      }),
      summary: `escalation: ${EDGE[t.subtype]}${cmd ? ` (${cmd.slice(0, 60)})` : ""}`,
    },
  ];
}

/** Deviations the host records for this run under the HOP's policy. Empty without a policy. */
export function distillDeviations(input: DistillInput): Deviation[] {
  const kinds = new Set(hostRecordedKinds(input.policy));
  if (kinds.size === 0) return [];
  const out: Deviation[] = [];
  if (kinds.has("refusal")) out.push(...refusals(input));
  if (kinds.has("verifier_fail")) out.push(...verifierFails(input));
  if (kinds.has("escalation")) out.push(...escalations(input));
  return out;
}
