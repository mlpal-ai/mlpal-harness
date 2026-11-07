# Changelog

## Unreleased

### A stored memory reaches the prompt as quoted, sanitized data (2026-11-07)

- Each line of a derived memory is quoted, so its text cannot open a heading or a fence of its own.
- `fitMemorySection` handles a memory section; `fitPromptToMemoryTools` is for the HOP's prompt only and no longer runs
  over stored text.
- `projectionSection` is sanitized and carries the same frame as the local section.
- The sanitizer also takes the underscore spelling of the system-reminder tag.

### Rule argument patterns: file tools by path, everything else by its declared arguments (2026-11-07)

- A rule's argument pattern reads `path` only on the builtin file tools (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `List`,
  `Lsp`). On any other tool it reads the whole input, as canonical JSON (keys sorted at every depth) or as sent. A pattern
  anchored on a key that does not sort first still depends on the order sent, so a deny should not anchor. The permission
  judge is shown the same subject.
- MCP rules match declared arguments only. `wrapMcpTool` records the arguments a server's schema declares
  (`Tool.declaredArgs`); a schema silent on `additionalProperties` is read as closed. A call with an undeclared argument
  cannot be judged: no allow with a pattern admits it, and every deny or approval entry with a pattern names it. A rule
  with no pattern is unaffected.
- A deny or approval entry still fires on a declared `path` of a non-file tool. An allow does not.
- On a tool other than Bash and the file tools, an allow's argument pattern is a literal prefix of the input's JSON, with
  at most a trailing `*` (`Tool({"to":"a",*)`), or a lone `*`. Any other wildcard never admits a call, and a HOP declaring
  one is refused at load (`unjudgeableAllow`).
- `*` spans every character of a value.
- Builtin tools declare their arguments as MCP tools do (`defineTool`; a schema that is no plain object declares none).
- A parked call records `toolName` and, for a tool other than Bash and the file tools, its canonical input as `args`
  (`pendingApproval`, additive). `command` stays the D-48 binding; a client shows `args` when present.
- `callSubject(req)`: what a call is read by outside a rule.
- An MCP tool whose arguments sit behind a `$ref` or a combinator is logged at connect (`unreadableSchema`): a rule
  with an argument pattern on it fails closed.

### Memorize is a memory write, not a read (2026-11-07)

- `Memorize` is tagged `memory: true` and `readOnly: false`, the standing of the memory server's tools. Every mode still
  admits it with no stop. It no longer runs concurrently with reads, and a call on record as started is not run twice.
- A global-scope write (`Tool.isCallGlobalMemory`, `PermissionRequest.isGlobalMemory`) is refused in recon and in a
  read-only run (`PermissionConfig.readOnlyRun`), ahead of allow rules and the safety envelope. Project scope is unchanged
  there.
- Derived memories are sanitized like instruction files and the section frames them as data.

### The prompt names only the memory tools a session has (2026-11-07)

- `fitPromptToMemoryTools(prompt, has)` and `memoryToolsNamed(prompt)` (`memory/prompt-tools.ts`). The coding HOP's
  `work-memory` module told every session it had the memory server's tools, and the prompt's other memory sentences
  assumed `Memorize` or `memory_write`. What a session has is known only at session build, so a host now fits the prompt
  there: the module stays when all its tools are present, becomes a short one on a store grant
  (`memory_checkpoint`, `memory_search`), and goes otherwise, along with the sentences about a missing tool. With a local
  store only, `Memorize` is the memory and nothing calls it scratch.
- With every tool present the prompt is byte-identical. Text a HOP wrote itself is not edited.

### D-63: a reloaded UI can show its queued runs again; protocol 0.25.0 (additive, 2026-11-03)

- Protocol: `session_history.pendingQueue?: PendingQueuedRun[]` (`{requestId, position, inboxSeq, prompt, blocks?}`),
  capability `queue`: the runs a UI connection queued on the session that still wait, sent on the newest page only and
  only to the session's owner. A 0.24 client's tolerant schema drops the field.
- Store client: `SessionStoreClient.inboxPending(sid)`, P1 1.3's `GET /sessions/{sid}/inbox?state=pending` (stack
  `d63-pending-read`): the pending items in queue order, with the queued `message` on writer-accepted items only. A
  store before 1.3 answers 405, a StoreHttpError.

### D-62(a): the store projection carries `inbox.blocked` (additive, 2026-11-03)

- `SessionProjection.inbox?: {blocked: {reason, untilMs}}`, from P1 1.2's `inbox.blocked {reason, until_ms}`. It is
  present only while an open turn with no lease waits out its spent resume budget, until `untilMs`. yodex serve reads
  it to keep such a turn live (recovering) rather than call it an orphan. A type plus its mapping in `projectionOf`;
  nothing else in the projection changes.

### D-53: a model fallback is never silent; protocol 0.24.0 (additive, 2026-11-01)

- When the main model fails before any content and a fallback answers, `ModelResult.fallback` says so (`{from,
  reason, code}`; `code` is low-cardinality: `http_5xx`, `http_<status>`, `timeout`, `network`, `stream`,
  `refused`), and the loop persists and yields a typed **`model_fallback`** event (`{from, to, reason, code}`, protocol
  0.24.0, additive) before the answer it produced. It also writes a `model.fallback` record to the events channel,
  counts `agent.model_fallbacks{from,to,code}` and logs a warning. Replay (`loadMessages`) ignores the event.
- HOP `model.fallback: allow | deny` (loader, schema, composition; default allow). Under `deny` a host sends no
  fallbacks, so a failing main model fails the call.
- Review fixes: the client yields a `model_switch` delta **when** it fails over (and when a fallback rung is refused),
  before the next model's first delta, and the loop persists and yields `model_fallback` at once, so a cancelled or
  failed fallback stream still leaves the transcript record, the metric and the `model.fallback` events record (I1).
  A `message_start` naming another model than requested (dated spellings and `mlpal` meta-models aside) is a
  `gateway_swap` switch (I2). `reason` is built from the gateway's status, error type and code only, never provider
  text, and redacted and bounded again in the loop (I3). `AgentConfig.modelFallback: deny` is enforced by the
  session: no fallbacks are sent, and `noFallback` makes an answer from another model fail the call
  (`fallback_denied`, never retried) (M1, I2). Gateway note: on `/v1/messages` the gateway does not substitute a
  pinned model (backend failover keeps the model; the router's `get_adapter_with_fallback` has no caller at
  mlpal-assistants-service 4157a56), so no gateway flag was added; the swap check guards it if that changes.
- Re-review round 1: the swap check compares the gateway's canonical model ids (`canonicalModelId`, ported from
  mlpal-assistants-service `adapters/anthropic.py` / `adapters/openai.py` `canonical_model_id`: Bedrock
  `<region>.anthropic.` / `anthropic.` / `<region>.openai.` prefixes, Vertex `@…`, `-vN:N`, and `-YYYYMMDD` /
  `-YYYY-MM-DD` dates), so a backend's spelling of the same model is neither a warning nor, under deny, a failure
  (R1-1); `user/…` (BYOM) tags are the gateway's to resolve, like `mlpal`. A switch is reported once per call across
  retries, resets and resumes (R1-3). `ModelPolicy.fallback` documents that deny governs the agent's own calls, not
  the session-less side calls (R1-6). Follow-up (not built): the gateway could report the served canonical id in the
  `mlpal_usage` trailer next to `serving_backend`, and the check would compare against that.
- Hardening (approved round 2, R2-1): only Bedrock's `-vN:N` form is stripped as a version (`deepseek-v3` and
  `deepseek-v4` stay distinct), and a date is stripped from the served id only, and only when the request named no
  date (`sameModel`), so dated snapshots stay distinct.

### D-54: the agent verifier judges each turn against that turn's own request (2026-11-01)

- `agentVerifier` hands the framing `{task}` = **this turn's request** (`turnRequest`): the messages a person or a peer
  sent since the last run boundary (a persisted `result`), in order; a run that resumes a parked approval keeps the
  request that parked; the loop's own system-authored notes (`[Verification] …`) are not requests. The session's
  opening message follows, marked "context only; not the request this turn answers". Before, `{task}` was always the
  session's first user message, so a correct change asked for in a later turn failed fail-closed verifiers as "a
  mutation nobody asked for" (the infra HOP, demo v2).
- Review fixes: only a turn that completed (`success`) and did not end asking the person something (a parked
  AskUserQuestion, or last words ending in a question) is a boundary; a park for approval, a cancel, an
  interruption, an error or a turn limit carries its request forward and the later steer or answer joins it (I4).
  The verifier gets the request with each message labelled by who sent it (`[person]`, `[peer <name>]`), then the
  previous turn's request and the opening message fenced as quoted context (M6); a long request keeps its end (M5).
  `isParkedAskResult` marks a parked ask's tool result.
- Re-review round 1: only a parked AskUserQuestion carries a request into the next turn; a turn whose prose ends in a
  question stays a boundary, and its request (`<previous-request>`) and the agent's question (`<asked-back>`) are
  context, never the request, so "Anything else?" cannot chain old requests into a new one (R1-2). Message bodies are
  JSON-encoded with `<` escaped, so a message can neither close a block nor forge a `[person]` line (R1-4).
- Hardening (approved round 2): a peer's display name is reduced to `[A-Za-z0-9._@-]` in its label (R2-2); U+2028,
  U+2029 and fullwidth `＜` `＞` are escaped in fenced bodies like `<` (R2-3).

### D-55 re-review round 2 (2026-11-01)

- **R2-1:** `soleKubeApply` grants nothing to a line whose kube commands (the change or a read beside it) leave the
  governed kubeconfig (`leavesGovernedKubeconfig`): `--kubeconfig`, `--server`/`-s`, `--token`, basic-auth, client
  certificate, CA or TLS flags (helm: `--kubeconfig`, `--kube-apiserver`, `--kube-token`, `--kube-ca-file`,
  `--kube-insecure-skip-tls-verify`, `--kube-tls-server-name`), or a `KUBECONFIG=` / `HELM_KUBE*=` assignment
  (`HELM_KUBECONTEXT` aside). Another kubeconfig's `exec`/`auth-provider` user runs as a child with the command's
  environment, the grant included; another server would be handed the grant token. `--context`, `--cluster`, `--user`,
  `-n` and `--as` still qualify.

### D-55 re-review round 1 (2026-11-01)

- **R1-1:** `soleKubeApply` grants nothing to a change that starts a program of its own, which would inherit the
  command's capability (`spawnsProgram`): a helm `--post-renderer` (and `--post-renderer-args`), a chart fetched by a
  downloader plugin (any scheme but oci/http/https), an editor (`kubectl edit`, `--edit`, `apply edit-last-applied`),
  kustomize plugin or helm-inflation flags. `PlanCommand.kustomize` names a `-k` directory so the host can check its
  content.

### D-55 security review (evidence/D55-security-review.md; 2026-11-01)

- **I-1, per-command capabilities:** `ExecPolicy.lease(command)` gives one command its own environment, held until its
  process exits (Bash, adopted foreground commands and background tasks call `release` on exit; a durable monitor,
  which outlives the host, gets none). `soleKubeApply(command, cwd)` names the line that may hold a kube mutation
  capability: one kubectl, oc or helm change with nothing beside it that could use the capability (no background job,
  substitution or other program; only `cd`/`export`/assignments and kubectl/helm reads such as `rollout status`, never
  `kubectl proxy`, a plugin or `exec`).
- **I-2, the network layer:** a sandbox spec carries host-supplied `network.hostPorts` (loopback ports reachable in
  every mode; seatbelt keeps them open under `none`) and `network.deny` (endpoints refused in every mode: the allowlist
  proxy refuses them by name even when allowlisted, seatbelt refuses a loopback one by port as the profile's last
  rule). `unenforcedDeny` names what a platform cannot refuse (seatbelt: a remote host outside `allowlist`; bwrap:
  anything outside `none`, since it keeps the host network) and `describe()` prints it: never silent.
- **M-3:** `credentials[].allowInsecureTls` (kube kind, default false): the HOP's opt-in to serve a cluster whose
  kubeconfig skips TLS verification.

### D-55: HOP v1.3 cluster credentials (schema; 2026-11-01)

- `credentials[].tool: kube` (with `name`, `source: secret | local-context`, `namespace`) loads into
  `Profile.kubeCredentials`, apart from the P6 header credentials (`Profile.credentials`), so a consumer of the header
  kind never meets the other; a `value` is refused; two kube credentials may not share a name.
- `requires.kube: [{credential}]` composes by credential name; a name no kube credential declares is a load error.
- The host side (the credential proxy, the governed kubeconfig, the preflight) is yodex's (`kube-credentials.ts`).

### D-57: a compound command is gated by its most dangerous command; D-56 (2026-11-01, security)

- **The bypass (D-57):** the preApply plan gate read only a Bash line's leading command, so `cd …; export
  KUBECONFIG=…; kubectl set image …` (and any apply after a read, in a subshell, behind `X=1`, in `$(…)`, in `sh -c`)
  ran as an unchecked mutation; the envelope's own splitter also missed `X=1`/`env`/`sh -c`/`eval` forms, so even a
  destructive `X=1 kubectl delete …` was ungated.
- `classifyAction`: a Bash line is classified per simple command (`decomposeBash`), the worst class wins; context-only
  commands (`cd`, `export`, …) add nothing; a line that cannot be decomposed is `destructive` (fail closed).
- `planLine(command, cwd)`: every plan and apply a line runs, with the directory (`cd`) and environment
  (`export`/`X=1`/`env`) each runs in; an apply the gate cannot see the context of (nested shell, quoted substitution,
  non-literal `cd` or assignment, an undecomposable line) makes the line `unreadable` (the host refuses it). A dry run is
  `recordable` only when its exit status is the line's.
- `classifyPlanCommand`: one simple command; redirections and `--dry-run`'s mode are not targets (D-56c); `--context`
  / `--kubeconfig` / `--kube-context` are; `kubectl diff` is a plan (D-56); every mutating kubectl verb (`label`,
  `annotate`, `taint`, `drain`, `cordon`, `uncordon`, `expose`, `autoscale`, `run`, `edit`) is an apply.
- `planExitOk`: `kubectl diff` exit 1, `terraform plan -detailed-exitcode` 2 and `helm diff --detailed-exitcode` 2 mean
  "changes found", not failure (D-56a).
- Security review round 1 (evidence/D57-security-review.md): only a bare `--dry-run` or `=client|server|true` is a
  dry run, `=none`/`=false`/anything else is the change (C-1, `dryRun`); the plan key is the change itself (verb, every
  argument and mutating flag: `--replicas`, `-p` bodies, `--prune --all`, `--set`; I-1); terraform binds the config
  directory without `-out` and the plan file with it (M-3); `kubectl rollout status|history` are reads (I-4); a negated
  (`! …`) or backgrounded dry run is not recordable (I-3, M-1); `timeout`/`nice`/`stdbuf`/`ionice`/`command`/`builtin`/
  `time`/`nohup` are read through (M-2).
- Re-review round 1: global flags before the verb (`kubectl -s URL --as admin delete …`, `helm --kube-context p
  uninstall`, `terraform -chdir=x apply`, `aws --profile p …`) are parsed past (`splitGlobals`), so the envelope sees
  the verb (its verb-led form is matched too) and the plan gate keys server, context, impersonation and a token's hash;
  an unknown flag before the verb is unreadable: destructive in the envelope, an apply no plan matches in the gate.
- Re-review round 2, canonicalize or refuse (R2-1, R2-2): kubectl, oc, helm and terraform/tofu flags are parsed the
  way the tool parses them (`canonicalFlags`, `terraformFlags`): attached shorthands (`-nprod`, `-shttps://…`, `-v6`,
  `-fdeploy.yaml`), `--flag=value`, a value flag taking the next word, `-x` = `--x` for terraform. The effective
  namespace, context, kubeconfig, cluster, server, user and impersonation lead the key. Refused (an apply no plan
  matches, and no plan recorded): a non-accumulating flag given twice (`--context dev --context prod`, `-n a -n b`,
  `-n a --namespace b`, `-chdir` twice), an unknown bare flag after the verb (its arity is unknown; `--x=v` is read), a
  combined shorthand mixing a keyed flag with a kept one (`-Anprod`). terraform keys `-var`/`-var-file`/`-target`/
  `-replace` with their values in order (`-var env=dev` and `-var env=prod` no longer share a key). helm-diff's
  `--context` (lines) and display flags are dropped from the plan's key. Before the verb, `-A`, an attached `-v<N>` and
  `--bool=true|false` are read, so `kubectl -A get pods` stays a read.
- Re-review round 3, bind every file input or refuse (R3-1): the flag tables mark the flags that name files
  (`KUBE_INPUTS`: `-f` (comma list), `-k`, `--patch-file`, `--from-file`/`--from-env-file` (`key=path`, comma list),
  `--cert`/`--key`, `--kubeconfig` and the client TLS files; `HELM_INPUTS`: `-f`, `--set-file`, `--kubeconfig`, the TLS
  files), and every one is a plan input. helm's chart argument is an input (a local directory or `.tgz`); unpinned, it
  must be on disk (`PlanCommand.mustExist`), so a repository chart resolved at apply time binds nothing and is refused.
  Refused outright: a repo or OCI chart without an exact `--version`, a chart URL, a `--post-renderer` found on PATH (a
  script by path is an input that must exist). terraform keys `-state`, `-state-out`, `-backup`, `-refresh=false`,
  `-lock=false`, `-parallelism` (every flag but the display/confirmation ones, defaults dropped) and hashes a `-state`
  file; a saved plan's apply keys the flags left on the command. Minor: kubectl and helm flags key as `--name=value` by
  long name (`--replicas 3` = `--replicas=3`, `-f a` = `--filename=a`, combined shorthands canonicalized instead of
  refused); a key word with whitespace or a quote is JSON-quoted.
- Kubeconfig ruling: `PlanCommand.kube` carries the kubeconfig selection flags a kubectl/oc/helm command gives
  (`--kubeconfig`, `--context`/`--kube-context`, `--cluster`, `--user`) so the host can bind where the apply lands.
- **Known limit (accepted residual):** a repository or OCI chart pinned by an exact `--version` is trusted by that
  version: its pulled contents (and the repo-name mapping in `repositories.yaml`) are not hashed, so a repository
  that republishes the same version is not detected. Follow-up: accept OCI digest pins (`oci://…@sha256:…`) and hash
  the pulled chart into the plan.
- Re-review round 4, R4-1 (kuberc): `--kuberc` on any kubectl/oc line, read or apply, before or after the verb, is
  unreadable (destructive in the envelope, an apply no plan matches; `kuberc` left the known globals). A line that
  sets or unsets `KUBECTL_KUBERC` or `KUBERC` (`X=…`, `export`, `env`, `unset`) is unreadable. `PLAN_GATE_ENV`
  (`KUBECTL_KUBERC=false`) is the environment a host runs every command in under a preApply gate.
- Locked minimum: with `requirePlanArtifact`, the profile loader always puts `plan` in `safety.preApply.hash` and warns
  when the HOP left it out. `identity` and `backend` are advisory: host probes that cannot see a line's own flags or
  environment; every content and target binding lives in `plan`.
- Re-review round 5, R5-1 (which binary runs): a gated tool (kubectl, oc, helm, terraform, tofu) run by a path
  (`./kubectl`, `/tmp/x/kubectl`, `bin/helm`) is unreadable in the plan gate and destructive in the envelope, read or
  apply; `PATH` joins the locked variables (a line may not set, prepend or unset it); `PlanCommand.bin` carries the
  executable as invoked (a bare name) for the host to resolve and bind.

### Protocol 0.23.0: queue frames (INBOX T2, P2 1.1; additive, 2026-11-01)

- `HARNESS_PROTOCOL_VERSION` and `@mlpal/harness-protocol` are 0.23.0. Additive minor: capability `queue`;
  `QueuedFrame`, `InboxRejectedFrame`, `WithdrawnFrame` (server) and `WithdrawMessage`, `watch.noticesAfter`
  (client); `ErrorCode` adds `inbox_full`, `request_id_conflict`, `queue_unavailable`, `withdraw_refused`, with the
  error frame's `pending`, `limit`, `retryAfterS`, `state`. A 0.22.x client ignores them; a 0.22.x server never sends
  them (it does not advertise `queue`).

### Queue frames and the writer's accept (INBOX T2 addition, 2026-10-31)

- `SessionStoreClient.acceptTurn` (P1 1.2 accept of a turn under the instance writer token, `pumpable: false`, the sha
  of the exact message bytes; no context: P1 uses the scope's recorded one, W-1); `InboxFullError` (`429 inbox_full`, with `pending`, `limit` and the Retry-After).
- Protocol (capability `queue`): `queued {requestId, sessionId, position, inboxSeq, replayed?}`, `inbox_rejected
  {sessionId, requestId, code}`, and `error.code` `inbox_full` (with `pending`, `limit`, `retryAfterS`) /
  `request_id_conflict` / `queue_unavailable` / `withdraw_refused` (`ErrorCode`); `withdraw` / `withdrawn`;
  `watch.noticesAfter` and `inbox_rejected.seq`. The frames are exported types (`QueuedFrame`, `InboxRejectedFrame`,
  `WithdrawnFrame`, `WithdrawMessage`).
- `SessionStoreClient.withdrawTurn` and `inboxStatus` (state, position).
- `Store.readEventsAt` (`RemoteStore`): events of the kinds asked with their seqs, so a host binds an answer to the
  park the log raised last with its id (store security review r3).
- T2 review: `TurnInput.opening` (a parked question's answer and its `user` entry in one consuming batch, I-1);
  `settleableHeldCall` (a host resumes a held call whose park has a recorded decision and no marker, I-1).

### Inbox consume and head (INBOX T2, P1 1.2, 2026-10-31)

- `SessionStoreClient.inboxHead`; `appendEncoded({consumes})`; `InboxItemNotPendingError` for `409
  inbox_item_not_pending`. `AppendBatcher.consume`: an isolated, acknowledged batch with `consumes`, non-fatal on
  that 409. `Store.consume` / `Store.inboxHead` (`RemoteStore`; its memory views take a consumed batch only once
  acknowledged).
- `TurnInput.consumes` (the user entry opens an inbox turn) and `TurnInput.requestId` (on the `user` entry,
  `UserEvent.requestId`). A run that opens no turn now drops its bus subscription (a withdrawn item, a rejected prompt).
- `AskContext.toolUseId` and `.sessionId`; `stepGate("hook")` before the Stop hooks and `"finish"` after them (N6).
- Protocol: `permission_response` / `question_response` take `sessionId`; `approval_response` takes `id`.

### D-48/D-49 fix round 2 (2026-10-31)

- `stepGate("finish")`: the turn's end after a tool-less answer is a gated step (N3).
- Protocol: a typed approval refusal's `error` frame may carry `sessionId` (N4).

### D-48/D-49 fix round 1: a park binds one call by position; duplicate ids refused (2026-10-31)

- The held call is named by position: `pendingApproval.index` beside `toolUseId`, and `HeldCall.at`
  (`{toolUseId, entry, index}`) plus `parkId` (the result entry's uuid). `AgentSession.approve` now requires
  `parkId` and settles only the call at that position; a park recorded by id alone binds only when exactly one call
  matches. Protocol: `PendingApproval.parkId`, `approval_response.parkId` (replacing the unreleased `toolUseId`),
  `error.code` (`approval_id_required` | `approval_stale`).
- A message that gives two tool calls one id is refused whole at ingest: every call gets
  `DUPLICATE_TOOL_USE_ID` and none runs; on resume too.
- `tool_started` markers carry `entry` and `index`; `startedFrom(markers)` matches by position, by id for older
  markers, so a provider that reuses ids across messages never makes a new call look started.
- `stepGate(next)` names the step (`"model"` | `"tool"`), so a host need not wait out a model call.
- An approved call a PreToolUse hook now rewrites (its command no longer what the park showed) is asked again.

### An approval settles the call its park holds; a step gate for a graceful stop (W3 window defects D-48, D-49, 2026-10-31)

- D-48: a `needs_approval` result names its held call (`pendingApproval.toolUseId`, protocol: additive optional field,
  also on `PendingApproval` and `approval_response`). `AgentSession.approve({decision, reason?, toolUseId?})` reads
  the held call from the log (`heldCall`), so it binds in any process: `allow` runs exactly that call (name, input,
  id) through the normal tool path without asking again (hooks, the `tool_started` marker, the sandbox), `deny`
  records a denial as its result, and only then is the model called. A call already started is never run again
  (`INTERRUPTED_TOOL_RESULT`). `NoHeldCallError` when nothing is held or the client named another call; nothing is
  written. `inFlightTurn` treats a settled park as a turn in flight; `turnToResume` adds a held call whose approved
  run began and whose result was lost.
- A serial tool batch persists each result as its call ends (was: after the whole batch), so a park at the second
  call keeps the first call's result; a park inside a resumed turn's prelude ends the turn `needs_approval` instead
  of throwing.
- D-49: `AgentConfig.stepGate`, awaited before each model call and each tool step; a host that is stopping never
  resolves it, so the turn halts at a step boundary with the step in flight finished and nothing more written.

### D-27 round 3: no auto-approval after an environment change on the same line (2026-10-29)

- On the allow side every command of a Bash line asks when anything on the line changes the environment a command
  runs in: a `NAME=value` standing alone (`PATH=.:$PATH; git status`, `HOME=…`, `GIT_DIR=…`, `IFS=…`, also inside a
  subshell or `bash -c '…'`), a `for` loop variable (any name: `for i in 1 2; do git status; done` asks too), a builtin
  that assigns (`read`, `export`, `declare`, `local`, `let`, `alias`, `hash`, `printf -v`, …), an assignment in
  `$((…))` (`=`, `+=`, `++`, …; `==`/`<=`/`>=`/`!=` are not) or `${NAME:=…}`, and a login or interactive shell
  (`bash -lc`, `-l -c`, `--login -c`, `-i -c`, `zsh -o login -c`), which reads an rc file before its script. 22701ca
  asked for all of these; round 2 auto-approved them under `Bash(git*)`.
- The whole line, not only the commands after the change: in a loop the change reaches the commands before it too.
- Deny and approval rules are unchanged (they still strip and check: `PATH=/tmp/x; git push` is caught).
- `bash --norc -c …`, `bash -c -- …` and `bash --rcfile f -c …` (non-login, non-interactive) stay auto-approvable;
  the 15 reviewed narrowings are unchanged; the differential corpus gains the 22 forms (108 commands).

### The builtin `coding` prompt no longer asks for a checkpoint id the model cannot know (W3 window defect D-31)

- It told the model `event_id="ck:<session id>:<n>"`; a model has no session id, so it wrote the literal
  `ck:session:1`, which the memory store (it dedups event ids globally) dropped as a duplicate for every session after
  the first. The prompt now asks for a short name for the checkpoint, reused only to retry it; the engine scopes it.
- The fake memory store dedups a checkpoint on its `event_id` alone, as memory-graph does (its episode key
  `<event_id>:claim:<i>` is global), not per run.

### Approval entries and deny rules: the tool part is a glob over P7 1.7's grammar (2026-10-29)

- A deny rule's tool part (and so a publication's `approvals_required` entry, which the engine matches as one) takes
  `[A-Za-z0-9_*:.-]` with `*` as a case-sensitive wildcard: `Deploy*` names `DeployProd`, `mcp__github__*` every tool
  of that server, and an MCP name with a digit, `:`, `.` or `-` matches at all (it used to parse as no rule, so the
  approval was silently never asked, W6 D-15). An exact name still matches exactly; the argument side is unchanged;
  allow rules are unchanged (no auto-approval widens).
- `parseApprovalEntry(entry)`: P7 1.7's grammar, strictly (hop-service's `_approval`), or null; its glob length
  counts code points (`u`), as Python does.
- **An injected environment is never auto-approved (controller ruling).** On the allow side a command run with a
  leading `VAR=…` or under `env` with any `NAME=VALUE` or option (`-i`, `-u`, `-S`) asks (`LD_PRELOAD=… git status`,
  `GIT_SSH_COMMAND=… git fetch`, `BASH_ENV=… bash -c …`: the matcher cannot judge which variable runs code); plain
  `env git status` stays auto-approvable. Deny and approval rules still strip the assignments and check the command
  (`FOO=1 git push` is caught). `FOO=1 git status` left the differential's reviewed narrowings; the corpus gains the two.
- **D-27 round 2: the allow side is never wider than 22701ca.** Command substitutions are decomposed wherever bash runs
  them: inside `${…}` parameter operators, inside `$((…))`, and in an unquoted here-doc's body (a quoted `<<'EOF'` body
  stays data). Undecomposable (fail closed, never auto-approved): `$'…'`/`$"…"` and an unquoted glob or brace character
  in a command name (`[`/`[[` excepted), `trap` with a command string. `bash/sh [--norc|--noprofile|-e|-o opt|…] -c
  [--] '<literal>'` is decomposed (an unknown long option is opaque). An `xargs` command still fires a deny or approval
  but an allow rule never auto-approves it (its arguments are unseen). A permanent differential
  (`test/bash-decompose-r2.test.ts`) runs 85 commands under 4 allow rule sets against 22701ca's matcher
  (`test/fixtures/oracle-22701ca/engine.ts`) and fails on anything newly auto-approved outside a reviewed list of
  decomposition narrowings.
- **Bash rules see what the shell runs, failing closed only on what cannot be decomposed (W3 window defect D-27).**
  `decomposeBash` (permission/shell-decompose.ts) decomposes recursively, depth ≤ 3: `sh|bash -c '<literal>'` (option
  bundles ending in `c`), `$(…)`, backticks, `<(…)`, subshells, groups, `if`/`for`/`while`/`until`/`case` bodies; it
  normalises leading assignments, the prefixes `env`/`command`/`builtin`/`time`/`nohup`/`timeout`/`nice`/`stdbuf`/
  `ionice` (with their options), git's global options before the subcommand, `xargs` (its command is checked), absolute
  command paths (basename and as written), arithmetic, redirections and here-doc bodies; a shell running a script file
  and a command run by a relative path are checked as named (best-effort, logged `bash.rule_opaque {command}` through
  `PermissionConfig.logger`); what still cannot be decomposed (an expansion as the command name, `eval`, `source`/`.`,
  `exec`, `sudo`, a non-literal or stdin script, a here-doc into a shell, a function definition, an unknown prefix
  option, unbalanced quoting, depth > 3) fires every rule on Bash. The probe's `sh -c` scripts pass a `Bash(git push*)`
  deny again. Deny and allow see the same commands (an allow never approves an undecomposable one). A deny names the
  rule and what matched (`denied by rule "R": <sub-command>` or `: undecomposable: <form>`); `ruleMatch(rule, req,
  logger?)` is exported for hosts.
- **Bash deny rules and approvals fail closed.** (Superseded by the entry above for what is decomposed.) Each simple command is normalised before matching (whitespace
  collapsed; leading `VAR=…` and `env`/`command`/`time`/`nohup` stripped; the command path and a leading `\` reduced to
  its name; arithmetic `$((…))` read as a literal), and a command that does not decompose into simple commands the
  matcher understands (a `$(` or backtick inside double quotes, a subshell or group, `if`/`for`/`while`/`case` bodies,
  `!`, `xargs`, `eval`, `exec`, `sudo`, a shell such as `bash -c`/`sh -c`, a prefix with options such as `env -i`)
  fires every deny rule and approval on Bash, whatever its pattern. With no rule on Bash nothing changes; allow rules
  are unchanged. (`bashSubjects`, `normaliseSimpleCommand`.)

### Paths named by HOP content or a client stay where the host meant (2026-10-29)

- `loadCatalog`: a `catalog.profile` (HOP content) with characters outside `[a-z0-9_-]` names its cache file by a hash;
  `x/../../…` used to read, create and write a JSON file outside the home's config dir.
- `TaskStore.for`: a session id outside `[A-Za-z0-9_-]{1,128}` (a serve client names it) names its plan file by a hash;
  `../` used to leave the tasks directory.
- Profile confinement (`confineTo`) refuses a `file:` reference or `extends` path outside the HOP's directory by its text
  before anything stats it (a realpath of the outside path ran first). No protocol change.

### WebFetch: a streamed 3 MiB cap and its own deadline (2026-10-29)

- Both WebFetch tools (the local one and the platform's through the egress route) read the body as it streams and
  cancel it once it passes 3 MiB (`response too large (over 3.1 MB)`, nothing of the body returned); they used to
  buffer the whole body before the check, so a large page could exhaust an engine pod's memory.
- Past the cap the request itself is dropped (its own abort beside the turn's signal and the deadline): cancelling the
  reader alone left Bun draining an endless body until the 15 s deadline, most of a core per fetch (FIXPASS review M1).
- A fetch now has its own 15 s deadline beside the turn's signal (`AbortSignal.any`), whichever fires first; the turn's
  signal used to replace it, so a page that never finished held the turn. A timeout reads `fetch timed out after 15 s`,
  a cancelled turn `fetch aborted: the turn was cancelled`. `createWebFetchTool({timeoutMs})` and the third argument
  of `createEgressWebFetchTool` set the deadline. No protocol change.

### Tool hands classes: a host with no local hands offers only pure and routed tools (2026-10-29)

- `Tool.hands?: ToolHands` (`"pure" | "routed" | "local"`, also a `defineTool` option): where a tool's model-chosen
  paths, commands, URLs and code land. Every builtin and factory tool is classified; an MCP server's tools are
  `routed` through the egress proxy or a `ProcessHost`, else `local` (`mcpHands(config)`); `createWebSearchTools`
  takes `hands` (default `local`) since its backend is the host's.
- `ToolRegistry.restrictHands(allowed, onRefused?)` admits only the named classes from then on and drops the refused
  ones (an unclassified tool is refused); a registry made by `filter()` shares the restriction; `handsRestriction`
  reads it. An unrestricted registry behaves as before. Additive; no protocol change.

### W3 integration: a command hook's runner knows its session (2026-10-29)

- `CommandRunner` options gain `sessionId` (the hook's `HookContext.sessionId`), so a host with one sandbox per served
  session (the engine's connection mode, P4 step f) runs a hosted command hook in that session's sandbox. Additive;
  no protocol change.

### Profile `confineTo`: `hop.yaml` itself, and required at every prompt site (2026-10-28)

- Under `LoadProfileOptions.confineTo` the loader confines `hop.yaml` itself: one that is a symlink out of the HOP's
  directory is `HopPathError {field: "hop.yaml"}` before it is read.
- `composeProfile` and the prompt resolver take `confineTo` as a required parameter (`string | undefined`), so no call
  site (system, verifierAgent, summarizer, condenser, a module's prompt) can drop it by omission; each is tested.
### P6: no credentials in the engine — the scoped gateway token and the engine egress proxy (2026-10-28)

- No protocol change (a typed `egressRefusal` field is a 0.22.x item, ledgered).
- `GatewayConfig.apiKey` also takes `{tokenFile}` (`SessionTokenFile`): the scoped per-session gateway token (P3b
  `/run/session/gateway.token`), read on every request, never held. A `401 invalid_api_key` re-reads it once and
  retries once (a rotation may have raced the request); a second 401 is `GatewayError.sessionTokenRejected`, which
  the loop ends as the typed refusal `{code: model_access_denied, reason: gateway}` (logged `session token refused by
  the gateway after its re-read`). A key's 401 is unchanged (one request, untyped). An unreadable or empty token file
  is a non-retried error naming the path, before any request. `readSessionToken(file)` is exported.
- P6 1.1: `403 model_not_allowed` (outside the token's `models_allow`) is `modelAccessDenied`, so it takes the
  existing typed refusal path (`model_access_denied`, reason `gateway`) and a failover rung it refuses is skipped as a
  policy-refused rung is. `403 budget_exceeded` is unchanged.
- `src/egress/proxy.ts`: `EgressRoute {proxyUrl, upstream, tokenFile}`, `egressUrl` (`<proxy>/v1/u/<name>/<path>`),
  `egressMcpServer`, `egressFetch` (sets `X-Harness-Egress-Token` from the token file per request, strips
  `authorization`/`proxy-authorization`/`x-api-key`/`api-key`/`cookie`, `redirect: "manual"`, bodies streamed
  untouched) and `EgressRefusedError` (`X-Harness-Egress: refused`, body `{code}`; a code that is not `[a-z_]` is
  `unknown`, never prose).
- MCP: `HttpServerConfig.egress` reaches a server through the proxy (streamable HTTP or SSE); its `headers` and
  `oauth` are never sent. A proxy refusal is the tool's error text `egress refused (<code>) for <upstream>` (every
  contract code, 1.2's `vault_unavailable` included) and, at connect, the server's status error. A 3xx is never
  followed: `MCP server "<name>" answered a redirect (HTTP <status>); redirects are not followed through the egress proxy`.
- `createEgressWebFetchTool(route, baseUrl)`: WebFetch on the platform, reaching only URLs under the `web-fetch`
  upstream's `base_url`, through the proxy; a redirect is reported, never followed.
- W4's proxy contract fixtures pinned at mlpal-harness-stack `d5d56a5` (`test/fixtures/egress-proxy/`, 26 files):
  every `proxy-*` file is replayed through `egressFetch` against the fake proxy, which answers its refusals from the
  files; the vault-only files are skipped by name. The gateway session-token fixture (mlpal-assistants-service
  `p2-w4-session-tokens`) is a follow-up pin.
- Review round 1:
  - A request never leaves its upstream's route: `egressUrl` and `egressFetch` parse the url as fetch will send it
    (dot segments resolved, `%2e`/`%2E` included) and once more after one decoding (`%252e`), and refuse anything off
    the proxy's origin or outside `/v1/u/<name>/` with the engine's own `EgressRefusedError` `path_escape`, before a
    request (`insideRoute`, `PATH_ESCAPE`). WebFetch compares the parsed origin and a segment-bounded, decoded-once
    path against `base_url` (`pathUnderBase`), with the base normalised to a trailing slash.
  - Streamable HTTP only through the proxy: an egress server of type `sse` fails to connect (`an egress upstream is
    reached over streamable HTTP only`); an SSE `endpoint` event could name a path outside the route.
  - A proxied server's non-credential `headers` are sent verbatim (no env expansion); credential headers are still
    stripped by `egressFetch`.
  - The refusal metric carries `cause` (`model_policy`, `budget`, `session_token`); a `postFeedback` dropped for an
    unreadable token file is logged (`feedback dropped: no gateway credential`); every session or egress token read
    is registered for masking (`gateway session token`, `egress token`).
  - Test servers drain request bodies (an unread chunked body left the keep-alive connection dirty: the fixture
    replay flaked 3/10, now 0/10).
- P6 1.4:
  - The egress proxy fixtures re-pinned at mlpal-harness-stack `f5902f8` (28 files): `proxy-401-echo-redacted` (an
    upstream's echo of the injected credential comes back `[REDACTED]`, a plain answer, not a refusal) and
    `proxy-502-upstream-encoding-refused`. `502 upstream_encoding_refused` is a refusal like `upstream_unreachable`:
    the tool error text is `egress refused (upstream_encoding_refused) for <upstream>`. The fake proxy redacts an
    echoed credential in headers and body.
  - The proxy now decodes path segments before its own traversal checks; the engine keeps its own check as defence
    in depth (a `%2e%2e` form is refused before any request, tested). Review round 2: that check is W4's
    per-segment rule (`segmentsSafe`): each segment percent-decoded until stable, at most three rounds (not stable
    after three is refused), and a segment that is then `.` or `..`, starts with `..;` or `.;`, or holds `/`, `\`
    or NUL, is `path_escape` — so `%3f%2f..%2f..%2fgithub-mcp%2fx` is the engine's refusal, not the proxy's
    `upstream_not_granted`. It replaces the decode-once re-parse in `insideRoute` and `pathUnderBase`;
    `pathUnderBase` strips leading slashes of the rest, so it and `egressUrl` see one path (`/mcp//..%2fx`).
  - Review round 3: a segment is decoded as W4 decodes it, each `%XX` to its byte and any other `%` left a literal
    `%`, so `wiki/100%25` and `50%25off.md` are ordinary paths again (WebFetch fetches them, a settings MCP url keeps
    its path instead of falling back to the base). A round whose bytes are not UTF-8 (overlong `%c0%ae`, a bare
    `%E9`) is refused, never taken as stable (`%2e%2e%2f%` is `../%`, refused). `..;` and `.;` match as prefixes
    (`..;jsessionid=1`, `%2e%2e%3bfoo`). Tested: the round cap (`A` encoded four times is refused, three times is
    not), the not-UTF-8 branch, and an echoed credential reaching the model as `[REDACTED]` through WebFetch (a 200)
    and an MCP tool result.
  - The gateway session-token fixtures pinned at mlpal-assistants-service `a45fe8f`
    (`test/fixtures/p6-session-token/`, read from the local object store): the 401 and both 403 bodies replayed
    through the client (re-read and retry, `sessionTokenRejected`, the access refusal with the gateway's model), a
    token built from the claims vector sent verbatim; the audit event and the usage row are gateway-internal and
    skipped by name.
### P4: the sandbox profile seams — the HOP platform declaration, the stdio process host, hooks elsewhere (2026-10-28)

- No protocol change.
- HOP schema (`mlpal/hop-v1`, additive; the platform declaration as the controller ruled it 2026-10-28):
  `sandbox: {size_class?: 1c2g|2c4g, template?: hands|<name>@<version>, egress?: [host | host:port]}`,
  `workspace: {policy?: ephemeral|session|persistent}`, `credentials: [{ref, tool, host, header}]` (by reference
  only; a `value` key is refused with its own message), `memory.promotion?: auto|review` and
  `memory.limits?: {max_nodes?, max_bytes?, max_write_bytes?}` (inherited per field) beside the existing `memory.reads`/`writes`, and P4's
  `processes: {mcp_stdio?: [{name, argv, env_names}], hooks?, lsp?}`. Validation and data only (`Profile.sandbox`,
  `.workspace`, `.credentials`, `.processes`, `.memory.promotion`, `.memory.limits`, snake-case as written); a child
  overrides per field, a list whole. Unknown keys still fail, the old `sandbox.size` and `sandbox.egress.allow`
  shapes included; inline env values, workspace volume/outputs/idle/retention and secrets are the platform's.
- `ProcessHost` / `ProcessHostTransport` (`mcp/process-host.ts`): `StdioServerConfig.host` runs a stdio MCP
  server's process through the host (the sandbox's `exec/stream` in hosted mode) with the SDK's own framing, so
  the MCP client is unchanged. Without `host` a stdio server is the local child it always was.
- `CommandHook` takes `runner?: CommandRunner`: the command, the event JSON as `stdin` and the hook's timeout go
  to the runner (one non-detached sandbox exec in hosted mode); exit 2 still blocks, a runner that throws is a
  no-op. Without a runner the hook is the local `/bin/bash -c` as before.
- `HandsExecOptions.stdin`: written to the command's stdin whole.
### W3 P5: the memory store client (contract P5 1.3, 2026-10-28)

- No protocol change.
- `MemoryStoreClient` (`store/memory-store.ts`): the routes the engine's memory rung calls under the grant's `url`
  (the full base, `{MEMORY_URL}/api/v1`): `checkpoint` (`POST /memory/checkpoint`, staged under the token's run),
  `search`, `projection`, `promote` (`POST /memory/stores/<store>/runs/<run_id>/promote`, the store id with its
  slash). The bearer is the memory token, read per request; a 401 re-reads it once, then
  `MemoryUnauthenticatedError`. `X-Session-Id` / `X-Run-Id` / `X-Hop` / `X-Origin` are trace headers only: the store
  takes the run and session from the token.
- Errors by `detail.code` (FastAPI's `{"detail": {"code", "message", …}}`): `MemoryUnauthenticatedError` (401),
  `MemoryScopeForbiddenError` (403), `MemoryUnknownError` (404 `unknown_store` / `unknown_run`),
  `MemoryVersionConflictError {key, currentVersion}` (409), `MemoryWriteTooLargeError {size, limit}` and
  `MemoryStoreFullError {measure: nodes|bytes, limit}` (413), `MemoryInvalidPreconditionError {key}` (422),
  `MemoryUnavailableError` (5xx, or `unreachable`); any other code (`note_not_staged`, `already_decided`) is a
  `MemoryStoreError` with it. A string or list `detail`, or no body, is `http_<status>` with no fields.
- `promote` answers `promoted {storeVersion, promoted, conflicts}`, `pending {proposalId}`, `rejected {proposalId}`
  or `empty {storeVersion}`; any other body is `invalid_response`, never a guessed state.
- `parseMemoryGrant(raw)`: RunContext `memory` typed at the boundary (`null` = no memory policy); a field the engine
  cannot use throws `MemoryGrantError` naming it.
- Tests: `test/fake-memory-store.ts`, the store per P5 1.3 (`/api/v1`, the envelope, preconditions on keyed kinds
  against the promoted store, distinct-value versions, `note_not_staged`, conflicts left staged and reported,
  `store_full` on nodes and bytes, 404 `unknown_store` / `unknown_run`, store ids with the slash or
  percent-encoded, JWT-shaped engine tokens), pinned with the client on W5's fixture
  (`test/fixtures/memory-store/fixture.json`, memory-graph e9b18ab, SHA256 c0662f00…) by
  `memory-store.contract.test.ts`.
- Re-pinned on P5 1.5 (W5 approved): the fixture from memory-graph 99ea163 (SHA256 ad59639e…2f213). The client is
  unchanged; every new error maps to its class (`sealed`, `store_full {nodes, limit}`, `unknown_store`,
  `unknown_proposal`, `invalid_request`, the control `scope_forbidden`s). The fake follows the bodies that changed: a
  run's checkpoint after it promoted or proposed is 409 `sealed`, an engine token outside the engine's routes is 403
  `scope_forbidden`, and its tokens carry `kid: memory`, `aud`, `iss`, `iat` and a 3600 s lifetime.

### Engine store, D-2: the instance writer token (2026-10-28)

- No protocol change.
- `SessionStoreClient.create(sid, body)` (`POST /sessions`): control's, and the instance writer token's (role
  `engine`, scope `{owner, publication}`, no `sid` or `lease_id`) for a session of its scope. 201 or 200 (the same
  identity again) → the projection; 409 `session_exists` → `SessionExistsError`; a 403 or a 422 code → `StoreHttpError`
  with its code. `CreateSessionBody` leaves `unit` out under the writer token (the store takes it from the token)
  and `hop.digest` out when the engine does not know it; `SessionProjection.hop.digest` is `string | null` (null
  when the session was created without one).
- `lease` is also the writer token's, on any session of its scope.
- `sessionStore.writeTokenFile` (default `/run/instance/session_store_write_token`): the writer token's file, which
  box A replaces in place; re-read by path on each use.
- The fake session store, kept to mlpal-harness-stack ef6f888 (its 66 contract fixtures, the writer token's
  thirteen among them): `writerToken(owner, publication, unit)`. Such a token creates sessions of its scope (an
  owner, publication or unit other than its own → 403; no body `unit` → the token's; the same identity again → 200,
  another → 409 `session_exists`), and leases, renews, releases, appends to and reads any session of its scope.
  Outside it a session is unknown, `404 unknown_session`, for writes and reads alike (no probing); it lists nothing.
  The projection's `hop.digest` is null when the session was created without one.

### Protocol 0.22.5: `SessionStoreGrant`, the session store credential on the messages that write (2026-10-27)

- Additive over 0.22.4; every 0.22.4 frame remains valid.
- `SessionStoreGrant {leaseId?, token, url?}`: the P1 lease a remote-store engine writes under, the engine-role
  token for it, and the store's base url when the engine has none configured (phase 1 token delivery, seam P2).
  Held in memory for the turn; never logged or persisted.
- `store?: SessionStoreGrant` on `run`, `permission_response`, `question_response` and `approval_response`. A
  `file`-mode engine ignores it; a multi-session remote-store engine refuses a writing message without it.

### Engine store, slice 3: the harness side (2026-10-27)

- No protocol change beyond 0.22.5 (above).
- A resumed turn rebuilds its end-of-turn counters from the turn's entries: its model calls (the assistant
  entries since the turn's first user entry; an answered head is counted by the first iteration), its edits in
  all and per file (successful results of the tools tagged `edits`), and whether a check ran and passed (the
  `executes` tools' commands against the HOP's verify vocabulary, an env-broken output not counting as passed).
  The self-check, the anti-churn breaker and `maxTurns` act as they would have in the live turn. Whether a nudge
  already fired before the restart is not rebuilt: a resumed turn may give the one nudge again.
- A resumed answer spends no classifier call (`classifyStart`): the answer is on record, and the rung stays unset.
- `RemoteStore` has one "goes alone" threshold, the batcher's `batchMaxBytes` (`AppendBatcher.batchMaxBytes`),
  and an event over it reaches `head()`, `read()` and `tail()` only once the store acknowledged it, so no view
  shows an entry the store may still refuse.
- What yodex serve's remote backend needs: the `sessionStore` settings (`backend` `file` | `remote`, `url`,
  `tokenFile`, `readTokenFile`, `leaseTtlS` 1–60, `deltaFlushMs`, `batchMaxEvents`, `batchMaxBytes`,
  `maxEventBytes`, `appendTimeoutMs`; defaults as box A runs the store); `SessionStoreClient.list` and `listAll`
  (`GET /sessions`, paged by `next_after_id`; a scoped reader's owner and publication are imposed by the store);
  `inFlightTurn(entries)`, the rule `resume()` uses, exported for a host deciding whether to resume; and
  `LeaseKeeper.drop()`, which stops renewing without giving the lease back, for a writer that lost its place
  (`seq_conflict`): it must neither keep the lease alive nor hand it on.
- `parkHeadless: "every_ask"` parks a run on any ask with no answerer, not only a §10 safety edge: the result is
  `needs_approval` with `pendingApproval {command, reason: "approval_required"}`. `true` keeps its meaning. yodex
  uses it for a turn it resumes with nobody attached.
- The fake session store's projection drops live asks at `done` and `question_parked` (the store's `end_turn`,
  mlpal-harness-stack c921134).

### Engine store, slice 2: the side-effect key and resume (2026-10-27)

- No protocol change. `run()` is unchanged in what it persists to the conversation; its body after the user turn
  is now one private generator `turn()` that `resume()` enters too.
- `Store` gains two optional methods, implemented by both backends: `appendEvent(sessionId, kind, data)` (an
  event that is not a conversation entry, resolving once it is durable where the backend can resume:
  `RemoteStore` appends a top-level event of that kind and resolves on the store's acknowledgement, to its seq;
  `LocalStore` writes `{kind, ...data}` to the `events` log channel and resolves when it is queued, since file
  mode never resumes, and `YODEX_LOG=off` turns its markers off) and `readEvents(sessionId, kind)` (the data of
  those events, in order).
- The side-effect key: before a tool that is not read-only for its input runs (after the PreToolUse hooks and
  the permission decision), the loop appends `tool_started {toolUseId, name, ts}` (stamped like the run's other
  records) and awaits it, so on the remote store the marker is acknowledged before the effect can happen, and a
  refused marker (a lost lease) stops the tool. A blocked or denied call leaves no marker. File mode writes one
  more `events` record per such tool.
- `AgentSession.resume()` continues a turn a dead engine left in flight. With no turn since the last `result` or
  `error` it returns `{resumed: false}` and writes nothing. Otherwise the head's tool calls without a result are
  settled: one with a `tool_started` marker is never run again and gets an error result
  `INTERRUPTED_TOOL_RESULT` (exported); one without runs now, through the normal path. The turn then continues
  from the head without a new user entry, to its result, and `{resumed: true}`. A head whose model call had
  answered without a tool call is the first iteration's answer, with no second model call, and the
  end-of-turn path runs (the max_tokens continuation, the self-check, the background wait, Stop hooks, owed
  handoff replies). Its counters are rebuilt from the turn's entries (slice 3, above); the escalation rung is
  not carried across a restart. The head is the last user, assistant or tool_result entry (a trailing sub-agent entry
  is not); the run's author is the turn's first user entry not seeded by the system; its result counts the
  turn's model calls before the restart. `markInterrupted` (file mode) is untouched, and `resume()` writes no
  `result {interrupted}`.
- A tool result the session store refuses as too large (`EventTooLargeError`, now in `store/errors`) is replaced
  by an error result for the model: `the tool's result of <N> MiB exceeds the session store's event limit of
  <M> MiB; read a smaller range or write it to a file`; the run goes on. This holds with the store's limit not
  configured: an event over the batch size goes out alone, and `RemoteStore` waits for the store's answer before
  the append returns, so the store's `413 event_too_large` reaches the loop before the model or the stream sees
  the result.
- The session-store contract fixtures are those of mlpal-harness-stack `c921134`, with the one-large-event rule
  (`append-200-large-event`, `append-413-event-too-large`).
- The loop writes no `error` entry for anything a run survives (pinned by a test with a failing hook).
- Slice 1 follow-ups: `LeaseKeeper` aborts every renew in flight (or waiting to retry) on adopt, release and
  loss, and orders renews by a count, not a send time, so a wall-clock step back cannot lose a healthy lease;
  the client's retry wait ends when the caller's signal aborts, and its timer is unref'd.

### Engine store, slice 1: `RemoteStore` added; no behaviour change for file mode (2026-10-27)

- No protocol change. `LocalStore` (the `file` backend) is untouched; nothing constructs the new backend yet
  (the loop's flush points are slice 2, yodex's `--session-store remote` is slice 3).
- Built to the real session store's contract (mlpal-harness-stack `docs/API.md`, "session-store"; its contract
  fixtures are vendored in `test/fixtures/session-store`). **An engine cannot take its own lease**: leasing is
  control-role only, and an engine token (`sid`, `lease_id`) may renew, release, append and read under the
  lease it was handed (per turn in phase 1; at start in phase 2).
- `SessionStoreClient`: P1 over an injected `fetch`, with the bearer from a `tokenProvider` read per request.
  `lease` (control), `renew` (sends `ttl_s`; a lapsed lease is never revived), `release`, `append` /
  `appendEncoded` (data serialized once, the body assembled once before any attempt), `read` (`limit` ≤ 500),
  `readAll` (pages until a page ends at `last_seq`: a page is cut at 500 events or 4 MiB, so a short page is not
  the end; never asks past the head), `projection` (`parks`, `park`, `lease`, and `refusal`, the typed refusal
  the last turn ended on, which is then also `stopReason`), `stream` (an async iterator of `{seq, kind, data}`;
  the store's end of a stream at token expiry, shutdown or erasure, and the caller's abort, finish it normally so
  the caller reconnects after its last seq; `503 stream_capacity` and `429 too_many_streams` throw
  `StreamBusyError` with `retryAfterS`). Retries: every route retries `503 store_busy` and `503 session_busy`
  after `Retry-After`; `append` also retries a network failure or any 5xx with the same `after_seq` (the store
  answers a replay with the original seqs); one budget per call, 3 attempts or 30 s, whichever ends first. Each
  attempt times out after 20 s by default (`timeoutMs`); a caller's `timeoutMs` can only shorten it, and its
  `signal` stops the call. Timestamps are unix milliseconds. Errors carry `status`
  and the body's `code`: `LeaseHeldError` (409 `session_leased`, `expiresAt`), `LeaseLostError` (409
  `lease_lost`, or a lease the keeper lost to its deadline), `SeqConflictError` (409 `seq_conflict`, `lastSeq`),
  `SessionNotFoundError` (404 `unknown_session`), `SessionDeletedError` (410, `deletedAt`), `BatchTooLargeError`
  (413 `batch_too_large` / `event_too_large`, with `maxEvents`, `maxBytes`, `maxEventBytes`), `StoreHttpError`
  (any other status; the base of these), `StoreUnreachableError` (no answer). No error carries the token.
- `AppendBatcher`: the single in-order writer, one batch in flight, cut at 256 events or 1 MiB summed over the
  events' `data`; an event over 1 MiB goes alone. `flush()` resolves once everything queued is acknowledged.
  `append` serializes at once and throws on data it cannot serialize. One event over the store's
  `max_event_bytes` (the `maxEventBytes` option, from the host's `sessionStore.maxEventBytes`, or learned from the
  store's `413 event_too_large`) is refused alone with `EventTooLargeError {bytes, limit}` and the writer goes on.
  Any other failed append is fatal: queued appends reject, `onFatal` fires once, nothing is sent after.
- `LeaseKeeper`: `adopt`s the handed lease and renews at once, then every TTL/3 on its own cadence (a renew that
  never answers does not hold back the next), each renew sending `ttl_s` and giving up after TTL/3 or at the
  deadline, whichever is sooner. The lease is held until TTL − max(1 s, TTL/6) after the newest successful renew
  was sent; a deadline timer loses it whatever is in flight, and the store's `expires_at` can only bring the
  deadline forward (the skew is logged once per lease as `store.lease_clock_skew`, and named in a loss it
  caused). A loss (`lease_lost` or the deadline) fires `onLost`, aborts the `signal` (abandoning any renew in
  flight, so none lands after it) and makes `leaseId` throw the `LeaseLostError`. A second `adopt` stops the old
  renews and makes a fresh `signal`.
- `DeltaCoalescer`: merges consecutive text or thinking deltas into one event per 250 ms; other frames pass
  through in order.
- `RemoteStore implements Store`: one session under one lease. `open()` reads the log once; reads answer from
  memory, including what is queued, as copies. Entries go out as kind = `payload.type` (`ENTRY_KINDS`), logs as
  `log` `{channel, record}`, registry writes as `record` (the record or the patch, folded as merges); `appendEvent`
  for host kinds, `events()` and `lastSeq` for the host. An event too large for the store never stays in memory:
  `conversation.append` and `logs.write` reject with `EventTooLargeError`, or the entry is taken out when the
  store refuses it (logged at error level as `store.event_dropped` with its uuid, kind, bytes and the limit). The mailbox refuses `post` (`MailboxUnavailableError`); another session id is a
  `SessionMismatchError`; `close()` flushes and releases the lease.

### Protocol 0.22.4: `SandboxRefusal`, the remote sandbox at capacity (2026-10-27)

- Additive over 0.22.3; every 0.22.3 frame remains valid.
- `SandboxRefusal {code: "sandbox_capacity", reason, retryAfterS?, sandboxId?, message}`: the remote sandbox
  refused for lack of capacity, a transient "not now", never a lost session. `reason` is one of the router's
  capacity reasons `quota_global`, `quota_tenant`, `host_full`, `no_hosts`; `rate_limited` is not capacity.
  `retryAfterS` is the router's `Retry-After`, present only when it gave one.
- `sandboxRefusal?: SandboxRefusal` on `ToolResultEvent`, `ResultEvent` and `ErrorEvent`, beside `refusal`.
- Harness: `HandsCapacityError(reason, retryAfterS | null, sandboxId?)` and `CAPACITY_REASONS`, exported. A host's
  `HandsClient` throws it in place of its SDK's capacity error; the remote-hands tools then answer `isError` with its
  message (`remote sandbox at capacity (quota_global): retry after 5 s`, or `…: no retry hint`) and
  `meta.sandboxRefusal`, which the loop carries onto the `tool_result` event. Every other error reads as before.
  `err()` takes an optional `meta`, like `ok()`.
- The run-level seam is typed only: the loop's `finish` puts a `sandboxRefusal` on the `result` (with
  `reason = message`) as it does `refusal`, but nothing produces one yet (there is no mid-run auto-resume).

### Protocol 0.22.3: `ScheduleSpec.delivery.webhookSecret`, write-only (2026-10-26)

- Additive over 0.22.2; every 0.22.2 frame remains valid.
- `ScheduleSpec.delivery.webhookSecret?: string | null`: the secret the control plane HMAC-signs each webhook
  delivery with (the S8 shape: `X-Harness-Signature: sha256=<hmac hex over the raw body>`). Taken on `add_schedule`
  and `update_schedule`. Hosted, it goes to hop-service as `delivery.webhook_secret` (SCHEDULES-WIRE §5).
- On `update_schedule`, a `delivery` is the whole delivery: hop-service replaces it, so a key left out removes that
  sink, and dropping `webhook` drops its stored secret too. To rotate a secret, send `webhook` (and `mail`) with it;
  `{delivery: {webhookSecret}}` alone would remove both sinks. The one exception is `webhookSecret`: absent keeps the
  stored secret, `null` clears it (the webhook then goes unsigned and is not sent, status `no_secret`). The control
  plane, not the engine, validates its length.
- Write-only: `ScheduleView`'s `delivery` is now typed without it (`Omit<…, "webhookSecret">`), so no view, listing
  or `schedule` reply carries it; a client that reads `view.delivery.webhookSecret` no longer typechecks.
- Harness: a tool call that fails schema validation still echoes the input it received (truncated), but the values
  of keys matching `secret|token|password|api[_-]?key`, at any depth, now read `"[redacted]"` (numbers and booleans
  stay), so a secret sent alongside another schema error is not repeated.

### Protocol 0.22.2: the budget refusal's `window` and `resetsAt` (2026-10-26)

- Additive over 0.22.1; every 0.22.1 frame remains valid.
- `ModelRefusal.window?: string` (the budget window the spent cap belongs to, e.g. `daily`, `monthly`) and
  `ModelRefusal.resetsAt?: string` (ISO-8601 UTC instant the window resets); `budget_exceeded` only, present
  only when the gateway names them.
- `GatewayError.window` / `.resetAt` read `error.window` / `error.reset_at` of a non-2xx body when they are
  strings (any other type, or `reset_at: null`, is absent); nothing is parsed from the message prose.
  `budgetRefusal(model, hop, {window, resetsAt})` carries them onto the refusal and the loop passes them through
  to the run's `result` (persisted). The gateway puts them in the body since assistants-service `feat/hop-customer-keys`
  d2e0489 (`reset_at` null for a budget that never resets); an older gateway's refusals carry neither.

### The gateway's typed 403 `budget_exceeded` ends a run as a typed refusal (2026-10-26)

- `GatewayError.budgetExceeded`: the gateway's 403 whose body carries `error.code: "budget_exceeded"` (the
  Anthropic-wire envelope `{"type":"error","error":{"type":"permission_error","message":…,"code":"budget_exceeded"}}`).
  Not retried and not failed over (a 403 never is): the budget is the key's, every rung would meet it.
- The loop maps it like the gateway's `model_access_denied`: the run ends with `result` subtype `error` carrying
  `refusal: {code: "budget_exceeded", model, hop, reason: "gateway", message}` (persisted), via `budgetRefusal`.
  Any other 403 code stays an untyped error. Metric `agent.budget_exceeded` beside `agent.model_access_denied`.
- `describeProfile` drops its `HopView["tools"]` cast (protocol 0.22.1 types `include` as optional).

### Protocol 0.22.1: `budget_exceeded` refusal; `HopView.tools.include` optional (2026-10-26)

- Additive over 0.22.0; every 0.22.0 frame remains valid.
- `ModelRefusal.code` is `"model_access_denied" | "budget_exceeded"`. `budget_exceeded`: the gateway refused
  a call mid-run because a budget cap is spent (its typed 403); it rides the same `refusal` field on `error`,
  `result` and `tool_result`, with the model and the HOP, `reason: "gateway"`. A client that switches on
  `code` treats an unknown code as an untyped refusal.
- `HopView.tools.include` is optional: absent = every registered tool, `[]` = none (the harness has left an
  absent include out of `describe_hop` since f7551ef; this closes that type gap).

### HOP `tools.include`: absent = every tool, `[]` = no tools (2026-10-26)

- `Profile.tools.include` is optional. Absent = every registered tool, and a child HOP that omits it inherits
  its parent's value; `[]` = no tools, so a child writing `[]` overrides a parent's list with none; a list is
  that allowlist. The host filters at use time and warns about names it does not register.
- An enabled module's `tools` merge into `[]` and into a list; with `include` absent the merge is a no-op
  (every tool is already in). So `include: []` with a module enabled resolves to that module's tools, not to
  none; a HOP that wants no tools at all also turns its modules off.
- The builtin `coding` HOP drops `include: []` (its include is now absent, the same toolset as before).
- `describeProfile` leaves an absent `include` out of `HopView.tools`. Protocol 0.22 still types it as
  required; it becomes `include?` at the next protocol bump. No protocol change here.
- MIGRATION: a hop.yaml that wrote `tools.include: []` to mean every tool must drop the key; `[]` now means no
  tools.
