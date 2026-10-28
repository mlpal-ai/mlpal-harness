# Changelog

## Unreleased

### Profile `confineTo`: `hop.yaml` itself, and required at every prompt site (2026-10-28)

- Under `LoadProfileOptions.confineTo` the loader confines `hop.yaml` itself: one that is a symlink out of the HOP's
  directory is `HopPathError {field: "hop.yaml"}` before it is read.
- `composeProfile` and the prompt resolver take `confineTo` as a required parameter (`string | undefined`), so no call
  site (system, verifierAgent, summarizer, condenser, a module's prompt) can drop it by omission; each is tested.

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
