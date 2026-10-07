import { describe, expect, test } from "bun:test";
import { classifyPlanCommand, matchPlan, type PlanArtifact } from "../src/permission/plan-gate";

describe("plan gate: recognising plans and applies", () => {
  test("terraform: plan with -out, apply of the saved plan, destroy; chdir is the target", () => {
    expect(classifyPlanCommand("terraform plan -var-file=prod.tfvars -out=tf.plan")).toEqual({ kind: "plan", tool: "terraform", target: ".", inputs: ["prod.tfvars"], planFile: "tf.plan" });
    expect(classifyPlanCommand("terraform -chdir=infra/eks apply tf.plan")).toEqual({ kind: "apply", tool: "terraform", target: "infra/eks", inputs: ["tf.plan"], planFile: "tf.plan" });
    expect(classifyPlanCommand("terraform destroy -auto-approve")).toEqual({ kind: "apply", tool: "terraform", target: ".", inputs: [] });
    expect(classifyPlanCommand("terraform validate")).toBeNull();
    expect(classifyPlanCommand("TF_LOG=debug tofu plan")).toMatchObject({ kind: "plan", tool: "terraform" });
  });

  test("kubectl and helm: server-side dry run is the plan; the same command without it is the apply", () => {
    const dry = classifyPlanCommand("kubectl apply -n mlpal -f k8s/deployment.yaml --dry-run=server");
    const real = classifyPlanCommand("kubectl apply -n mlpal -f k8s/deployment.yaml");
    expect(dry).toEqual({ kind: "plan", tool: "kubectl", target: "ns=mlpal k8s/deployment.yaml", inputs: ["k8s/deployment.yaml"] });
    expect(real).toEqual({ kind: "apply", tool: "kubectl", target: "ns=mlpal k8s/deployment.yaml", inputs: ["k8s/deployment.yaml"] });
    expect(classifyPlanCommand("kubectl get pods -n mlpal")).toBeNull();
    expect(classifyPlanCommand("kubectl delete deployment api -n mlpal")).toMatchObject({ kind: "apply", target: "ns=mlpal deployment api" });
    expect(classifyPlanCommand("helm upgrade --install api ./chart -n mlpal -f values.yaml --dry-run")).toMatchObject({ kind: "plan", tool: "helm", target: "ns=mlpal api ./chart", inputs: ["values.yaml"] });
    expect(classifyPlanCommand("helm upgrade --install api ./chart -n mlpal -f values.yaml")).toMatchObject({ kind: "apply", target: "ns=mlpal api ./chart" });
    expect(classifyPlanCommand("helm diff upgrade api ./chart -n mlpal")).toMatchObject({ kind: "plan", target: "ns=mlpal api ./chart" });
  });

  test("the other clouds: az what-if, gcloud --dry-run, aws change sets, pulumi preview; a pipeline reads only its head", () => {
    expect(classifyPlanCommand("az deployment group what-if -g rg -f main.bicep")).toMatchObject({ kind: "plan", tool: "az", inputs: ["main.bicep"] });
    expect(classifyPlanCommand("az vm delete -n web -g rg --yes")).toMatchObject({ kind: "apply", tool: "az", target: "vm web rg" });
    expect(classifyPlanCommand("az vm list")).toBeNull();
    expect(classifyPlanCommand("gcloud compute instances create x --dry-run")).toMatchObject({ kind: "plan", tool: "gcloud" });
    expect(classifyPlanCommand("gcloud sql instances delete db")).toMatchObject({ kind: "apply", tool: "gcloud", target: "sql instances delete db" });
    expect(classifyPlanCommand("aws cloudformation create-change-set --stack-name s --template-body file://t.yaml")).toMatchObject({ kind: "plan", tool: "aws", target: "cloudformation s" });
    expect(classifyPlanCommand("aws cloudformation execute-change-set --stack-name s --change-set-name c")).toMatchObject({ kind: "apply", target: "cloudformation s" });
    expect(classifyPlanCommand("aws ec2 terminate-instances --instance-ids i-1")).toMatchObject({ kind: "apply", tool: "aws" });
    expect(classifyPlanCommand("aws ec2 describe-instances")).toBeNull();
    expect(classifyPlanCommand("pulumi preview -s prod")).toMatchObject({ kind: "plan", target: "prod" });
    expect(classifyPlanCommand("pulumi up -s prod --yes | tee up.log")).toMatchObject({ kind: "apply", target: "prod" });
    expect(classifyPlanCommand("ls -la && terraform apply")).toBeNull(); // only the leading command is read
    expect(classifyPlanCommand("")).toBeNull();
  });
});

describe("plan gate: matching an apply to the recorded plan", () => {
  const plan = (over: Partial<PlanArtifact> = {}): PlanArtifact => ({ at: "2026-10-07T10:00:00Z", tool: "terraform", target: "infra/eks", cwd: "/w", command: "terraform -chdir=infra/eks plan -out=tf.plan", fields: { plan: "p1", identity: "arn:aws:iam::1:user/a", backend: "s3:bucket/key", toolVersion: "1.9.5" }, ...over });
  const apply = { tool: "terraform", target: "infra/eks", cwd: "/w", fields: { plan: "p1", identity: "arn:aws:iam::1:user/a", backend: "s3:bucket/key", toolVersion: "1.9.5" } };
  const HASH = ["plan", "identity", "backend", "toolVersion"];

  test("approved when the newest plan for the same target matches on every named field", () => {
    const r = matchPlan([plan({ at: "2026-10-07T09:00:00Z", fields: { ...apply.fields, plan: "old" } }), plan()], apply, HASH);
    expect(r.approved).toBe(true);
    expect(r.detail).toContain("matches the plan recorded at 2026-10-07T10:00:00Z");
  });

  test("refused, naming why: no plan, a different target, a changed field, a field nobody recorded, a stale newer plan", () => {
    expect(matchPlan([], apply, HASH)).toMatchObject({ approved: false, detail: expect.stringContaining("no dry run of terraform") });
    expect(matchPlan([plan({ target: "infra/rds" })], apply, HASH).approved).toBe(false);
    expect(matchPlan([plan({ cwd: "/elsewhere" })], apply, HASH).approved).toBe(false);
    const changed = matchPlan([plan()], { ...apply, fields: { ...apply.fields, identity: "arn:aws:iam::1:user/b" } }, HASH);
    expect(changed).toMatchObject({ approved: false, detail: expect.stringContaining('"identity" changed since the plan') });
    const unknown = matchPlan([plan({ fields: { plan: "p1" } })], apply, HASH);
    expect(unknown.detail).toContain('cannot compare "identity" (not recorded at plan time)');
    const applyUnknown = matchPlan([plan()], { ...apply, fields: { plan: "p1" } }, HASH);
    expect(applyUnknown.detail).toContain("not known at apply time");
    // the newest plan is the only candidate: a later plan that no longer matches is not rescued by an older one that did
    const stale = matchPlan([plan(), plan({ at: "2026-10-07T11:00:00Z", fields: { ...apply.fields, plan: "p2" } })], apply, HASH);
    expect(stale.approved).toBe(false);
    expect(stale.detail).toContain('"plan" changed');
    expect(matchPlan([plan()], apply, []).approved).toBe(true); // a HOP that names no fields only needs the plan to exist
  });
});

describe("plan gate: through the envelope", () => {
  test("a mutative apply with planApproved false is denied with the gate's reason in the detail; undefined stays ungated", async () => {
    const { evaluateSafety } = await import("../src/permission/safety-envelope");
    const safety = {
      toolClasses: { readOnly: ["Bash(kubectl get *)"], mutative: ["Bash(kubectl apply *)"], destructive: ["Bash(kubectl delete *)"] },
      preApply: { requirePlanArtifact: true, hash: ["plan"] },
      blastRadius: {},
      approval: {},
    } as never;
    const action = { toolName: "Bash", command: "kubectl apply -f deploy.yaml", tags: { applies: true } };
    const denied = evaluateSafety(safety, action, { planApproved: false, planDetail: 'no dry run of kubectl for "deploy.yaml" was recorded in this run; run the plan first' });
    expect(denied).toMatchObject({ outcome: "deny", reason: "policy_denied" });
    expect((denied as { detail?: string }).detail).toBe('no reviewed plan artifact for this apply (preApply): no dry run of kubectl for "deploy.yaml" was recorded in this run; run the plan first');
    expect(evaluateSafety(safety, action, { planApproved: true }).outcome).toBe("allow");
    expect(evaluateSafety(safety, action, {}).outcome).toBe("allow"); // no host signal: the envelope does not guess
  });
});
