/**
 * The preApply plan gate (hop-v1 §10 `safety.preApply`): a mutative apply is admitted only when
 * a reviewed plan artifact for the same target exists in this run and the apply matches it on
 * the fields the HOP names (`hash: [plan, identity, backend, toolVersion, …]`). The envelope
 * already knew how to deny on `state.planApproved === false`; nothing ever computed that
 * signal, so the gate was inert. This module is the pure part: it recognises plan and apply
 * commands, keys them to a target, and decides whether an apply matches a recorded plan. The
 * host records artifacts after a dry run (with the identity, backend and tool version it
 * probed) and asks here at apply time.
 *
 * Why this exists: the three public incidents the infra HOP was built against (a frozen
 * production, a `terraform destroy` on stale state, a deleted production volume) each applied
 * something nobody had reviewed in that form. The gate binds the apply to the plan the person
 * saw, not to "approve deploy".
 */

export type PlanKind = "plan" | "apply";

export interface PlanCommand {
  kind: PlanKind;
  /** terraform | kubectl | helm | pulumi | cdk | az | gcloud | aws */
  tool: string;
  /** What the command acts on: the words that are not flags, after the tool and verb, joined. */
  target: string;
  /** Files the command reads (manifests, var files, a saved plan), relative or absolute. */
  inputs: string[];
  /** terraform `plan -out=<f>` / `apply <f>`: the saved plan file, when one is named. */
  planFile?: string;
}

const TERRAFORM = new Set(["terraform", "tofu"]);

function words(command: string): string[] {
  // Enough shell to split a typical infra command: quotes kept together, env assignments and
  // wrappers skipped. Pipelines and `&&` chains are cut at the first operator: the gate reads
  // only the leading command.
  const head = command.split(/\s*(?:\|\||&&|\||;)\s*/)[0] ?? command;
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  let i = 0;
  while (i < out.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[i]!) || ["sudo", "env", "time", "nohup"].includes(out[i]!))) i++;
  return out.slice(i);
}

function flagValue(ws: string[], names: string[]): string | undefined {
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    for (const n of names) {
      if (w === n && ws[i + 1]) return ws[i + 1];
      if (w.startsWith(`${n}=`)) return w.slice(n.length + 1);
    }
  }
  return undefined;
}

function flagValues(ws: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]!;
    for (const n of names) {
      if (w === n && ws[i + 1]) out.push(ws[i + 1]!);
      else if (w.startsWith(`${n}=`)) out.push(w.slice(n.length + 1));
    }
  }
  return out;
}

function positionals(ws: string[], from: number): string[] {
  const out: string[] = [];
  for (let i = from; i < ws.length; i++) {
    const w = ws[i]!;
    if (w.startsWith("-")) {
      // a flag with a separate value: skip the value when it does not look like a flag
      if (!w.includes("=") && ws[i + 1] && !ws[i + 1]!.startsWith("-") && /^-(?:f|n|o|out|var-file|chdir|namespace|values|file|g|l|p)$/.test(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

/** Recognise a plan (dry run) or an apply; null for anything else. */
export function classifyPlanCommand(command: string): PlanCommand | null {
  const ws = words(command);
  if (ws.length === 0) return null;
  const tool = (ws[0] ?? "").replace(/^.*\//, "");
  const rest = ws.slice(1);
  const has = (f: string) => rest.some((w) => w === f || w.startsWith(`${f}=`));

  if (TERRAFORM.has(tool)) {
    const chdir = flagValue(rest, ["-chdir"]) ?? "";
    const verb = rest.find((w) => !w.startsWith("-"));
    const varFiles = flagValues(rest, ["-var-file"]);
    if (verb === "plan") {
      const out = flagValue(rest, ["-out"]);
      return { kind: "plan", tool: "terraform", target: chdir || ".", inputs: varFiles, ...(out ? { planFile: out } : {}) };
    }
    if (verb === "apply" || verb === "destroy") {
      const pos = positionals(rest, rest.indexOf(verb) + 1);
      const planFile = verb === "apply" ? pos[0] : undefined;
      return { kind: "apply", tool: "terraform", target: chdir || ".", inputs: planFile ? [planFile] : varFiles, ...(planFile ? { planFile } : {}) };
    }
    return null;
  }
  if (tool === "kubectl" || tool === "oc") {
    const verb = rest.find((w) => !w.startsWith("-"));
    if (!verb || !["apply", "create", "delete", "patch", "replace", "scale", "rollout", "set"].includes(verb)) return null;
    const files = flagValues(rest, ["-f", "--filename", "-k", "--kustomize"]);
    const ns = flagValue(rest, ["-n", "--namespace"]) ?? "";
    const pos = positionals(rest, rest.indexOf(verb) + 1);
    const target = [ns && `ns=${ns}`, ...files, ...pos].filter(Boolean).join(" ");
    return { kind: has("--dry-run") ? "plan" : "apply", tool, target, inputs: files };
  }
  if (tool === "helm") {
    const verb = rest.find((w) => !w.startsWith("-"));
    if (!verb) return null;
    const values = flagValues(rest, ["-f", "--values"]);
    const ns = flagValue(rest, ["-n", "--namespace"]) ?? "";
    const pos = positionals(rest, rest.indexOf(verb) + 1);
    if (verb === "diff") return { kind: "plan", tool, target: [ns && `ns=${ns}`, ...pos.slice(1, 3)].filter(Boolean).join(" "), inputs: values };
    if (["install", "upgrade", "uninstall", "rollback"].includes(verb)) {
      return { kind: has("--dry-run") ? "plan" : "apply", tool, target: [ns && `ns=${ns}`, ...pos.slice(0, 2)].filter(Boolean).join(" "), inputs: values };
    }
    return null;
  }
  if (tool === "pulumi") {
    const verb = rest.find((w) => !w.startsWith("-"));
    const stack = flagValue(rest, ["-s", "--stack"]) ?? "";
    if (verb === "preview") return { kind: "plan", tool, target: stack, inputs: [] };
    if (verb === "up" || verb === "destroy") return { kind: "apply", tool, target: stack, inputs: [] };
    return null;
  }
  if (tool === "cdk") {
    const verb = rest.find((w) => !w.startsWith("-"));
    const pos = verb ? positionals(rest, rest.indexOf(verb) + 1) : [];
    if (verb === "diff") return { kind: "plan", tool, target: pos.join(" "), inputs: [] };
    if (verb === "deploy" || verb === "destroy") return { kind: "apply", tool, target: pos.join(" "), inputs: [] };
    return null;
  }
  if (tool === "az") {
    const pos = positionals(rest, 0);
    const verbIdx = pos.findIndex((w) => ["create", "delete", "update", "set", "start", "stop", "restart", "deallocate", "purge"].includes(w));
    if (pos.includes("what-if")) return { kind: "plan", tool, target: pos.filter((w) => w !== "what-if").join(" "), inputs: flagValues(rest, ["--template-file", "-f", "--parameters", "-p"]) };
    if (verbIdx < 0) return null;
    const target = [...pos.slice(0, verbIdx), ...flagValues(rest, ["-n", "--name", "-g", "--resource-group"])].join(" ");
    return { kind: has("--dry-run") || has("--what-if") ? "plan" : "apply", tool, target, inputs: flagValues(rest, ["--template-file", "-f"]) };
  }
  if (tool === "gcloud") {
    const pos = positionals(rest, 0);
    const verbIdx = pos.findIndex((w) => ["create", "delete", "update", "deploy", "destroy", "start", "stop", "resize", "set-iam-policy", "add-iam-policy-binding", "remove-iam-policy-binding"].includes(w));
    if (verbIdx < 0) return null;
    return { kind: has("--dry-run") ? "plan" : "apply", tool, target: pos.join(" "), inputs: flagValues(rest, ["--source", "--config", "--template"]) };
  }
  if (tool === "aws") {
    const pos = positionals(rest, 0);
    // The AWS CLI has no plan step except CloudFormation change sets; everything mutating is an apply.
    const verbIdx = pos.findIndex((w) => /^(create|delete|update|put|modify|terminate|run-instances|start|stop|reboot|deregister|attach|detach|associate|disassociate|authorize|revoke|execute-change-set)/.test(w));
    if (verbIdx < 0) return null;
    if (pos.includes("create-change-set")) return { kind: "plan", tool, target: [pos[0], flagValue(rest, ["--stack-name"]) ?? ""].filter(Boolean).join(" "), inputs: flagValues(rest, ["--template-body", "--template-url"]) };
    if (pos.includes("execute-change-set")) return { kind: "apply", tool, target: [pos[0], flagValue(rest, ["--stack-name"]) ?? ""].filter(Boolean).join(" "), inputs: [] };
    return { kind: has("--dry-run") ? "plan" : "apply", tool, target: pos.join(" "), inputs: [] };
  }
  return null;
}

/** One recorded dry run: what it was for, when, and the fields the apply must match. */
export interface PlanArtifact {
  at: string;
  tool: string;
  target: string;
  cwd: string;
  command: string;
  /** The fields the HOP's `hash` list names, as the host computed them at plan time: `plan`
   *  (the inputs' content hash, or the saved plan file's), `identity`, `backend`, `toolVersion`,
   *  `lockfile`, `policyResults`, … Absent fields are "unknown", and unknown never matches. */
  fields: Record<string, string>;
  /** The dry run's own output hash: what the person reviewed. For the record, not for matching. */
  outputHash?: string;
}

export interface PlanMatch {
  approved: boolean;
  /** A sentence for the person: why, naming the field that differed or the plan that matched. */
  detail: string;
  matched?: PlanArtifact;
}

/** Does an apply match a recorded plan on the HOP's hash fields? The newest plan for the same
 *  tool, target and cwd in this run is the candidate; every named field must be present on both
 *  sides and equal. Older plans are not consulted: a stale plan is exactly what the gate is for. */
export function matchPlan(artifacts: PlanArtifact[], apply: { tool: string; target: string; cwd: string; fields: Record<string, string> }, hashFields: string[]): PlanMatch {
  const candidates = artifacts.filter((a) => a.tool === apply.tool && a.target === apply.target && a.cwd === apply.cwd);
  if (candidates.length === 0) return { approved: false, detail: `no dry run of ${apply.tool} for "${apply.target || apply.cwd}" was recorded in this run; run the plan first` };
  const newest = candidates.reduce((a, b) => (a.at > b.at ? a : b));
  for (const f of hashFields) {
    const want = newest.fields[f];
    const got = apply.fields[f];
    if (want === undefined || got === undefined) return { approved: false, detail: `the plan gate cannot compare "${f}" (${want === undefined ? "not recorded at plan time" : "not known at apply time"})`, matched: newest };
    if (want !== got) return { approved: false, detail: `"${f}" changed since the plan at ${newest.at}: the apply does not match the reviewed plan`, matched: newest };
  }
  return { approved: true, detail: `matches the plan recorded at ${newest.at} on ${hashFields.join(", ")}`, matched: newest };
}
