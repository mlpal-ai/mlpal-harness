# Memory-store (P5) contract fixture

`fixture.json` is copied unchanged from `mlpal-memory-graph` `tests/contract/p5/fixture.json` at commit
`e9b18ab` (branch `w5-memory-store`, contract P5 1.3), SHA-256
`c0662f005105d7085fb326fa5f2d861860adb36b9e53517120546e406940b711` (the SHA W5 posted on BOARD.md). memory-graph writes it from its real routes
(`P5_WRITE_FIXTURE=1 pytest tests/contract/p5`), so its bodies are the store's.

`test/memory-store.contract.test.ts` replays every error and answer in it through `MemoryStoreClient`, and drives
the fake store (`test/fake-memory-store.ts`) through the same flow, comparing its bodies with the fixture's. To
take a newer fixture, replace the file and update the commit and SHA above; an error the test has no expectation
for fails it. The §f parts (rollback, redact, export, delete) are the control token's, not the engine's: the
loader leaves them out, and their errors (`invalid_version`) only have to map to the base class.
