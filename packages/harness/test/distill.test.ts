import { describe, expect, test } from "bun:test";
import { distillDeviations, hostRecordedKinds } from "../src/memory/distill";
import type { MemoryPolicy } from "../src/profile/types";

const policy: MemoryPolicy = { record: ["refusal", "verifier_fail", "escalation", "unmodelled"], feeds: ["tune", "evals"] };

describe("host deviation distiller (§9.2 obligation c)", () => {
  test("records nothing without a policy, and only the host-visible kinds the policy names", () => {
    expect(hostRecordedKinds(undefined)).toEqual([]);
    expect(hostRecordedKinds({ record: ["unmodelled", "correction"], feeds: ["tune"] })).toEqual([]);
    expect(hostRecordedKinds(policy)).toEqual(["refusal", "verifier_fail", "escalation"]);
    expect(distillDeviations({ policy: undefined, runId: "r", attempts: [{ tool: "Bash", command: "rm x", class: "mutative", disposition: "denied" }], verifier: [] })).toEqual([]);
  });

  test("a refused or parked attempt becomes one refusal per distinct command, in the line grammar", () => {
    const out = distillDeviations({
      policy,
      runId: "run-1",
      attempts: [
        { tool: "Bash", command: "aws ec2 terminate-instances --instance-ids i-1", class: "destructive", disposition: "denied", reason: "mode_refused", detail: "recon mode is read-only" },
        { tool: "Bash", command: "aws ec2 terminate-instances --instance-ids i-1", class: "destructive", disposition: "denied", reason: "mode_refused", detail: "recon mode is read-only" },
        { tool: "Read", command: "/etc/hosts", class: "readOnly", disposition: "allowed" },
        { tool: "Bash", command: "terraform apply", class: "destructive", disposition: "parked", reason: "needs_approval" },
      ],
      verifier: [],
    });
    expect(out.map((d) => d.kind)).toEqual(["refusal", "refusal"]);
    expect(out[0]!.slug).toBe("dev-refusal-aws-ec2-terminate-instances");
    expect(out[0]!.body.split("\n")).toEqual([
      "kind: refusal",
      "expected: Bash aws ec2 terminate-instances --instance-ids i-1 runs as part of the plan",
      "observed: the permission gate refused it (mode_refused: recon mode is read-only)",
      "cause: policy (mode_refused)",
      "action: a rule or mode that admits the call, or a plan that does not need it",
      "run: run-1",
    ]);
    expect(out[1]!.body).toContain("observed: the permission gate parked for approval it (needs_approval)");
    expect(out[1]!.body).toContain("action: a person approves the parked call");
    expect(out[1]!.summary).toBe("refusal: Bash terraform apply parked for approval");
  });

  test("verifier FAILs and an envelope-edge terminal become verifier_fail and escalation", () => {
    const out = distillDeviations({
      policy,
      runId: "run-2",
      attempts: [],
      verifier: [
        { verdict: "PASS", findings: "VERDICT: PASS\nall good" },
        { verdict: "FAIL", findings: "VERDICT: FAIL\nbun test: 2 failing in parse.test.ts\nMISSING: fix parse()" },
      ],
      terminal: { subtype: "needs_approval", pending: { command: "kubectl delete deployment web", reason: "destructive class" } },
    });
    expect(out.map((d) => d.kind)).toEqual(["verifier_fail", "escalation"]);
    expect(out[0]!.slug).toBe("dev-verifier-fail-1");
    expect(out[0]!.body).toContain("observed: verifier FAIL: bun test: 2 failing in parse.test.ts");
    expect(out[1]!.slug).toBe("dev-escalation-kubectl-delete-deployment");
    expect(out[1]!.body).toContain("observed: stopped at the approval edge (needs_approval): kubectl delete deployment web — destructive class");
    expect(out[1]!.body).toContain("run: run-2");
    // success is not an escalation
    expect(distillDeviations({ policy, runId: "r", attempts: [], verifier: [], terminal: { subtype: "success" } })).toEqual([]);
  });

  test("a policy that names only some host kinds records only those", () => {
    const only: MemoryPolicy = { record: ["escalation"], feeds: ["tune"] };
    const out = distillDeviations({
      policy: only,
      runId: "r",
      attempts: [{ tool: "Bash", command: "x", class: "mutative", disposition: "denied" }],
      verifier: [{ verdict: "FAIL", findings: "VERDICT: FAIL\nno" }],
      terminal: { subtype: "refused" },
    });
    expect(out.map((d) => d.kind)).toEqual(["escalation"]);
  });
});
