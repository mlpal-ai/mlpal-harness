# Session-store contract fixtures

Copied unchanged from `mlpal-harness-stack` `session-store/tests/contract/*.json` at commit `055e286`
(origin/main; the files last changed in `e1f81ec`). The real store builds each file through its handlers
(`session-store/tests/contract.rs`), so they are its response shapes.

`test/fake-session-store.contract.test.ts` drives the fake store with every file and checks that
`SessionStoreClient` reads each body. To take a newer set, replace the `*.json` files here and update the
commit above; the test loads whatever this directory holds and fails on a fixture it has no scenario for.
