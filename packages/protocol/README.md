# @mlpal/harness-protocol

Wire types for the MLPal harness and every yodex frontend: content blocks and messages,
usage, authors, the engine event stream (`EngineEvent` / `SDKMessage`), control messages
(permission round-trips, peer messages) and the `yodex serve` WebSocket protocol
(`ClientMessage` / `ServerMessage`, `PROTOCOL_VERSION`).

```ts
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from "@mlpal/harness-protocol";
```

The package ships ESM + declarations; the content schemas are zod objects, so `zod` is its
one runtime dependency. Under Bun the `bun` export condition resolves straight to the
TypeScript source.

Versioning: the package version tracks the harness release. `PROTOCOL_VERSION` names the
wire protocol a server speaks (`yodex/1`); a frontend checks it on `ready`.
