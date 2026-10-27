# Changelog

## Unreleased

### Engine store, slice 1: `RemoteStore` added; no behaviour change for file mode (2026-10-27)

- No protocol change. `LocalStore` (the `file` backend) is untouched; nothing constructs the new backend yet
  (the loop's flush points are slice 2, yodex's `--session-store remote` is slice 3).
- Built to the real session store's contract (mlpal-harness-stack `docs/API.md`, "session-store"; its contract
  fixtures are vendored in `test/fixtures/session-store`). **An engine cannot take its own lease**: leasing is
  control-role only, and an engine token (`sid`, `lease_id`) may renew, release, append and read under the
  lease it was handed (per turn in phase 1; at start in phase 2).
- `SessionStoreClient`: P1 over an injected `fetch`, with the bearer from a `tokenProvider` read per request.
  `lease` (control), `renew` (optional `ttlS`; a lapsed lease is never revived), `release`, `append` (a network
  failure or a 5xx is retried up to 3 times with the same `after_seq`, honouring `Retry-After`; the store answers
  a replay with the original seqs), `read` (`limit` ≤ 500), `readAll` (never asks past the head), `projection`
  (`parks`, `park`, `lease`). Timestamps are unix milliseconds. Errors carry `status` and the body's `code`:
  `LeaseHeldError` (409 `session_leased`, `expiresAt`), `LeaseLostError` (409 `lease_lost`), `SeqConflictError`
  (409 `seq_conflict`, `lastSeq`), `SessionNotFoundError` (404 `unknown_session`), `SessionDeletedError` (410,
  `deletedAt`), `BatchTooLargeError` (413, `maxEvents`, `maxBytes`), `StoreHttpError` (any other status; the base
  of these), `StoreUnreachableError` (no answer). No error carries the token.
- `AppendBatcher`: the single in-order writer, one batch in flight, cut at 256 events or 1 MiB summed over the
  events' `data`; `flush()` resolves once everything queued is acknowledged. Any failed append is fatal: queued
  appends reject, `onFatal` fires once, nothing is sent after.
- `LeaseKeeper`: `adopt`s the handed lease, renews every TTL/3, and on `lease_lost` (or no good renew for a whole
  TTL) fires `onLost` once and aborts its `signal`.
- `DeltaCoalescer`: merges consecutive text or thinking deltas into one event per 250 ms; other frames pass
  through in order.
- `RemoteStore implements Store`: one session under one lease. `open()` reads the log once; reads answer from
  memory including what is queued. Entries go out as kind = `payload.type` (`ENTRY_KINDS`), logs as `log`
  `{channel, record}`, registry writes as `record` (the record or the patch, folded as merges); `appendEvent`
  for host kinds, `events()` and `lastSeq` for the host. The mailbox refuses `post` (`MailboxUnavailableError`);
  another session id is a `SessionMismatchError`; `close()` flushes and releases the lease.

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
