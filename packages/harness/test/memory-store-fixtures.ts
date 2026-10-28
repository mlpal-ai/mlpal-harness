/**
 * W5's P5 contract fixtures (mlpal-memory-graph tests/contract/p5, copied into test/fixtures/memory-store when they
 * land): one JSON file per case, in the session-store fixtures' shape — `{route: "<METHOD> /v1/<path template>",
 * case, request?, status, content_type?, body}`. The loader maps each route onto the client operation that calls it;
 * a route the engine does not call (the review queue, rollback, export) is kept with `op: null`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MemoryStoreOp = "checkpoint" | "search" | "projection" | "promote";

export interface MemoryStoreFixture {
  name: string;
  route: string;
  case: string;
  request?: unknown;
  status: number;
  content_type?: string | null;
  body: unknown;
  op: MemoryStoreOp | null;
}

const OPS: Record<string, MemoryStoreOp> = {
  "POST /v1/memory/checkpoint": "checkpoint",
  "GET /v1/memory/search": "search",
  "GET /v1/memory/projection": "projection",
  "POST /v1/memory/stores/{store}/runs/{run_id}/promote": "promote",
};

export function loadMemoryStoreFixtures(dir: string): MemoryStoreFixture[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as Omit<MemoryStoreFixture, "name" | "op">;
      if (typeof raw.route !== "string" || typeof raw.status !== "number") throw new Error(`memory-store fixture ${f}: needs route and status`);
      return { ...raw, name: f.slice(0, -5), op: OPS[raw.route] ?? null };
    });
}
