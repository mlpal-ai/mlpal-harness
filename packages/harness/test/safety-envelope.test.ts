import { describe, expect, test } from "bun:test";
import {
  classifyAction,
  evaluateSafety,
  type SafetyAction,
  type SafetyReason,
  toTraceEntry,
} from "../src/permission/safety-envelope";
import type { SafetyPolicy } from "../src/profile/types";

const SAFETY: SafetyPolicy = {
  toolClasses: {
    readOnly: ["Bash(aws * describe*)", "Read"],
    mutative: ["Bash(terraform apply*)", "Write"],
    destructive: ["Bash(terraform destroy*)", "Bash(*rm -rf*)"],
  },
  preApply: { requirePlanArtifact: true, hash: ["plan", "identity"] },
  blastRadius: { maxResources: 25, accounts: ["self"], regions: ["us-east-2"], requireTag: "HopManaged=true" },
  approval: { destructive: "always", outOfScope: "always", costCeilingUsdMonth: 200 },
  identities: { read: "hop-read", write: "hop-change", neverSelfGrant: true },
};

const act = (command: string, tags: SafetyAction["tags"] = {}, plan?: SafetyAction["plan"]): SafetyAction => ({
  toolName: "Bash",
  command,
  tags,
  ...(plan ? { plan } : {}),
});

describe("classifyAction", () => {
  test("precedence: destructive > mutative > readOnly", () => {
    expect(classifyAction(SAFETY, act("terraform destroy -auto-approve"))).toBe("destructive");
    expect(classifyAction(SAFETY, act("terraform apply -auto-approve"))).toBe("mutative");
    expect(classifyAction(SAFETY, act("aws s3 describe-bucket"))).toBe("readOnly");
  });

  test("sub-command aware: a destructive sub-command in a chain classifies destructive", () => {
    expect(classifyAction(SAFETY, act("echo hi && terraform destroy"))).toBe("destructive");
  });

  test("unlisted action on an applies-tagged tool defaults to mutative, else readOnly", () => {
    expect(classifyAction(SAFETY, act("kubectl delete pod x", { applies: true }))).toBe("mutative");
    expect(classifyAction(SAFETY, act("kubectl get pods", {}))).toBe("readOnly");
  });
});

describe("evaluateSafety", () => {
  test("read-only actions are always free", () => {
    expect(evaluateSafety(SAFETY, act("aws s3 describe-bucket"))).toEqual({ outcome: "allow" });
  });

  test("missing required info parks with missing_info", () => {
    const d = evaluateSafety(SAFETY, act("terraform apply"), { hasRequiredInfo: false });
    expect(d.outcome).toBe("park");
    expect(d.reason).toBe("missing_info");
  });

  test("out-of-envelope account/region/tag parks with out_of_envelope", () => {
    const wrongAcct = evaluateSafety(SAFETY, act("terraform apply", {}, { accounts: ["other"] }), { planApproved: true });
    expect(wrongAcct).toMatchObject({ outcome: "park", reason: "out_of_envelope" });
    const wrongRegion = evaluateSafety(SAFETY, act("terraform apply", {}, { regions: ["eu-west-1"] }), { planApproved: true });
    expect(wrongRegion.reason).toBe("out_of_envelope");
    const untagged = evaluateSafety(SAFETY, act("terraform apply", {}, { tagged: false }), { planApproved: true });
    expect(untagged.reason).toBe("out_of_envelope");
  });

  test("over resource / cost ceiling parks with over_ceiling", () => {
    const tooMany = evaluateSafety(SAFETY, act("terraform apply", {}, { resourceCount: 40 }), { planApproved: true });
    expect(tooMany).toMatchObject({ outcome: "park", reason: "over_ceiling" });
    const tooPricey = evaluateSafety(SAFETY, act("terraform apply", {}, { costUsdMonth: 500 }), { planApproved: true });
    expect(tooPricey.reason).toBe("over_ceiling");
  });

  test("a mutative apply with no reviewed plan is a hard deny (policy_denied)", () => {
    const d = evaluateSafety(SAFETY, act("terraform apply"), { planApproved: false });
    expect(d).toMatchObject({ outcome: "deny", reason: "policy_denied" });
  });

  test("a reviewed destructive plan still parks at the approval edge (needs_approval)", () => {
    const d = evaluateSafety(SAFETY, act("terraform destroy", {}, { resourceCount: 3, accounts: ["self"], regions: ["us-east-2"], tagged: true }), { planApproved: true });
    expect(d).toMatchObject({ outcome: "park", reason: "needs_approval" });
  });

  test("a reviewed in-envelope mutative apply is allowed", () => {
    const d = evaluateSafety(
      SAFETY,
      act("terraform apply", {}, { resourceCount: 3, accounts: ["self"], regions: ["us-east-2"], tagged: true }),
      { planApproved: true, hasRequiredInfo: true },
    );
    expect(d).toEqual({ outcome: "allow" });
  });

  test("the reason enum is exactly the five pinned codes (memory graders depend on this)", () => {
    const reasons: SafetyReason[] = ["policy_denied", "out_of_envelope", "over_ceiling", "needs_approval", "missing_info"];
    expect(reasons).toHaveLength(5);
  });
});

describe("toTraceEntry", () => {
  test("carries the class, outcome, and stable reason; content-free", () => {
    const a = act("terraform destroy", {}, { resourceCount: 1, accounts: ["self"], regions: ["us-east-2"], tagged: true });
    const e = toTraceEntry(SAFETY, a, evaluateSafety(SAFETY, a, { planApproved: true }));
    expect(e).toMatchObject({ tool: "Bash", class: "destructive", disposition: "parked", reason: "needs_approval" });
  });
});
