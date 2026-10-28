# Engine egress proxy contract fixtures (P6)

Copied unchanged from `mlpal-harness-stack` `egress-proxy/tests/contract/*.json` at commit
`f5902f8b128298ef256ca429c36bd57d5edfc15b` (branch `p2-w4-secrets-egress`; contract P6-vault-egress 1.4; 28 files: d5d56a5's 26 unchanged, plus
`proxy-401-echo-redacted` and `proxy-502-upstream-encoding-refused`). The real
proxy builds each file through its handlers (`egress-proxy/tests/contract.rs`), so they are its shapes.

The engine consumes the proxy routes only: `test/egress-proxy.contract.test.ts` runs every `proxy-*` file through
the engine's proxy client (`egressFetch`) against `test/fake-egress-proxy.ts`, which answers its refusals from these
files, and reads `egress-token-claims.json`'s upstreams as the engine's egress routes. The vault's own routes
(`create-*`, `list-*`, `rotate-*`, `revoke-*`, `sandbox-ref-*`) are W6's and are skipped by name. To take a newer
set, replace the `*.json` files and update the commit above; the test fails on a `proxy-*` file it has no scenario
for.
