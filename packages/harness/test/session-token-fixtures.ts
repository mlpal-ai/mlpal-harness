import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** W4's gateway session-token contract fixtures (fixtures/p6-session-token, see its README), loaded by path. */
export const SESSION_TOKEN_FIXTURES_DIR = join(import.meta.dir, "fixtures", "p6-session-token");

export interface SessionTokenFixture {
  name: string;
  case: string;
  status?: number;
  body?: unknown;
  [k: string]: unknown;
}

export function sessionTokenFixtures(dir = SESSION_TOKEN_FIXTURES_DIR): SessionTokenFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as { case: string }), name: f.slice(0, -".json".length) }) as SessionTokenFixture);
}
