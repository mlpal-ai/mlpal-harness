# Changelog

## Unreleased

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
