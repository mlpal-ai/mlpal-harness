# Memory-store (P5) contract fixture

`fixture.json` is copied unchanged from `mlpal-memory-graph` `tests/contract/p5/fixture.json` at commit
`99ea163` (branch `w5-memory-store`, contract P5 1.5, W5 approved), SHA-256
`ad59639e66abcc352a5dee48bab995b63e5b88acb60017d298b061da12c6f213`. memory-graph writes it from its real routes
(`P5_WRITE_FIXTURE=1 pytest tests/contract/p5`), so its bodies are the store's.

`test/memory-store.contract.test.ts` replays every error and answer in it through `MemoryStoreClient`, and drives
the fake store (`test/fake-memory-store.ts`) through the same flow, comparing its bodies with the fixture's. To
take a newer fixture, replace the file and update the commit and SHA above; an error the test has no expectation
for fails it. The §f parts (rollback, redact, export, delete) and the review queue are the control token's, not
the engine's: the loader leaves them out, and their errors (`invalid_version`, `invalid_request`, `unknown_proposal`,
`already_decided`, the control `scope_forbidden`s) only have to map to their class.
