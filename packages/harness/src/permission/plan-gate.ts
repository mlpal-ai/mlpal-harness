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
 *
 * Re-review r2, canonicalize or refuse: kubectl, oc, helm and terraform flags are read the way the tool reads them
 * (`canonicalFlags`, `terraformFlags`): attached shorthands, `--flag=value`, a value flag taking the next word. The
 * effective namespace, context, kubeconfig, server and impersonation lead the key; a flag that does not accumulate but
 * appears twice, an unknown bare flag (arity unknown), or a combined shorthand mixing keyed and kept flags is refused.
 */
import { createHash } from "node:crypto";
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

/** Whether a command's `--dry-run` makes it a dry run (review C-1). Only the bare flag (kubectl's and helm's default
 *  is `client`; aws's and gcloud's is a boolean) and `=client`, `=server`, `=true` are; `--dry-run=none`, `=false` or
 *  any other value runs the change for real, so it is an apply (fail closed). Absent: an apply. */
export function dryRun(ws: string[]): "plan" | "apply" {
  let mode: "plan" | "apply" = "apply";
  for (const w of ws) {
    if (w === "--dry-run") mode = mode === "apply" ? "plan" : mode;
    else if (w.startsWith("--dry-run=")) {
      if (!["client", "server", "true"].includes(w.slice("--dry-run=".length))) return "apply";
      mode = "plan";
    }
  }
  return mode;
}

/** kubectl verbs that change the cluster; each takes `--dry-run`. */
const KUBECTL_MUTATING = new Set(["apply", "create", "delete", "patch", "replace", "scale", "rollout", "set", "label", "annotate", "taint", "drain", "cordon", "uncordon", "expose", "autoscale", "run", "edit"]);

/** A tool's flags as its own parser reads them (pflag for kubectl, oc and helm; Go's flag package for terraform):
 *  long names that take a value word, names that do not (booleans, and flags whose bare form sets a default such as
 *  `--dry-run`, `--cascade`, `--validate`: those take a value only as `--flag=value`), one-letter shorthands, and the
 *  names that may repeat because they accumulate (`-f`, `--set`, `--env`). `goStyle`: `-name` and `--name` are the same
 *  flag and there are no shorthands. */
interface FlagSpec {
  value: Set<string>;
  bool: Set<string>;
  short: Record<string, string>;
  repeatable: Set<string>;
  goStyle?: boolean;
}

const KUBE_GLOBAL_VALUE = ["server", "context", "kubeconfig", "cluster", "user", "token", "as", "as-group", "as-uid", "namespace", "request-timeout", "v", "tls-server-name", "certificate-authority", "client-certificate", "client-key", "username", "password", "cache-dir", "profile", "profile-output", "log-file", "log-dir", "vmodule", "stderrthreshold", "log-file-max-size", "log-flush-frequency", "kuberc"];
const KUBE_GLOBAL_BOOL = ["insecure-skip-tls-verify", "match-server-version", "warnings-as-errors", "disable-compression", "alsologtostderr", "logtostderr", "skip-headers", "skip-log-headers", "one-output", "add-dir-header", "help"];
/** The local flags of kubectl's mutating verbs and `diff`. A flag missing here is read only as `--flag=value`; bare, its
 *  arity is unknown and the line is refused (canonicalize or refuse). */
const KUBE_LOCAL_VALUE = ["filename", "kustomize", "output", "template", "selector", "field-selector", "field-manager", "patch", "patch-file", "type", "replicas", "current-replicas", "resource-version", "timeout", "grace-period", "image", "port", "target-port", "name", "protocol", "external-ip", "load-balancer-ip", "session-affinity", "cluster-ip", "min", "max", "cpu-percent", "env", "containers", "from", "keys", "prefix", "resource", "limits", "requests", "serviceaccount", "to-revision", "pod-selector", "chunk-size", "labels", "restart", "overrides", "image-pull-policy", "subresource", "raw", "prune-allowlist", "prune-whitelist", "applyset", "from-file", "from-literal", "from-env-file", "skip-wait-for-delete-timeout", "concurrency", "schedule", "node-port", "tcp", "clusterrole", "role", "group", "verb", "resource-name", "annotations", "docker-server", "docker-username", "docker-password", "docker-email", "cert", "key", "class", "rule", "default-backend", "hostport", "revision"];
const KUBE_LOCAL_BOOL = ["all", "all-namespaces", "overwrite", "force", "now", "wait", "ignore-not-found", "recursive", "server-side", "force-conflicts", "prune", "save-config", "list", "local", "ignore-daemonsets", "delete-emptydir-data", "delete-local-data", "disable-eviction", "rm", "stdin", "tty", "attach", "command", "quiet", "privileged", "edit", "windows-line-endings", "openapi-patch", "record", "show-managed-fields", "interactive", "resolve", "dry-run", "cascade", "validate", "expose", "append-hash", "leave-stdin-open", "allow-missing-template-keys"];
const KUBE: FlagSpec = {
  value: new Set([...KUBE_GLOBAL_VALUE, ...KUBE_LOCAL_VALUE]),
  bool: new Set([...KUBE_GLOBAL_BOOL, ...KUBE_LOCAL_BOOL]),
  short: { s: "server", n: "namespace", v: "v", f: "filename", k: "kustomize", o: "output", l: "selector", p: "patch", A: "all-namespaces", R: "recursive", e: "env", c: "containers", i: "stdin", t: "tty", q: "quiet", h: "help" },
  repeatable: new Set(["filename", "kustomize", "env", "as-group", "prune-allowlist", "prune-whitelist", "from-file", "from-literal", "from-env-file", "annotations", "verb", "resource", "resource-name", "rule", "tcp", "group", "serviceaccount"]),
};
/** Before the verb, kubectl takes its global flags and, as cobra finds the verb past them, `-A` (common on reads). */
const KUBE_GLOBALS: FlagSpec = { value: new Set(KUBE_GLOBAL_VALUE), bool: new Set([...KUBE_GLOBAL_BOOL, "all-namespaces"]), short: { s: "server", n: "namespace", v: "v", A: "all-namespaces", h: "help" }, repeatable: new Set(["as-group"]) };

const HELM_GLOBAL_VALUE = ["kube-context", "kubeconfig", "namespace", "kube-apiserver", "kube-as-user", "kube-as-group", "kube-token", "kube-ca-file", "kube-tls-server-name", "registry-config", "repository-cache", "repository-config", "burst-limit", "qps", "content-cache"];
const HELM_GLOBAL_BOOL = ["debug", "kube-insecure-skip-tls-verify", "help"];
/** helm install/upgrade/uninstall/rollback and the helm-diff plugin's `diff upgrade|install|rollback`. */
const HELM_LOCAL_VALUE = ["set", "set-string", "set-file", "set-json", "set-literal", "values", "version", "timeout", "description", "repo", "post-renderer", "post-renderer-args", "history-max", "username", "password", "ca-file", "cert-file", "key-file", "keyring", "name-template", "labels", "output", "max", "suppress", "suppress-output-line-regex", "find-renames"];
const HELM_LOCAL_BOOL = ["install", "atomic", "create-namespace", "reuse-values", "reset-values", "reset-then-reuse-values", "force", "force-replace", "force-conflicts", "devel", "keep-history", "cleanup-on-fail", "no-hooks", "skip-crds", "wait-for-jobs", "recreate-pods", "generate-name", "render-subchart-notes", "disable-openapi-validation", "dependency-update", "take-ownership", "rollback-on-failure", "insecure-skip-tls-verify", "plain-http", "pass-credentials", "verify", "enable-dns", "skip-schema-validation", "hide-notes", "ignore-not-found", "detailed-exitcode", "suppress-secrets", "three-way-merge", "allow-unreleased", "normalize-manifests", "show-secrets", "show-secrets-decoded", "no-color", "color", "strip-trailing-cr", "disable-validation", "include-tests", "include-crds", "dry-run", "wait", "cascade", "server-side"];
const HELM: FlagSpec = {
  value: new Set([...HELM_GLOBAL_VALUE, ...HELM_LOCAL_VALUE]),
  bool: new Set([...HELM_GLOBAL_BOOL, ...HELM_LOCAL_BOOL]),
  short: { n: "namespace", f: "values", i: "install", g: "generate-name", o: "output", l: "labels", h: "help" },
  repeatable: new Set(["set", "set-string", "set-file", "set-json", "set-literal", "values", "post-renderer-args", "kube-as-group", "suppress", "suppress-output-line-regex"]),
};
/** `helm diff upgrade|install|rollback`: helm-diff adds `-C/--context`, lines of context (helm itself has no such flag,
 *  so on any other verb it is unknown and refused). */
const HELM_DIFF: FlagSpec = { ...HELM, value: new Set([...HELM.value, "context"]), short: { ...HELM.short, C: "context" } };
const HELM_GLOBALS: FlagSpec = { value: new Set(HELM_GLOBAL_VALUE), bool: new Set(HELM_GLOBAL_BOOL), short: { n: "namespace", h: "help" }, repeatable: new Set(["kube-as-group"]) };

const TF_GLOBALS: FlagSpec = { value: new Set(["chdir"]), bool: new Set(["help", "version"]), short: {}, repeatable: new Set(), goStyle: true };
/** terraform/tofu `plan`, `apply` and `destroy`, with the global `-chdir`. */
const TF: FlagSpec = {
  value: new Set(["chdir", "var", "var-file", "target", "replace", "exclude", "out", "state", "state-out", "backup", "lock-timeout", "parallelism", "generate-config-out"]),
  bool: new Set(["auto-approve", "destroy", "refresh-only", "detailed-exitcode", "input", "lock", "compact-warnings", "no-color", "json", "refresh", "help", "version"]),
  short: {},
  repeatable: new Set(["var", "var-file", "target", "replace", "exclude"]),
  goStyle: true,
};

/** A terraform command's words with every flag rewritten `-name=value`, and each flag's values; or why it cannot be. */
function terraformFlags(ws: string[]): { words: string[]; values: Map<string, string[]>; why: string | null } {
  const words: string[] = [];
  const values = new Map<string, string[]>();
  for (let i = 0; i < ws.length; ) {
    const w = ws[i]!;
    if (!isFlag(w) || w === "--") {
      words.push(w);
      i++;
      continue;
    }
    const r = readFlag(TF, ws, i);
    if (!r.ok) return { words, values, why: r.why };
    for (const f of r.flags) {
      const seen = values.get(f.name) ?? [];
      if (seen.length > 0 && !TF.repeatable.has(f.name)) return { words, values, why: `-${f.name} given more than once` };
      values.set(f.name, [...seen, f.value]);
      words.push(TF.bool.has(f.name) && f.value === "true" ? `-${f.name}` : `-${f.name}=${f.value}`);
    }
    i = r.next;
  }
  return { words, values, why: null };
}

const AWS_GLOBALS: FlagSpec = {
  value: new Set(["profile", "region", "output", "endpoint-url", "query", "color", "ca-bundle", "cli-read-timeout", "cli-connect-timeout", "cli-binary-format"]),
  bool: new Set(["no-verify-ssl", "no-paginate", "debug", "no-sign-request", "no-cli-pager", "cli-auto-prompt", "no-cli-auto-prompt"]),
  short: {},
  repeatable: new Set(),
};
const GLOBALS: Record<string, FlagSpec> = { kubectl: KUBE_GLOBALS, oc: KUBE_GLOBALS, helm: HELM_GLOBALS, terraform: TF_GLOBALS, tofu: TF_GLOBALS, aws: AWS_GLOBALS };

interface FlagHit {
  name: string;
  value: string;
  known: boolean;
}
type FlagRead = { ok: true; flags: FlagHit[]; next: number } | { ok: false; why: string };

/** Reads the flag word at `ws[i]` the way the tool does: `--name=value`, `--name value` (a value flag takes the next
 *  word, whatever it looks like), a bare boolean, and pflag shorthands (`-n prod`, `-nprod`, `-n=prod`, `-v6`, booleans
 *  combined as in `-it`, a value shorthand ending the word). An unknown `--name=value` is readable (its arity is in the
 *  word); an unknown bare name or shorthand is not. */
function readFlag(spec: FlagSpec, ws: string[], i: number): FlagRead {
  const w = ws[i]!;
  if (w.startsWith("--") || spec.goStyle) {
    const body = w.replace(spec.goStyle ? /^--?/ : /^--/, "");
    const eq = body.indexOf("=");
    const name = eq < 0 ? body : body.slice(0, eq);
    const known = spec.value.has(name) || spec.bool.has(name);
    if (eq >= 0) return { ok: true, flags: [{ name, value: body.slice(eq + 1), known }], next: i + 1 };
    if (spec.value.has(name)) return i + 1 < ws.length ? { ok: true, flags: [{ name, value: ws[i + 1]!, known }], next: i + 2 } : { ok: false, why: `${w} without its value` };
    if (spec.bool.has(name)) return { ok: true, flags: [{ name, value: "true", known }], next: i + 1 };
    return { ok: false, why: `unknown flag ${w}` };
  }
  const flags: FlagHit[] = [];
  for (let j = 1; j < w.length; j++) {
    const name = spec.short[w[j]!];
    if (!name) return { ok: false, why: `unknown flag ${w}` };
    if (spec.value.has(name)) {
      if (j + 1 < w.length) return { ok: true, flags: [...flags, { name, value: w.slice(j + 1).replace(/^=/, ""), known: true }], next: i + 1 };
      if (i + 1 >= ws.length) return { ok: false, why: `${w} without its value` };
      return { ok: true, flags: [...flags, { name, value: ws[i + 1]!, known: true }], next: i + 2 };
    }
    if (w[j + 1] === "=") return { ok: true, flags: [...flags, { name, value: w.slice(j + 2), known: true }], next: i + 1 };
    flags.push({ name, value: "true", known: true });
  }
  return { ok: true, flags, next: i + 1 };
}

const isFlag = (w: string) => w.startsWith("-") && w !== "-";

/** One mutating line's flags in canonical form (D-57 re-review r2): every flag by its long name with the value the tool
 *  uses, the words of the change without the `drop`ped flags, and why the line cannot be canonicalized when it cannot.
 *  A flag that does not accumulate but appears twice (`--context dev --context prod`, `-n a -n b`, `-n a --namespace
 *  b`) is refused rather than resolved: the person reviewing the plan reads the first, the tool uses the last. */
interface CanonicalFlags {
  /** Every value of each flag, in order; a non-repeatable flag has at most one. */
  values: Map<string, string[]>;
  /** The words that are not dropped flags, each with its index in the input. */
  keep: Array<{ w: string; i: number }>;
  why: string | null;
}

function canonicalFlags(spec: FlagSpec, ws: string[], drop: Set<string>): CanonicalFlags {
  const values = new Map<string, string[]>();
  const keep: CanonicalFlags["keep"] = [];
  const refuse = (why: string): CanonicalFlags => ({ values, keep, why });
  let positionalOnly = false;
  for (let i = 0; i < ws.length; ) {
    const w = ws[i]!;
    if (positionalOnly || !isFlag(w)) {
      keep.push({ w, i });
      i++;
      continue;
    }
    if (w === "--") {
      positionalOnly = true;
      keep.push({ w, i });
      i++;
      continue;
    }
    const r = readFlag(spec, ws, i);
    if (!r.ok) return refuse(r.why);
    for (const f of r.flags) {
      const seen = values.get(f.name) ?? [];
      if (seen.length > 0 && !spec.repeatable.has(f.name)) return refuse(`--${f.name} given more than once`);
      values.set(f.name, [...seen, f.value]);
    }
    const dropped = r.flags.filter((f) => drop.has(f.name)).length;
    if (dropped > 0 && dropped < r.flags.length) return refuse(`${w} combines flags the key reads with flags it keeps`);
    // `--dry-run server` (spaced): pflag reads a bare `--dry-run`; its mode word is not a target (D-56c)
    let next = r.next;
    if (w === "--dry-run" && ["server", "client", "none"].includes(ws[next] ?? "")) next++;
    if (dropped === 0) for (let k = i; k < next; k++) keep.push({ w: ws[k]!, i: k });
    i = next;
  }
  return { values, keep, why: null };
}

/** The flags that do not change what is applied, or that the key carries in canonical form instead of as words. */
const KUBE_DROP = new Set(["output", "template", "v", "dry-run", "record", "request-timeout", "show-managed-fields", "namespace", "context", "kubeconfig", "cluster", "server", "user", "as", "as-group", "as-uid", "token"]);
const HELM_DROP = new Set(["output", "dry-run", "namespace", "kube-context", "kubeconfig", "kube-apiserver", "kube-as-user", "kube-as-group", "kube-token"]);
/** helm-diff's display flags: they shape the diff the person reads, not what the upgrade applies. */
const HELM_DIFF_DISPLAY = ["context", "detailed-exitcode", "no-color", "color", "suppress-secrets", "show-secrets", "show-secrets-decoded", "suppress", "suppress-output-line-regex", "strip-trailing-cr", "find-renames"];

/** The cluster and identity a kubectl or helm command acts with, from its canonical flags, in a fixed order: part of
 *  what it targets, so a plan against one never admits an apply against another. */
const IDENTITY: Record<"kube" | "helm", Array<[string, string]>> = {
  kube: [["context", "ctx"], ["kubeconfig", "kubeconfig"], ["cluster", "cluster"], ["server", "server"], ["user", "user"], ["as", "as"], ["as-group", "asgroup"], ["as-uid", "asuid"]],
  helm: [["kube-context", "ctx"], ["kubeconfig", "kubeconfig"], ["kube-apiserver", "server"], ["kube-as-user", "as"], ["kube-as-group", "asgroup"]],
};

function identityKey(flags: CanonicalFlags, kind: "kube" | "helm"): string[] {
  const one = (name: string) => flags.values.get(name)?.join(",");
  const ns = one("namespace");
  const out = ns ? [`ns=${ns}`] : [];
  for (const [flag, key] of IDENTITY[kind]) {
    const v = one(flag);
    if (v) out.push(`${key}=${v}`);
  }
  // a bearer token is part of who acts, but never written down: its hash stands for it
  const token = one(kind === "kube" ? "token" : "kube-token");
  if (token) out.push(`token=${createHash("sha256").update(token).digest("hex").slice(0, 12)}`);
  return out;
}

/** A command's words after its tool split into the global flags before its verb and the rest (from the verb on).
 *  `unknown` names a flag before the verb that is not a known global: what the command does then is not readable, so
 *  callers fail closed (the envelope classes it destructive; the plan gate keys it to nothing). Booleans may be spelled
 *  `--flag=true|false`; shorthands attach their value (`-v6`, `-nprod`). Null for a tool without a global-flag table. */
export function splitGlobals(tool: string, ws: string[]): { globals: string[]; rest: string[]; unknown: string | null } | null {
  const spec = GLOBALS[tool.replace(/^.*\//, "")];
  if (!spec) return null;
  const globals: string[] = [];
  let i = 0;
  while (i < ws.length && isFlag(ws[i]!)) {
    if (ws[i] === "--") {
      i++;
      break;
    }
    const r = readFlag(spec, ws, i);
    if (!r.ok || r.flags.some((f) => !f.known)) return { globals, rest: ws.slice(i), unknown: ws[i]! };
    globals.push(...ws.slice(i, r.next));
    i = r.next;
  }
  return { globals, rest: ws.slice(i), unknown: null };
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
    // Canonicalize or refuse (re-review r2): Go's flag package reads `-x` and `--x` alike, a value flag takes the next
    // word (`-var env=prod`), and the last of a repeated flag wins; every flag is rewritten `-name=value`, a repeated one
    // that does not accumulate is refused, and an unknown bare one (arity unknown) is refused.
    const tf = terraformFlags(rest);
    if (tf.why) return { kind: "apply", tool: "terraform", target: `unreadable (${tf.why}) ${rest.join(" ")}`, inputs: [] };
    const ws = tf.words;
    const one = (name: string) => tf.values.get(name)?.[0];
    const verb = ws.find((w) => !w.startsWith("-"));
    const varFiles = tf.values.get("var-file") ?? [];
    const dir = one("chdir") || ".";
    // What changes the plan besides the config and var files (review I-1): the mode flags (sorted: `destroy` is `plan
    // -destroy`'s apply) and the value flags in order (a later `-var` or `-var-file` overrides an earlier one).
    const flags = (destroy: boolean) => [
      ...["-destroy", "-refresh-only"].filter((f) => ws.includes(f) || (destroy && f === "-destroy")),
      ...ws.filter((w) => /^-(?:var|var-file|target|replace|exclude)=/.test(w)),
    ];
    if (verb === "plan") {
      const out = one("out");
      // A saved plan binds itself (its bytes are the plan); an unsaved one binds the config directory and var files
      // (review M-3: editing a .tf between `plan` and `apply -auto-approve` no longer matches).
      if (out) return { kind: "plan", tool: "terraform", target: `${dir} planfile`, inputs: [out], planFile: out };
      return { kind: "plan", tool: "terraform", target: [dir, ...flags(false)].join(" "), inputs: [dir, ...varFiles] };
    }
    if (verb === "apply" || verb === "destroy") {
      const planFile = verb === "apply" ? ws.slice(ws.indexOf(verb) + 1).find((w) => !w.startsWith("-")) : undefined;
      if (planFile) return { kind: "apply", tool: "terraform", target: `${dir} planfile`, inputs: [planFile], planFile };
      return { kind: "apply", tool: "terraform", target: [dir, ...flags(verb === "destroy")].join(" "), inputs: [dir, ...varFiles] };
    }
    return null;
  }
  if (tool === "kubectl" || tool === "oc") {
    const g = splitGlobals(tool, rest)!;
    // An unknown flag before the verb: not readable, so it is an apply no plan can match (fail closed).
    if (g.unknown) return { kind: "apply", tool, target: `unreadable ${rest.join(" ")}`, inputs: [] };
    const verb = positionals(g.rest, 0)[0];
    const sub = positionals(g.rest, 0)[1];
    // D-57: every verb that changes the cluster is an apply (each takes --dry-run, so each can be planned); `diff` is a
    // plan, keyed like the apply of the same files (D-56). `rollout status|history` are reads (review I-4).
    if (!verb || (!KUBECTL_MUTATING.has(verb) && verb !== "diff")) return null;
    if (verb === "rollout" && !["undo", "restart", "pause", "resume"].includes(sub ?? "")) return null;
    // Canonicalize or refuse (re-review r2): the flags as kubectl reads them; a line it cannot read that way, or that
    // repeats a flag, is an apply no plan can match.
    const cf = canonicalFlags(KUBE, rest, KUBE_DROP);
    if (cf.why) return { kind: "apply", tool, target: `unreadable (${cf.why}) ${rest.join(" ")}`, inputs: [] };
    const files = [...(cf.values.get("filename") ?? []), ...(cf.values.get("kustomize") ?? [])];
    // The change itself is the key (review I-1): the verb (`diff` is `apply`'s plan), every argument and every flag
    // with its value (`--replicas`, `-p`'s body, `--prune --all`, `--server-side`), in order; only the dry-run, output,
    // verbosity, namespace and cluster flags are left out (the last two lead the key, in canonical form).
    const verbAt = rest.length - g.rest.length;
    const change = cf.keep.map(({ w, i }) => (i === verbAt && w === "diff" ? "apply" : w));
    const target = [...identityKey(cf, "kube"), ...change].join(" ");
    const kind = verb === "diff" || dryRun(rest) === "plan" ? "plan" : "apply";
    return { kind, tool, target, inputs: files };
  }
  if (tool === "helm") {
    const g = splitGlobals(tool, rest)!;
    if (g.unknown) return { kind: "apply", tool, target: `unreadable ${rest.join(" ")}`, inputs: [] };
    const verb = g.rest.find((w) => !w.startsWith("-"));
    if (!verb) return null;
    const pos = positionals(g.rest, 1);
    const isDiff = verb === "diff" && ["upgrade", "install", "rollback"].includes(pos[0] ?? "");
    if (!isDiff && !["install", "upgrade", "uninstall", "rollback"].includes(verb)) return null;
    const cf = canonicalFlags(isDiff ? HELM_DIFF : HELM, rest, isDiff ? new Set([...HELM_DROP, ...HELM_DIFF_DISPLAY]) : HELM_DROP);
    if (cf.why) return { kind: "apply", tool, target: `unreadable (${cf.why}) ${rest.join(" ")}`, inputs: [] };
    // The release, chart and every flag (`--set`, `--version`, `--install`, `-f` values) are the change (review I-1);
    // `helm diff upgrade …` is the plan of `helm upgrade …`.
    const verbAt = rest.length - g.rest.length;
    const change = cf.keep.filter(({ w, i }) => !(isDiff && i === verbAt && w === "diff")).map(({ w }) => w);
    const target = [...identityKey(cf, "helm"), ...change].join(" ");
    return { kind: isDiff || dryRun(rest) === "plan" ? "plan" : "apply", tool, target, inputs: cf.values.get("values") ?? [] };
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
    return { kind: dryRun(rest) === "plan" || has("--what-if") ? "plan" : "apply", tool, target, inputs: flagValues(rest, ["--template-file", "-f"]) };
  }
  if (tool === "gcloud") {
    const pos = positionals(rest, 0);
    const verbIdx = pos.findIndex((w) => ["create", "delete", "update", "deploy", "destroy", "start", "stop", "resize", "set-iam-policy", "add-iam-policy-binding", "remove-iam-policy-binding"].includes(w));
    if (verbIdx < 0) return null;
    return { kind: dryRun(rest) === "plan" ? "plan" : "apply", tool, target: pos.join(" "), inputs: flagValues(rest, ["--source", "--config", "--template"]) };
  }
  if (tool === "aws") {
    const pos = positionals(rest, 0);
    // The AWS CLI has no plan step except CloudFormation change sets; everything mutating is an apply.
    const verbIdx = pos.findIndex((w) => /^(create|delete|update|put|modify|terminate|run-instances|start|stop|reboot|deregister|attach|detach|associate|disassociate|authorize|revoke|execute-change-set)/.test(w));
    if (verbIdx < 0) return null;
    if (pos.includes("create-change-set")) return { kind: "plan", tool, target: [pos[0], flagValue(rest, ["--stack-name"]) ?? ""].filter(Boolean).join(" "), inputs: flagValues(rest, ["--template-body", "--template-url"]) };
    if (pos.includes("execute-change-set")) return { kind: "apply", tool, target: [pos[0], flagValue(rest, ["--stack-name"]) ?? ""].filter(Boolean).join(" "), inputs: [] };
    return { kind: dryRun(rest) === "plan" ? "plan" : "apply", tool, target: pos.join(" "), inputs: [] };
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

/** A pipeline negated with `!`: bash inverts its exit status (review I-3). */
function negated(part: string): boolean {
  return /^[\s({]*!(?:\s|$)/.test(part);
}

/** Prefix commands that run the command after them (review M-2), with the options that take a separate value; a
 *  prefix after which no command runs (`command -v`) ends the part. `timeout` also takes a duration. */
const PREFIX_VALUE_FLAGS: Record<string, Set<string>> = {
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  ionice: new Set(["-c", "-n", "--class", "--classdata"]),
  command: new Set(),
  builtin: new Set(),
  time: new Set(),
  nohup: new Set(),
};

/** The words after any run-prefixes (`timeout 300 …`, `nice -n 5 …`, `command …`); null when the prefix runs nothing. */
function afterPrefixes(ws: string[]): string[] | null {
  let i = 0;
  while (i < ws.length && PREFIX_VALUE_FLAGS[ws[i]!]) {
    const name = ws[i]!;
    const valued = PREFIX_VALUE_FLAGS[name]!;
    i++;
    if (name === "command" && /^-[vV]$/.test(ws[i] ?? "")) return null;
    while (i < ws.length && ws[i]!.startsWith("-") && ws[i] !== "--") i += valued.has(ws[i]!) ? 2 : 1;
    if (ws[i] === "--") i++;
    if (name === "timeout" && i < ws.length) i++; // the duration
  }
  return ws.slice(i);
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
  let negatedPlan = false;
  for (const raw of splitShellCommands(command)) {
    const part = bare(raw);
    if (!part) continue;
    const isNegated = negated(raw);
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
    const run = afterPrefixes(ws.slice(i));
    if (run === null || run.length === 0) continue;
    const pc = classifyPlanCommand(run.join(" "));
    if (pc) {
      steps.push({ pc, cwd: dir, env: [...env].map(([k, v]) => `${k}=${v}`).sort() });
      if (isNegated && pc.kind === "plan") negatedPlan = true;
    }
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
  // A negated dry run reports a failure as success (review I-3); a backgrounded one has not run yet when the line
  // returns (review M-1): neither is recorded.
  const background = /(?:^|[^&])&\s*$/.test(command.trim());
  const recordable = !unreadable && !negatedPlan && !background && lastPc?.kind === "plan" && others && plans.length === 1 && count(seen, "apply") === 0 ? plans[0]! : null;
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
