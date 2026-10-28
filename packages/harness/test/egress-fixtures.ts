import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** W4's egress proxy contract fixtures (fixtures/egress-proxy, see its README), loaded by path. */
export const EGRESS_FIXTURES_DIR = join(import.meta.dir, "fixtures", "egress-proxy");

export interface EgressFixture {
  name: string;
  route: string;
  case: string;
  status?: number;
  content_type?: string | null;
  body: unknown;
  headers?: Record<string, string>;
  request?: { body?: unknown; headers?: Record<string, string> };
  upstream_saw?: Record<string, string | null>;
}

export function egressFixtures(dir = EGRESS_FIXTURES_DIR): EgressFixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f.slice(0, -".json".length), ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as Omit<EgressFixture, "name">) }));
}

/** The proxy's refusals, by code: what the proxy answers (status, content type, body, its own header). */
export function proxyRefusals(dir = EGRESS_FIXTURES_DIR): Record<string, EgressFixture> {
  return Object.fromEntries(
    egressFixtures(dir)
      .filter((f) => f.name.startsWith("proxy-") && f.headers?.["x-harness-egress"] === "refused")
      .map((f) => [(f.body as { code: string }).code, f]),
  );
}
