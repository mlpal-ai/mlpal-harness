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

  test("a memory-tagged tool classes memory unless the HOP lists it explicitly (E5)", () => {
    const claim: SafetyAction = { toolName: "mcp__memory__memory_write", command: "", tags: { memory: true } };
    expect(classifyAction(SAFETY, claim)).toBe("memory");
    expect(evaluateSafety(SAFETY, claim).outcome).toBe("allow");
    const gated: SafetyPolicy = { ...SAFETY, toolClasses: { ...SAFETY.toolClasses, mutative: [...SAFETY.toolClasses.mutative, "mcp__memory__memory_write"] } };
    expect(classifyAction(gated, claim)).toBe("mutative");
    // the tag never launders an `applies` tool: explicit lists and the memory tag are both checked
    // before the applies default, but a memory server's tools are never applies-tagged.
    const untagged: SafetyAction = { toolName: "mcp__memory__memory_write", command: "", tags: {} };
    expect(classifyAction(SAFETY, untagged)).toBe("unknown");
  });

  test("sub-command aware: a destructive sub-command in a chain classifies destructive", () => {
    expect(classifyAction(SAFETY, act("echo hi && terraform destroy"))).toBe("destructive");
  });

  test("unlisted action: applies-tagged => mutative; readOnly-tagged => readOnly; else unknown", () => {
    expect(classifyAction(SAFETY, act("kubectl delete pod x", { applies: true }))).toBe("mutative");
    expect(classifyAction(SAFETY, act("cat notes.md", { readOnly: true }))).toBe("readOnly");
    // Bash is readOnly:false with no applies tag: a command outside every pattern is UNKNOWN, never
    // a read — the trace labels it honestly and the mode (not the envelope) decides it.
    expect(classifyAction(SAFETY, act("kubectl set image deploy/x c=img", {}))).toBe("unknown");
    expect(evaluateSafety(SAFETY, act("kubectl set image deploy/x c=img", {}))).toEqual({ outcome: "allow" }); // ungated
  });
});

describe("classifyAction, D-57: a line is as dangerous as its most dangerous command", () => {
  test("a read beside a write is the write, through every separator and prefix; the read never masks it", () => {
    for (const line of ["aws s3 describe-bucket; terraform apply", "aws s3 describe-bucket && terraform apply", "aws s3 describe-bucket | terraform apply", "(cd infra && terraform apply)", "{ aws s3 describe-bucket; terraform apply; }", "X=1 terraform apply", "env TF_LOG=debug terraform apply", "timeout 600 terraform apply", "sh -c 'terraform apply'", "echo $(terraform apply)"]) {
      expect([line, classifyAction(SAFETY, act(line))]).toEqual([line, "mutative"]);
    }
    for (const line of ["X=1 terraform destroy", "sh -c 'aws s3 describe-bucket; terraform destroy'", "aws s3 describe-bucket || terraform destroy"]) expect([line, classifyAction(SAFETY, act(line))]).toEqual([line, "destructive"]);
    // an applies-tagged tool's unlisted command beside a listed read: the unlisted default (mutative) wins
    expect(classifyAction(SAFETY, act("aws s3 describe-bucket; ./deploy.sh", { applies: true }))).toBe("mutative");
  });

  test("context-only commands add nothing; a read stays a read", () => {
    expect(classifyAction(SAFETY, act("cd /tmp; export AWS_PROFILE=x; aws s3 describe-bucket"))).toBe("readOnly");
    expect(classifyAction(SAFETY, act("cd /tmp"))).toBe("unknown");
  });

  test("fail closed: a line that cannot be decomposed is destructive, so it stops at the edge", () => {
    for (const line of ['aws s3 describe-bucket "unterminated', 'eval "terraform apply"', "sudo terraform apply", "$CMD apply"]) {
      expect([line, classifyAction(SAFETY, act(line))]).toEqual([line, "destructive"]);
    }
    expect(evaluateSafety(SAFETY, act('eval "terraform apply"'), { planApproved: false })).toMatchObject({ outcome: "deny", reason: "policy_denied" });
  });
});

describe("classifyAction, re-review: global flags before the verb", () => {
  const K: SafetyPolicy = { ...SAFETY, toolClasses: { readOnly: ["Bash(kubectl get *)"], mutative: ["Bash(kubectl apply *)", "Bash(terraform apply*)"], destructive: ["Bash(kubectl delete ns *)", "Bash(helm uninstall *)"] } };
  test("the verb-led form is classified; an unknown global is destructive", () => {
    expect(classifyAction(K, act("kubectl -s https://prod delete ns prod"))).toBe("destructive");
    expect(classifyAction(K, act("kubectl --as=admin --context p delete ns prod"))).toBe("destructive");
    expect(classifyAction(K, act("terraform -chdir=infra apply"))).toBe("mutative");
    expect(classifyAction(K, act("helm --kube-context p uninstall web"))).toBe("destructive");
    expect(classifyAction(K, act("kubectl -n x --context p get pods"))).toBe("readOnly");
    expect(classifyAction(K, act("kubectl --whatever get pods"))).toBe("destructive");
  });

  test("re-review r2 minor: -A, an attached -v<N> and --bool=true|false before a read keep it a read", () => {
    for (const line of ["kubectl -A get pods", "kubectl -v6 get pods", "kubectl --insecure-skip-tls-verify=true get pods", "kubectl -nprod get pods"]) {
      expect([line, classifyAction(K, act(line))]).toEqual([line, "readOnly"]);
    }
    expect(classifyAction(K, act("kubectl -shttps://prod delete ns prod"))).toBe("destructive");
  });

  test("R4-1: a kubectl line naming --kuberc is unreadable (destructive), even a read", () => {
    for (const line of ["kubectl get pods --kuberc ./krc", "kubectl --kuberc=./krc get pods", "kubectl apply -f a --kuberc ./krc"]) expect([line, classifyAction(K, act(line))]).toEqual([line, "destructive"]);
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
