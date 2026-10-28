import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where W2's P4 router fixture is pinned (a copy of `mlpal-fc-router/tests/contract/p4/`). */
export const FC_ROUTER_P4_DIR = join(import.meta.dir, "fixtures", "fc-router", "p4");

/** One recorded exchange of the router's real code path. */
export interface RouterCase {
  name: string;
  route: string;
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  status: number;
  body: unknown;
}

/** Every `*.json` case in `dir`, sorted by name; a file that is not a case is named. */
export function loadRouterCases(dir: string): RouterCase[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<RouterCase>;
      const ok = typeof c.route === "string" && typeof c.status === "number" && typeof c.request?.method === "string" && typeof c.request?.path === "string" && "body" in c;
      if (!ok) throw new Error(`${f}: not a router case (route, request {method, path}, status, body)`);
      return { ...(c as RouterCase), name: f.replace(/\.json$/, "") };
    });
}

/** The router commit the copy was taken at (`Pinned: <sha>` in the README), or null before it lands. */
export function pinnedSha(dir: string): string | null {
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) return null;
  return /^Pinned: ([0-9a-f]{7,40})$/m.exec(readFileSync(readme, "utf8"))?.[1] ?? null;
}
