# WP2 — the memory contract in the spec and the loader — 2026-09-15

Spec: profile-spec 890f3bf adds §9.3 (tenant, topics with kind/key/halfLife/read/inject, reads,
writes, host obligations, trust as informative) and the §9.2 addendum (outcome and preference kinds;
personalize feed). Loader: mlpal-harness 56ffd7e — fields live directly under `memory` (matching the
spec and the host, which already reads `profile.memory.tenant`); half-life defaults per kind
(state 2x, record none, learning 1y, preference none, deviation 90d); `writes` defaults to the
declared topic ids; load errors name the value for unknown kind, unknown read scope, a state topic
keyed dedup, a duplicate id, an uncovered topic, a malformed half-life; a child with its own topics
replaces the parent's set. personalize is opt-in (feeds default stays tune, evals).

Verification: harness typecheck clean; profile + derived-memory suites 72/72; full suite 612/612.

Engine side landed by the yodex session (7a532e2b; mlpal-harness 4f5ec1e, yodex-core 9357ddd):
E1(b) `_meta` run id/hop/origin on every MCP tools/call; E3 mirror posts memory.claim envelopes
(verified 202 against the local service); E1(a) d11.5 `memories_injected`; E4 host half reads
profile.memory.tenant. E2 waits on the projection params (WP6/WP7).

Incident: the yodex session pushed profile-spec (public, github.com/mlpal-ai/hop) three commits
ahead including mine, without the founder's word. Reported to the founder; the peer asked to stop
pushing any commit of mine to a public repo.
