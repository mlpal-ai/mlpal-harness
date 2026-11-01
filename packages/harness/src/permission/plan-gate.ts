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
 *
 * D-57: a Bash line is read whole (`planLine`), never by its leading command alone: every plan and apply it runs is
 * found (through `;`, `&&`, `||`, `|`, `&`, subshells, groups, substitutions and `X=1` prefixes), each apply must match
 * a plan, an apply the gate cannot see the context of (a nested shell, an undecomposable line, a `cd` or assignment it
 * cannot read) fails closed, and a dry run is recorded only when its exit status is the line's.
 */
import { decomposeBash } from "./shell-decompose";
import { splitShellCommands } from "./safety";

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

/** A redirection word (`2>&1`, `>out`, `2>/dev/null`, `&>log`, `<in`), or an operator whose target is the next word. */
const REDIRECT = /^(?:\d*(?:>>?|<|>&|<&|>\|)|&>>?)/;
const BARE_REDIRECT = /^(?:\d*(?:>>?|<|>\|)|&>>?)$/;

function words(command: string): string[] {
  // One simple command (planLine splits a line into them): quotes kept together, env assignments and wrappers skipped,
  // redirections dropped (D-56c: `2>&1` is not part of what an apply targets). Anything after an operator is cut, so a
  // caller handing a whole line reads only its first command; planLine never does.
  const head = command.split(/\s*(?:\|\||&&|\||;)\s*/)[0] ?? command;
  const raw: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) raw.push(m[1] ?? m[2] ?? m[3] ?? "");
  const out: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const w = raw[k]!;
    if (REDIRECT.test(w)) {
      if (BARE_REDIRECT.test(w)) k++; // `> file`: the target is the next word
      continue;
    }
    out.push(w);
  }
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
      if (!w.includes("=") && ws[i + 1] && !ws[i + 1]!.startsWith("-") && /^-(?:f|n|o|out|var-file|chdir|namespace|values|file|g|l|p|-context|-kube-context|-kubeconfig|-cluster|-server|-user|-output|-field-manager|-filename|-kustomize|-selector)$/.test(w)) i++;
      // `--dry-run server` (spaced): its mode is not a target (D-56c)
      else if (w === "--dry-run" && ["server", "client", "none"].includes(ws[i + 1] ?? "")) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

/** kubectl verbs that change the cluster; each takes `--dry-run`. */
const KUBECTL_MUTATING = new Set(["apply", "create", "delete", "patch", "replace", "scale", "rollout", "set", "label", "annotate", "taint", "drain", "cordon", "uncordon", "expose", "autoscale", "run", "edit"]);

/** The cluster a kubectl or helm command talks to when it names one: part of what it targets, so a plan against one
 *  context never admits an apply against another. */
function kubeContext(ws: string[]): string[] {
  const out: string[] = [];
  for (const [flag, key] of [["--context", "ctx"], ["--kube-context", "ctx"], ["--kubeconfig", "kubeconfig"], ["--cluster", "cluster"], ["--server", "server"], ["--user", "user"]] as const) {
    const v = flagValue(ws, [flag]);
    if (v) out.push(`${key}=${v}`);
  }
  return out;
}

/** Recognise a plan (dry run) or an apply in ONE simple command; null for anything else. A whole Bash line is read by
 *  `planLine`. */
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
    const verb = positionals(rest, 0)[0];
    // D-57: every verb that changes the cluster is an apply (each takes --dry-run, so each can be planned); `diff` is a
    // plan, keyed like the apply of the same files (D-56).
    if (!verb || !KUBECTL_MUTATING.has(verb) && verb !== "diff") return null;
    const files = flagValues(rest, ["-f", "--filename", "-k", "--kustomize"]);
    const ns = flagValue(rest, ["-n", "--namespace"]) ?? "";
    const pos = positionals(rest, rest.indexOf(verb) + 1);
    const target = [ns && `ns=${ns}`, ...kubeContext(rest), ...files, ...pos].filter(Boolean).join(" ");
    return { kind: verb === "diff" || has("--dry-run") ? "plan" : "apply", tool, target, inputs: files };
  }
  if (tool === "helm") {
    const verb = rest.find((w) => !w.startsWith("-"));
    if (!verb) return null;
    const values = flagValues(rest, ["-f", "--values"]);
    const ns = [flagValue(rest, ["-n", "--namespace"]) ? `ns=${flagValue(rest, ["-n", "--namespace"])}` : "", ...kubeContext(rest)].filter(Boolean).join(" ");
    const pos = positionals(rest, rest.indexOf(verb) + 1);
    if (verb === "diff") return { kind: "plan", tool, target: [ns, ...pos.slice(1, 3)].filter(Boolean).join(" "), inputs: values };
    if (["install", "upgrade", "uninstall", "rollback"].includes(verb)) {
      return { kind: has("--dry-run") ? "plan" : "apply", tool, target: [ns, ...pos.slice(0, 2)].filter(Boolean).join(" "), inputs: values };
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

// ── D-57: the whole line ───────────────────────────────────────────────────────────────────────

/** Tools whose commands the gate reads: a line naming one that the gate cannot read fails closed. */
const GATED_TOOLS = /(?:^|[\s;&|(`$"'/])(?:terraform|tofu|kubectl|oc|helm|pulumi|cdk|az|gcloud|aws)(?=$|[\s;&|)`"'])/;
/** Commands that only set the line's context (its directory, its environment) and run nothing else. */
const CONTEXT_ONLY = new Set(["cd", "pushd", "export", "unset", "true", ":", "set"]);
/** Builtins that change the environment in ways the gate cannot read off the words. */
const ENV_OPAQUE = new Set(["read", "declare", "typeset", "local", "readonly", "let", "alias", "unalias", "hash", "enable", "mapfile", "readarray", "getopts", "for", "popd", "source", ".", "eval"]);
const NOT_LITERAL = /[$`*?~[{]/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/** One plan or apply of a line, with the context it runs in. */
export interface PlanStep {
  pc: PlanCommand;
  /** The directory it runs in: the session's, moved by any `cd`/`pushd` before it on the line. */
  cwd: string;
  /** `NAME=value` assignments in force on the line (`export`, `X=1 cmd`, `env X=1 cmd`), sorted: part of the match key,
   *  so a plan under one KUBECONFIG never admits an apply under another. */
  env: string[];
}

export interface PlanLine {
  steps: PlanStep[];
  /** Why the gate cannot read this line, when it cannot: it could not be decomposed, a plan or apply runs where the
   *  gate cannot see its context (a nested shell, a substitution), or a `cd` or assignment is not literal. Null when it
   *  can. Set only for a line that names a gated tool, or that could not be decomposed at all. */
  unreadable: string | null;
  /** The line's one dry run, when its exit status is the line's: the last command of the line, with nothing but
   *  context-only commands (`cd`, `export`, …) before it. Only such a plan is recorded. */
  recordable: PlanStep | null;
}

/** Strips a part's subshell and group punctuation (`(cd x`, `kubectl apply …)`, `{ cmd; }`). */
function bare(part: string): string {
  return part.replace(/^[\s(!{]+/, "").replace(/[\s)}]+$/, "").trim();
}

/** Reads every plan and apply a Bash line runs, in order, with the directory and environment each runs in. */
export function planLine(command: string, cwd: string): PlanLine {
  const d = decomposeBash(command);
  const gated = GATED_TOOLS.test(command);
  if (d.opaque !== null) return { steps: [], unreadable: `the line cannot be read (${d.opaque})`, recordable: null };
  // What the decomposer sees run, at any depth: the authority on how many plans and applies there are.
  const seen = d.commands.flatMap((c) => (c.forms[0] ? [classifyPlanCommand(c.forms[0])] : [])).filter((pc): pc is PlanCommand => pc !== null);
  const steps: PlanStep[] = [];
  const env = new Map<string, string>();
  let dir = cwd;
  let unreadable: string | null = null;
  const fail = (why: string) => (unreadable ??= why);
  if (/\$\(\([^)]*[^=!<>]=[^=]/.test(command) || /\$\{[A-Za-z_][A-Za-z0-9_]*:?=/.test(command)) fail("an assignment inside an expansion");
  for (const part of splitShellCommands(command).map(bare).filter(Boolean)) {
    const ws = part.split(/\s+/);
    let i = 0;
    for (; i < ws.length; i++) {
      const a = ASSIGN.exec(ws[i]!);
      if (!a) break;
      if (NOT_LITERAL.test(a[2]!)) fail(`a non-literal assignment (${a[1]}=…)`);
      env.set(a[1]!, a[2]!);
    }
    let head = ws[i];
    if (head === "env") {
      for (i++; i < ws.length; i++) {
        const a = ASSIGN.exec(ws[i]!);
        if (a) {
          if (NOT_LITERAL.test(a[2]!)) fail(`a non-literal assignment (${a[1]}=…)`);
          env.set(a[1]!, a[2]!);
        } else if (ws[i]!.startsWith("-")) fail("env with options");
        else break;
      }
      head = ws[i];
    }
    if (head === undefined) continue;
    const args = ws.slice(i + 1);
    if (head === "cd" || head === "pushd") {
      const to = args.filter((w) => !w.startsWith("-"));
      if (to.length !== 1 || NOT_LITERAL.test(to[0]!) || to[0] === "-") fail(`a ${head} the gate cannot follow (${part})`);
      else dir = to[0]!.startsWith("/") ? to[0]! : `${dir.replace(/\/+$/, "")}/${to[0]}`.replace(/\/\.\//g, "/");
      continue;
    }
    if (head === "export") {
      for (const w of args) {
        const a = ASSIGN.exec(w);
        if (w.startsWith("-")) fail("export with options");
        else if (a) {
          if (NOT_LITERAL.test(a[2]!)) fail(`a non-literal assignment (${a[1]}=…)`);
          env.set(a[1]!, a[2]!);
        }
      }
      continue;
    }
    if (head === "unset") {
      for (const w of args) env.delete(w);
      continue;
    }
    if (ENV_OPAQUE.has(head)) {
      fail(`${head} changes the line in a way the gate cannot read`);
      continue;
    }
    const pc = classifyPlanCommand(ws.slice(i).join(" "));
    if (pc) steps.push({ pc, cwd: dir, env: [...env].map(([k, v]) => `${k}=${v}`).sort() });
  }
  // A plan or apply the decomposer sees that the top-level reading did not (inside `sh -c '…'`, `$(…)`, `xargs`): its
  // context is not readable here.
  const count = (pcs: PlanCommand[], kind: PlanKind) => pcs.filter((p) => p.kind === kind).length;
  if (count(seen, "apply") > count(steps.map((s) => s.pc), "apply")) fail("an apply inside a nested shell or substitution");
  if (count(seen, "plan") > count(steps.map((s) => s.pc), "plan")) fail("a dry run inside a nested shell or substitution");
  const last = d.commands[d.commands.length - 1];
  const lastPc = last?.forms[0] ? classifyPlanCommand(last.forms[0]) : null;
  const others = d.commands.slice(0, -1).every((c) => c.forms.length === 0 || CONTEXT_ONLY.has(c.forms[0]!.split(" ")[0]!));
  const plans = steps.filter((s) => s.pc.kind === "plan");
  const recordable = !unreadable && lastPc?.kind === "plan" && others && plans.length === 1 && count(seen, "apply") === 0 ? plans[0]! : null;
  return { steps, unreadable: unreadable && (gated || steps.length > 0 || seen.length > 0) ? unreadable : null, recordable };
}

/** Whether a dry run's exit status means it ran: 0, or the status a plan uses to say "there are changes" (`kubectl
 *  diff` 1, `terraform plan -detailed-exitcode` 2, `helm diff --detailed-exitcode` 2). D-56a. */
export function planExitOk(pc: PlanCommand, command: string, code: number): boolean {
  if (code === 0) return true;
  const verb = (re: RegExp) => re.test(command);
  if ((pc.tool === "kubectl" || pc.tool === "oc") && code === 1 && verb(/\bdiff\b/)) return true;
  if (pc.tool === "terraform" && code === 2 && verb(/-detailed-exitcode\b/)) return true;
  if (pc.tool === "helm" && code === 2 && verb(/\bdiff\b/) && verb(/--detailed-exitcode\b/)) return true;
  return false;
}
