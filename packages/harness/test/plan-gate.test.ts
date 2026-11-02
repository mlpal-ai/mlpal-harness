import { describe, expect, test } from "bun:test";
import { classifyPlanCommand, dryRun, matchPlan, PLAN_GATE_ENV, type PlanArtifact, planExitOk, planLine, soleKubeApply, splitGlobals } from "../src/permission/plan-gate";

describe("plan gate: recognising plans and applies", () => {
  test("terraform: plan with -out, apply of the saved plan, destroy; chdir is the target", () => {
    // a saved plan binds itself; an unsaved plan binds the config directory and var files (review M-3)
    expect(classifyPlanCommand("terraform plan -var-file=prod.tfvars -out=tf.plan")).toEqual({ kind: "plan", tool: "terraform", bin: "terraform", target: ". planfile", inputs: ["tf.plan"], planFile: "tf.plan" });
    expect(classifyPlanCommand("terraform -chdir=infra/eks apply tf.plan")).toEqual({ kind: "apply", tool: "terraform", bin: "terraform", target: "infra/eks planfile", inputs: ["tf.plan"], planFile: "tf.plan" });
    expect(classifyPlanCommand("terraform destroy -auto-approve")).toEqual({ kind: "apply", tool: "terraform", bin: "terraform", target: ". -destroy", inputs: ["."] });
    expect(classifyPlanCommand("terraform plan -destroy")).toEqual({ kind: "plan", tool: "terraform", bin: "terraform", target: ". -destroy", inputs: ["."] });
    expect(classifyPlanCommand("terraform plan -var-file=prod.tfvars -target=module.db")).toEqual({ kind: "plan", tool: "terraform", bin: "terraform", target: ". -var-file=prod.tfvars -target=module.db", inputs: [".", "prod.tfvars"] });
    expect(classifyPlanCommand("terraform validate")).toBeNull();
    expect(classifyPlanCommand("TF_LOG=debug tofu plan")).toMatchObject({ kind: "plan", tool: "terraform" });
  });

  test("kubectl and helm: server-side dry run is the plan; the same command without it is the apply", () => {
    const dry = classifyPlanCommand("kubectl apply -n mlpal -f k8s/deployment.yaml --dry-run=server");
    const real = classifyPlanCommand("kubectl apply -n mlpal -f k8s/deployment.yaml");
    expect(dry).toEqual({ kind: "plan", tool: "kubectl", bin: "kubectl", target: "ns=mlpal apply --filename=k8s/deployment.yaml", inputs: ["k8s/deployment.yaml"], kube: {} });
    expect(real).toEqual({ kind: "apply", tool: "kubectl", bin: "kubectl", target: "ns=mlpal apply --filename=k8s/deployment.yaml", inputs: ["k8s/deployment.yaml"], kube: {} });
    expect(classifyPlanCommand("kubectl get pods -n mlpal")).toBeNull();
    expect(classifyPlanCommand("kubectl delete deployment api -n mlpal")).toMatchObject({ kind: "apply", target: "ns=mlpal delete deployment api" });
    expect(classifyPlanCommand("helm upgrade --install api ./chart -n mlpal -f values.yaml --dry-run")).toMatchObject({ kind: "plan", tool: "helm", target: "ns=mlpal upgrade --install api ./chart --values=values.yaml", inputs: ["values.yaml", "./chart"], mustExist: ["./chart"] });
    expect(classifyPlanCommand("helm upgrade --install api ./chart -n mlpal -f values.yaml")).toMatchObject({ kind: "apply", target: "ns=mlpal upgrade --install api ./chart --values=values.yaml" });
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
    const A = "apply --filename=a.yaml";
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
    expect(planLine("cd k8s && export KUBECONFIG=/a && kubectl diff -f a.yaml", "/w").recordable).toMatchObject({ cwd: "/w/k8s", env: ["KUBECONFIG=/a"], pc: { kind: "plan", target: "apply --filename=a.yaml" } });
    for (const line of ["kubectl diff -f a.yaml | head", "kubectl diff -f a.yaml; echo ok", "kubectl diff -f a.yaml && kubectl apply -f a.yaml", "kubectl diff -f a.yaml && kubectl diff -f b.yaml"]) expect([line, planLine(line, "/w").recordable]).toEqual([line, null]);
  });

  test("D-56a: the statuses a dry run uses to say it found changes", () => {
    const kd = classifyPlanCommand("kubectl diff -f a.yaml")!;
    expect(kd).toEqual({ kind: "plan", tool: "kubectl", bin: "kubectl", target: "apply --filename=a.yaml", inputs: ["a.yaml"], kube: {} });
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
    expect(classifyPlanCommand("kubectl --context prod apply -f a.yaml")!.target).toBe("ctx=prod apply --filename=a.yaml");
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

describe("re-review r2: canonicalize or refuse", () => {
  const k = (c: string) => classifyPlanCommand(c)!.target;
  const unreadable = (c: string) => expect([c, k(c).startsWith("unreadable ")]).toEqual([c, true]);

  test("R2-1: a repeated context flag is refused (kubectl and helm use the last, a reviewer reads the first)", () => {
    expect(k("kubectl --context dev apply -f k8s/web.yaml --dry-run=server")).toBe("ctx=dev apply --filename=k8s/web.yaml");
    unreadable("kubectl --context dev --context prod apply -f k8s/web.yaml");
    unreadable("kubectl apply -f k8s/web.yaml --context dev --context=prod");
    unreadable("helm --kube-context dev --kube-context prod upgrade web ./c");
    unreadable("kubectl --kubeconfig /a apply -f a --kubeconfig=/b");
    unreadable("kubectl -s https://dev apply -f a --server https://prod");
    unreadable("kubectl --as dev --as=admin apply -f a");
    // a repeated flag on a dry run: nothing is recorded (it is no plan)
    expect(classifyPlanCommand("kubectl --context dev --context prod apply -f a --dry-run=server")?.kind).toBe("apply");
    expect(planLine("kubectl --context dev --context prod apply -f a --dry-run=server", "/w").recordable).toBeNull();
  });

  test("R2-2: the attached -n<ns> keys the namespace; a repeated namespace is refused", () => {
    expect(k("kubectl scale deploy web --replicas=3 --dry-run=server")).toBe("scale deploy web --replicas=3");
    expect(k("kubectl scale deploy web --replicas=3 -nprod")).toBe("ns=prod scale deploy web --replicas=3");
    expect(k("kubectl scale deploy web --replicas=3 -n=prod")).toBe("ns=prod scale deploy web --replicas=3");
    expect(k("kubectl scale deploy web --replicas=3 --namespace=prod")).toBe("ns=prod scale deploy web --replicas=3");
    unreadable("kubectl scale deploy web --replicas=3 -n dev -n prod");
    unreadable("kubectl scale deploy web --replicas=3 -n dev --namespace prod");
    unreadable("helm upgrade web ./c -n dev --namespace=prod");
    expect(k("kubectl -shttps://prod delete ns x")).toBe("server=https://prod delete ns x");
  });

  test("shorthands as pflag reads them, keyed by long name (r3: a combined word is canonicalized, not refused)", () => {
    expect(classifyPlanCommand("kubectl apply -fdeploy.yaml")).toMatchObject({ inputs: ["deploy.yaml"], target: "apply --filename=deploy.yaml" });
    expect(classifyPlanCommand("kubectl apply -Rf manifests/")).toMatchObject({ inputs: ["manifests/"], target: "apply --recursive --filename=manifests/" });
    expect(k("kubectl run debug --rm -it --image=busybox")).toBe("run debug --rm --stdin --tty --image=busybox");
    expect(k("kubectl delete pods --all -Anprod")).toBe("ns=prod delete pods --all --all-namespaces");
    // an unknown bare flag has no known arity: refused; with `=value` its arity is in the word
    unreadable("kubectl apply -f a.yaml --bogus-local");
    expect(k("kubectl apply -f a.yaml --bogus-local=1")).toBe("apply --filename=a.yaml --bogus-local=1");
    // `-f a -f b` accumulates: allowed, in order
    expect(classifyPlanCommand("kubectl apply -f a.yaml -f b.yaml")?.inputs).toEqual(["a.yaml", "b.yaml"]);
  });

  test("helm: helm-diff's --context is lines of context (dropped on the plan), unknown on an upgrade", () => {
    expect(k("helm diff upgrade web ./c --context 3 --detailed-exitcode")).toBe(k("helm upgrade web ./c"));
    unreadable("helm upgrade web ./c --context prod");
  });

  test("terraform/tofu: -x and --x alike, a value flag takes the next word, a repeated scalar is refused", () => {
    expect(k("terraform plan -var env=dev")).not.toBe(k("terraform apply -var env=prod -auto-approve"));
    expect(k("terraform plan -var env=prod")).toBe(k("terraform apply --var=env=prod -auto-approve"));
    expect(k("terraform plan -var a=1 -var a=2")).not.toBe(k("terraform apply -var a=2 -var a=1"));
    expect(k("terraform plan --chdir=prod")).toBe("prod");
    unreadable("terraform -chdir=dev -chdir=prod apply -auto-approve");
    unreadable("terraform plan -out a.plan -out=b.plan");
    unreadable("terraform apply -auto-approve -bogus");
    expect(classifyPlanCommand("tofu plan -var env=dev")).toEqual({ ...classifyPlanCommand("terraform plan -var env=dev")!, bin: "tofu" });
  });
});

describe("re-review r3: bind every file input or refuse", () => {
  const pc = (c: string) => classifyPlanCommand(c)!;
  const k = (c: string) => pc(c).target;
  const unreadable = (c: string) => expect([c, k(c).startsWith("unreadable ")]).toEqual([c, true]);

  test("R3-1 kubectl: --patch-file, --from-file, --from-env-file, TLS files and a comma list are inputs", () => {
    expect(pc("kubectl patch deploy web --patch-file p.yaml --dry-run=server").inputs).toEqual(["p.yaml"]);
    expect(pc("kubectl create configmap c --from-file=cfg.txt --dry-run=server").inputs).toEqual(["cfg.txt"]);
    expect(pc("kubectl create configmap c --from-file=key=conf/ --from-file=b.txt,c.txt --from-env-file=e.env").inputs).toEqual(["conf/", "b.txt", "c.txt", "e.env"]);
    expect(pc("kubectl create secret tls t --cert c.pem --key k.pem").inputs).toEqual(["c.pem", "k.pem"]);
    // pflag string slices split on commas: both manifests are bound, not one file named "a.yaml,b.yaml"
    expect(pc("kubectl apply -f a.yaml,b.yaml").inputs).toEqual(["a.yaml", "b.yaml"]);
    expect(pc("kubectl --kubeconfig /k apply -f a.yaml").inputs).toEqual(["a.yaml", "/k"]);
  });

  test("R3-1 helm: the local chart, --set-file and a --post-renderer script are inputs; unpinned remote sources are refused", () => {
    expect(pc("helm diff upgrade web ./chart")).toMatchObject({ kind: "plan", inputs: ["./chart"], mustExist: ["./chart"] });
    expect(pc("helm upgrade web ./chart")).toMatchObject({ kind: "apply", inputs: ["./chart"], mustExist: ["./chart"] });
    expect(pc("helm install --generate-name ./web-1.2.3.tgz").inputs).toEqual(["./web-1.2.3.tgz"]);
    expect(pc("helm diff upgrade web ./chart --set-file cfg=cfg.txt").inputs).toEqual(["cfg.txt", "./chart"]);
    expect(pc("helm diff upgrade web ./chart --post-renderer ./pr.sh")).toMatchObject({ inputs: ["./pr.sh", "./chart"], mustExist: ["./pr.sh", "./chart"] });
    unreadable("helm upgrade web ./chart --post-renderer kustomize");
    unreadable("helm diff upgrade web bitnami/nginx --repo https://charts.bitnami.com/bitnami");
    unreadable("helm upgrade web bitnami/nginx --repo https://charts.bitnami.com/bitnami");
    unreadable("helm upgrade web oci://registry.example/charts/web");
    unreadable("helm upgrade web oci://registry.example/charts/web --version ^1.2");
    unreadable("helm upgrade web https://example.com/web-1.0.0.tgz --version 1.0.0");
    // an exact version pins a repository chart; a name with no version must be a local chart on disk
    expect(pc("helm upgrade web bitnami/nginx --repo https://charts.bitnami.com/bitnami --version 15.1.0")).toMatchObject({ kind: "apply", inputs: [] });
    expect(pc("helm upgrade web bitnami/nginx")).toMatchObject({ inputs: ["bitnami/nginx"], mustExist: ["bitnami/nginx"] });
    expect(pc("helm upgrade web bitnami/nginx --version 15.1.0").mustExist).toBeUndefined();
    // uninstall and rollback read no chart
    expect(pc("helm uninstall web").inputs).toEqual([]);
  });

  test("R3-1 terraform: -state, -state-out, -backup, -refresh=false, -lock=false, -parallelism are keyed; a -state file is an input", () => {
    const plain = k("terraform plan");
    for (const apply of ["terraform apply -auto-approve -state=prod.tfstate", "terraform apply -auto-approve -refresh=false", "terraform apply -auto-approve -state-out=o.tfstate", "terraform apply -auto-approve -backup=b", "terraform apply -auto-approve -lock=false", "terraform apply -auto-approve -parallelism=50"]) {
      expect([apply, k(apply)]).not.toEqual([apply, plain]);
    }
    expect(k("terraform apply -auto-approve -refresh=true -lock -input=false -no-color")).toBe(plain);
    expect(k("terraform plan -state=prod.tfstate")).toBe(k("terraform apply -auto-approve -state prod.tfstate"));
    expect(pc("terraform plan -state=prod.tfstate").inputs).toEqual([".", "prod.tfstate"]);
    // a saved plan carries its variables and mode; the flags left on the command must agree
    expect(k("terraform plan -var a=1 -destroy -out=tf.plan")).toBe(k("terraform apply tf.plan"));
    expect(k("terraform plan -out=tf.plan")).not.toBe(k("terraform apply -state-out=other.tfstate tf.plan"));
  });

  test("r3 minor: kubectl and helm flags key as --name=value, so spellings match; words with spaces are quoted", () => {
    expect(k("kubectl scale deploy web --replicas 3 --dry-run=server")).toBe(k("kubectl scale deploy web --replicas=3"));
    expect(k("helm diff upgrade web ./chart --set a=1 -f v.yaml")).toBe(k("helm upgrade web ./chart --set=a=1 --values=v.yaml"));
    expect(k("kubectl patch deploy web -p 'x --replicas=3'")).not.toBe(k("kubectl patch deploy web -p x --replicas=3"));
  });
});

describe("kubeconfig binding: the selection flags reach the host", () => {
  test("kubectl gives --kubeconfig, --context, --cluster, --user; helm gives --kubeconfig and --kube-context", () => {
    expect(classifyPlanCommand("kubectl --kubeconfig /k --context dev apply -f a.yaml")?.kube).toEqual({ kubeconfig: "/k", context: "dev" });
    expect(classifyPlanCommand("kubectl apply -f a.yaml --cluster c --user u")?.kube).toEqual({ cluster: "c", user: "u" });
    expect(classifyPlanCommand("helm upgrade web ./chart --kube-context prod --kubeconfig=/k")?.kube).toEqual({ kubeconfig: "/k", context: "prod" });
    expect(classifyPlanCommand("kubectl apply -f a.yaml")?.kube).toEqual({});
  });
});

describe("re-review r4: kuberc is refused, and the variables that switch it are locked", () => {
  test("R4-1: --kuberc on any kubectl line, read or apply, before or after the verb, is an apply no plan matches", () => {
    for (const line of ["kubectl --kuberc ./krc apply -f k8s/web.yaml --dry-run=server", "kubectl --kuberc ./krc apply -f k8s/web.yaml", "kubectl apply -f k8s/web.yaml --kuberc=./krc", "kubectl get pods --kuberc ./krc", "oc --kuberc=./krc get pods"]) {
      const pc = classifyPlanCommand(line)!;
      expect([line, pc.kind, pc.target.startsWith("unreadable (--kuberc")]).toEqual([line, "apply", true]);
    }
    expect(planLine("kubectl --kuberc ./krc apply -f k8s/web.yaml --dry-run=server", "/w").recordable).toBeNull();
  });

  test("R4-1: a line that sets or unsets KUBECTL_KUBERC (or KUBERC) is unreadable, and its dry run is not recorded", () => {
    for (const line of ["KUBECTL_KUBERC=true kubectl apply -f a.yaml", "export KUBECTL_KUBERC=true; kubectl apply -f a.yaml", "unset KUBECTL_KUBERC && kubectl apply -f a.yaml", "env KUBERC=./krc kubectl apply -f a.yaml", "export KUBECTL_KUBERC=true; kubectl diff -f a.yaml"]) {
      const l = planLine(line, "/w");
      expect([line, l.unreadable?.includes("which the plan gate locks"), l.recordable]).toEqual([line, true, null]);
    }
    expect(PLAN_GATE_ENV).toEqual({ KUBECTL_KUBERC: "false" });
  });
});

describe("re-review r5: which binary runs", () => {
  test("R5-1 layer 1: a gated tool run by a path is unreadable, read or apply; a bare name is read and carried as bin", () => {
    for (const line of ["./kubectl apply -f k8s/web.yaml", "/tmp/x/kubectl apply -f k8s/web.yaml", "./kubectl diff -f k8s/web.yaml", "bin/helm upgrade web ./chart", "./terraform apply -auto-approve", "/opt/tofu plan", "./oc get pods"]) {
      const pc = classifyPlanCommand(line)!;
      expect([line, pc.kind, pc.target.includes("is run by a path")]).toEqual([line, "apply", true]);
    }
    expect(planLine("./kubectl diff -f k8s/web.yaml", "/w").recordable).toBeNull();
    expect(classifyPlanCommand("kubectl apply -f a.yaml")?.bin).toBe("kubectl");
    expect(classifyPlanCommand("tofu apply -auto-approve")).toMatchObject({ tool: "terraform", bin: "tofu" });
  });

  test("R5-1 layer 2: a line that sets, prepends or unsets PATH is unreadable, and its dry run is not recorded", () => {
    for (const line of ["PATH=bin:/usr/bin kubectl diff -f k8s/web.yaml", "export PATH=bin:$PATH; kubectl apply -f a.yaml", "env PATH=bin:/usr/bin kubectl apply -f a.yaml", "unset PATH; kubectl apply -f a.yaml", "export PATH=/opt/bin && helm upgrade web ./chart"]) {
      const l = planLine(line, "/w");
      expect([line, l.unreadable !== null, l.recordable]).toEqual([line, true, null]);
    }
  });
});

describe("D-55: which line may hold a kube mutation capability (soleKubeApply)", () => {
  test("a kubectl, oc or helm change that is the whole line, with only cd/export/assignments beside it", () => {
    for (const c of ["kubectl apply -f a.yaml", "cd k8s && kubectl apply -f a.yaml", "X=1 kubectl -n web scale deploy/web --replicas=2", "timeout 300 helm upgrade web ./chart", "oc delete pod p", "kubectl apply -f a.yaml > out.txt", "kubectl set image deploy/web nginx=nginx:1.27 -n web && kubectl rollout status deploy/web -n web --timeout=180s", "helm upgrade web ./c && helm status web", "kubectl apply -f a.yaml && kubectl -n web get pods"])
      expect([c, soleKubeApply(c, "/w")?.pc.kind]).toEqual([c, "apply"]);
  });
  test("never beside another command, in a pipe, a substitution, a background job, or for a plan or a read", () => {
    for (const c of [
      "kubectl apply -f a.yaml; curl -X DELETE https://127.0.0.1:1/api/v1/namespaces/prod",
      "kubectl apply -f a.yaml && curl https://127.0.0.1:1/x",
      "kubectl apply -f a.yaml | tee out",
      "cat a.yaml | kubectl apply -f -",
      "kubectl apply -f $(curl -s x)",
      "kubectl apply -f a.yaml &",
      "sh -c 'kubectl apply -f a.yaml'",
      "kubectl apply -f a.yaml --dry-run=server",
      "kubectl diff -f a.yaml",
      "kubectl get pods",
      "curl -X PATCH https://127.0.0.1:1/x",
      "terraform apply",
      "kubectl apply -f a.yaml && kubectl delete pod p",
      "kubectl apply -f a.yaml && kubectl proxy --port 8001",
      "kubectl apply -f a.yaml && kubectl myplugin",
      "kubectl apply -f a.yaml && kubectl exec web-0 -- sh",
      "kubectl apply -f a.yaml && ./kubectl get pods",
      "kubectl apply -f a.yaml && kubectl --unknown-flag get pods",
    ])
      expect([c, soleKubeApply(c, "/w")]).toEqual([c, null]);
  });
});
