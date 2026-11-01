import { describe, expect, test } from "bun:test";
import { classifyPlanCommand, dryRun, matchPlan, type PlanArtifact, planExitOk, planLine, splitGlobals } from "../src/permission/plan-gate";

describe("plan gate: recognising plans and applies", () => {
  test("terraform: plan with -out, apply of the saved plan, destroy; chdir is the target", () => {
    // a saved plan binds itself; an unsaved plan binds the config directory and var files (review M-3)
    expect(classifyPlanCommand("terraform plan -var-file=prod.tfvars -out=tf.plan")).toEqual({ kind: "plan", tool: "terraform", target: ". planfile", inputs: ["tf.plan"], planFile: "tf.plan" });
    expect(classifyPlanCommand("terraform -chdir=infra/eks apply tf.plan")).toEqual({ kind: "apply", tool: "terraform", target: "infra/eks planfile", inputs: ["tf.plan"], planFile: "tf.plan" });
    expect(classifyPlanCommand("terraform destroy -auto-approve")).toEqual({ kind: "apply", tool: "terraform", target: ". -destroy", inputs: ["."] });
    expect(classifyPlanCommand("terraform plan -destroy")).toEqual({ kind: "plan", tool: "terraform", target: ". -destroy", inputs: ["."] });
    expect(classifyPlanCommand("terraform plan -var-file=prod.tfvars -target=module.db")).toEqual({ kind: "plan", tool: "terraform", target: ". -target=module.db", inputs: [".", "prod.tfvars"] });
    expect(classifyPlanCommand("terraform validate")).toBeNull();
    expect(classifyPlanCommand("TF_LOG=debug tofu plan")).toMatchObject({ kind: "plan", tool: "terraform" });
  });

  test("kubectl and helm: server-side dry run is the plan; the same command without it is the apply", () => {
    const dry = classifyPlanCommand("kubectl apply -n mlpal -f k8s/deployment.yaml --dry-run=server");
    const real = classifyPlanCommand("kubectl apply -n mlpal -f k8s/deployment.yaml");
    expect(dry).toEqual({ kind: "plan", tool: "kubectl", target: "ns=mlpal apply -f k8s/deployment.yaml", inputs: ["k8s/deployment.yaml"] });
    expect(real).toEqual({ kind: "apply", tool: "kubectl", target: "ns=mlpal apply -f k8s/deployment.yaml", inputs: ["k8s/deployment.yaml"] });
    expect(classifyPlanCommand("kubectl get pods -n mlpal")).toBeNull();
    expect(classifyPlanCommand("kubectl delete deployment api -n mlpal")).toMatchObject({ kind: "apply", target: "ns=mlpal delete deployment api" });
    expect(classifyPlanCommand("helm upgrade --install api ./chart -n mlpal -f values.yaml --dry-run")).toMatchObject({ kind: "plan", tool: "helm", target: "ns=mlpal upgrade --install api ./chart -f values.yaml", inputs: ["values.yaml"] });
    expect(classifyPlanCommand("helm upgrade --install api ./chart -n mlpal -f values.yaml")).toMatchObject({ kind: "apply", target: "ns=mlpal upgrade --install api ./chart -f values.yaml" });
    expect(classifyPlanCommand("helm diff upgrade api ./chart -n mlpal")).toMatchObject({ kind: "plan", target: "ns=mlpal upgrade api ./chart" });
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
    expect(classifyPlanCommand("ls -la && terraform apply")).toBeNull(); // one simple command; a whole line is planLine's
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

describe("D-57: planLine reads every plan and apply on a line, with its context", () => {
  const applies = (line: string, cwd = "/w") => planLine(line, cwd).steps.filter((s) => s.pc.kind === "apply").map((s) => [s.pc.tool, s.pc.target, s.cwd, s.env.join(" ")]);

  test("every separator, group and prefix; the directory and environment each command runs in", () => {
    const A = "apply -f a.yaml";
    for (const sep of ["; ", " && ", " || ", " | ", " & ", "\n"]) expect(applies(`kubectl get pods${sep}kubectl apply -f a.yaml`)).toEqual([["kubectl", A, "/w", ""]]);
    expect(applies("cd /tmp/demo; export KUBECONFIG=/tmp/demo/kc; kubectl set image deploy/web nginx=x -n web")).toEqual([["kubectl", "ns=web set image deploy/web nginx=x", "/tmp/demo", "KUBECONFIG=/tmp/demo/kc"]]);
    expect(applies("(cd infra && terraform apply tf.plan)")).toEqual([["terraform", ". planfile", "/w/infra", ""]]);
    expect(applies("{ kubectl apply -f a.yaml; }")).toEqual([["kubectl", A, "/w", ""]]);
    expect(applies("X=1 kubectl apply -f a.yaml")).toEqual([["kubectl", A, "/w", "X=1"]]);
    expect(applies("env KUBECONFIG=/k kubectl apply -f a.yaml")).toEqual([["kubectl", A, "/w", "KUBECONFIG=/k"]]);
    expect(applies("kubectl apply -f a.yaml 2>&1 > /tmp/out")).toEqual([["kubectl", A, "/w", ""]]);
    expect(applies("kubectl apply -f a.yaml && helm upgrade api ./chart -n x")).toEqual([["kubectl", A, "/w", ""], ["helm", "ns=x upgrade api ./chart", "/w", ""]]);
    expect(planLine("kubectl get pods | grep web", "/w")).toEqual({ steps: [], unreadable: null, recordable: null });
  });

  test("fail closed: an apply the gate cannot see the context of, or a line it cannot decompose", () => {
    const why = (line: string) => planLine(line, "/w").unreadable;
    expect(why("sh -c 'kubectl apply -f a.yaml'")).toContain("nested");
    expect(why("echo $(kubectl apply -f a.yaml)")).toBeNull(); // an unquoted substitution is read in place
    expect(why('echo "$(kubectl apply -f a.yaml)"')).toContain("nested"); // inside quotes: refused, never missed
    expect(why("xargs -n1 kubectl apply -f < files")).toContain("nested");
    expect(why('kubectl apply -f "a.yaml')).toContain("cannot be read");
    expect(why('eval "kubectl apply -f a.yaml"')).toContain("cannot be read");
    expect(why("cd $DIR && kubectl apply -f a.yaml")).toContain("cannot follow");
    expect(why("KUBECONFIG=$HOME/kc kubectl apply -f a.yaml")).toContain("non-literal");
    expect(why("read KUBECONFIG; kubectl apply -f a.yaml")).toContain("read");
    // nothing gated on the line: nothing to refuse
    expect(why("cd $DIR && ls")).toBeNull();
  });

  test("a dry run is recordable only when its exit status is the line's", () => {
    expect(planLine("cd k8s && export KUBECONFIG=/a && kubectl diff -f a.yaml", "/w").recordable).toMatchObject({ cwd: "/w/k8s", env: ["KUBECONFIG=/a"], pc: { kind: "plan", target: "apply -f a.yaml" } });
    for (const line of ["kubectl diff -f a.yaml | head", "kubectl diff -f a.yaml; echo ok", "kubectl diff -f a.yaml && kubectl apply -f a.yaml", "kubectl diff -f a.yaml && kubectl diff -f b.yaml"]) expect([line, planLine(line, "/w").recordable]).toEqual([line, null]);
  });

  test("D-56a: the statuses a dry run uses to say it found changes", () => {
    const kd = classifyPlanCommand("kubectl diff -f a.yaml")!;
    expect(kd).toEqual({ kind: "plan", tool: "kubectl", target: "apply -f a.yaml", inputs: ["a.yaml"] });
    expect([planExitOk(kd, "kubectl diff -f a.yaml", 0), planExitOk(kd, "kubectl diff -f a.yaml", 1), planExitOk(kd, "kubectl diff -f a.yaml", 2)]).toEqual([true, true, false]);
    const ka = classifyPlanCommand("kubectl apply -f a.yaml --dry-run=server")!;
    expect(planExitOk(ka, "kubectl apply -f a.yaml --dry-run=server", 1)).toBe(false);
    const tf = classifyPlanCommand("terraform plan -detailed-exitcode -out=p")!;
    expect([planExitOk(tf, "terraform plan -detailed-exitcode -out=p", 2), planExitOk(tf, "terraform plan -out=p", 2)]).toEqual([true, false]);
  });

  test("D-56c and D-57: kubectl's mutating verbs are applies; redirections, --dry-run's mode and value flags are not targets", () => {
    for (const verb of ["label", "annotate", "taint", "drain", "cordon", "expose", "autoscale", "run", "edit"]) expect([verb, classifyPlanCommand(`kubectl ${verb} x`)?.kind]).toEqual([verb, "apply"]);
    const plan = classifyPlanCommand("kubectl set image deploy/web nginx=x -n web --dry-run server -o yaml")!;
    const apply = classifyPlanCommand("kubectl set image deploy/web nginx=x -n web --record=false 2>&1")!;
    expect([plan.kind, apply.kind, plan.target]).toEqual(["plan", "apply", apply.target]);
    expect(classifyPlanCommand("kubectl --context prod apply -f a.yaml")!.target).toBe("ctx=prod apply -f a.yaml");
    expect(classifyPlanCommand("helm upgrade api ./c -n x --kube-context prod")!.target).toBe("ns=x ctx=prod upgrade api ./c");
  });
});

describe("D-57 security review", () => {
  test("C-1: only a bare --dry-run or =client|server|true is a dry run; =none, =false or anything else is the change", () => {
    expect(["--dry-run", "--dry-run=client", "--dry-run=server", "--dry-run=true"].map((f) => dryRun(["apply", f]))).toEqual(["plan", "plan", "plan", "plan"]);
    expect(["--dry-run=none", "--dry-run=false", "--dry-run=maybe", "--dry-run=", "--no-dry-run"].map((f) => dryRun(["apply", f]))).toEqual(["apply", "apply", "apply", "apply", "apply"]);
    expect(dryRun(["apply", "--dry-run=server", "--dry-run=none"])).toBe("apply");
    for (const line of ["kubectl apply -f k8s/web.yaml --dry-run=none", "kubectl set image deploy/web web=nginx:evil --dry-run=none", "helm upgrade web ./chart --dry-run=false", "aws ec2 run-instances --dry-run=false"]) expect([line, classifyPlanCommand(line)?.kind]).toEqual([line, "apply"]);
  });

  test("I-1: the verb and every mutating flag are part of the key", () => {
    const k = (c: string) => classifyPlanCommand(c)!.target;
    expect(k("kubectl scale deploy web --replicas=3 --dry-run=server")).not.toBe(k("kubectl scale deploy web --replicas=0"));
    expect(k("kubectl scale deploy web --replicas=3 --dry-run=server")).toBe(k("kubectl scale deploy web --replicas=3"));
    expect(k("kubectl diff -f d")).not.toBe(k("kubectl apply -f d --prune --all"));
    expect(k("helm upgrade api ./c --set image.tag=1 --dry-run")).not.toBe(k("helm upgrade api ./c --set image.tag=2"));
  });

  test("I-3, I-4, M-1, M-2: negation and background are not recordable; rollout reads; run-prefixes are read through", () => {
    expect(planLine("! kubectl apply -f a.yaml --dry-run=server", "/w").recordable).toBeNull();
    expect(planLine("kubectl diff -f a.yaml &", "/w").recordable).toBeNull();
    expect(planLine("kubectl diff -f a.yaml && true", "/w").recordable).toBeNull();
    for (const sub of ["status", "history"]) expect(classifyPlanCommand(`kubectl rollout ${sub} deploy/web`)).toBeNull();
    for (const sub of ["undo", "restart", "pause", "resume"]) expect(classifyPlanCommand(`kubectl rollout ${sub} deploy/web`)?.kind).toBe("apply");
    expect(planLine("kubectl apply -f a.yaml && kubectl rollout status deploy/web", "/w").steps.map((s) => s.pc.kind)).toEqual(["apply"]);
    for (const line of ["timeout 300 terraform apply tfplan", "nice -n 5 kubectl apply -f a.yaml", "command kubectl apply -f a.yaml", "stdbuf -oL kubectl apply -f a.yaml", "timeout -s KILL 5m kubectl apply -f a.yaml"]) {
      const l = planLine(line, "/w");
      expect([line, l.unreadable, l.steps.length]).toEqual([line, null, 1]);
    }
    expect(planLine("timeout 300 kubectl diff -f a.yaml", "/w").recordable).not.toBeNull();
  });
});

describe("re-review: global flags before the verb", () => {
  test("splitGlobals finds the verb past known globals and names an unknown one", () => {
    expect(splitGlobals("kubectl", ["-s", "https://p", "--as=admin", "--context", "c", "delete", "ns", "x"])).toEqual({ globals: ["-s", "https://p", "--as=admin", "--context", "c"], rest: ["delete", "ns", "x"], unknown: null });
    expect(splitGlobals("terraform", ["-chdir=infra", "apply"])).toEqual({ globals: ["-chdir=infra"], rest: ["apply"], unknown: null });
    expect(splitGlobals("helm", ["--kube-context", "p", "uninstall", "web"])?.rest).toEqual(["uninstall", "web"]);
    expect(splitGlobals("kubectl", ["--dry-run=none", "apply", "-f", "a"])?.unknown).toBe("--dry-run=none");
    expect(splitGlobals("jq", ["."])).toBeNull();
  });

  test("the plan gate classifies past the globals and keys server, context and impersonation (never a token's value)", () => {
    expect(classifyPlanCommand("kubectl -s https://prod delete ns prod")).toMatchObject({ kind: "apply", target: "server=https://prod delete ns prod" });
    expect(classifyPlanCommand("kubectl --as=admin --context p delete ns prod")).toMatchObject({ kind: "apply", target: "ctx=p as=admin delete ns prod" });
    expect(classifyPlanCommand("helm --kube-context p uninstall web")).toMatchObject({ kind: "apply", target: "ctx=p uninstall web" });
    expect(classifyPlanCommand("kubectl --token s3cret apply -f a")!.target).not.toContain("s3cret");
    expect(classifyPlanCommand("kubectl --bogus apply -f a")).toMatchObject({ kind: "apply", target: "unreadable --bogus apply -f a" });
  });
});
