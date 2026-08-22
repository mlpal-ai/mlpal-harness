# MLPal Harness

The agent-loop engine behind [yodex](https://github.com/mlpal-ai/yodex), split out as a
product-neutral runtime. One engine, many agents: the harness runs the loop — tools,
verification, permissions, routing, context, sub-agents — and a **HOP** (Harness
Optimization Profile, [spec](https://github.com/mlpal-ai/hop)) declares what kind of
agent it is. yodex is this engine plus the builtin `coding` HOP; the builtin `reviewer`
HOP runs read-only, fail-closed review on the same loop.

- `packages/harness` (`@mlpal/harness`) — the engine: agent loop, builtin tools,
  verification seams, permission engine, model routing, compaction, sub-agents, MCP,
  skills, the HOP loader, and the builtin HOPs
- `packages/protocol` (`@mlpal/harness-protocol`) — wire types for sessions, events,
  and transports

## Embedding

```ts
import { configureHost, loadProfile, AgentSession } from "@mlpal/harness";

configureHost({ name: "acme", configDirName: ".acme", envPrefix: "ACME" });
const hop = loadProfile("reviewer", { cwd, home });
// build an AgentSession with hop.loop, hop.prompts, hop.tools — see yodex's
// buildSession for the reference wiring
```

The engine is product-neutral: display name, config directory, and env-var prefix come
from `configureHost` (defaults are yodex's). HOP prompt text is deliberately *not*
host identity — a HOP may be product-branded.

## Status

Extracted from yodex-core at 0.8.0+ (provenance: commit 51fbcd2 there); behavior
pinned by golden tests and a paired no-regression benchmark (8/8 both builds, table in
the [HOP paper](https://github.com/mlpal-ai/hop)). License: Apache-2.0.

Contact: contact@mlpal.ai
