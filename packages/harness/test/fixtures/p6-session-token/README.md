# Gateway session-token contract fixtures (P6)

Copied unchanged from `mlpal-assistants-service` `tests/contract/p6-session-token/*.json` at commit
`a45fe8ffb8706bccf35346c0cf0121841107e211` (branch `p2-w4-session-tokens`; contract P6-vault-egress 1.4, §"Scoped gateway tokens"). Read with
`git show` from the local checkout's object store (no fetch, no clone); the gateway builds each file from its real
code path.

`test/session-token.contract.test.ts` replays the 401 and both 403 bodies through `GatewayClient`'s bearer, re-read
and refusal handling, and sends a token built from `token-claims.json`'s vector to show the engine passes it through
verbatim. `audit-model-call.json` and `usage-row-key-tags.json` are gateway-internal and skipped by name. To take a
newer set, replace the `*.json` files and update the commit above.
