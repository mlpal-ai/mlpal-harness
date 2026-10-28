/**
 * W5's P5 contract fixture (mlpal-memory-graph tests/contract/p5/fixture.json, copied into
 * test/fixtures/memory-store; see its README): one keyed file, written by memory-graph from its real routes. The
 * loader keeps the parts the engine's client and the fake are pinned on, typed, and refuses a file without them.
 */
import { existsSync, readFileSync } from "node:fs";

export interface MemoryStoreFixtureError {
  /** The fixture's key, `"<status> <code>"`. */
  name: string;
  status: number;
  body: unknown;
}

export interface MemoryStoreFixture {
  contract: string;
  /** `/api/v1`. */
  mount: string;
  errors: MemoryStoreFixtureError[];
  checkpoint: { request: Record<string, unknown>; response: Record<string, unknown>; stagingScope: { scope: string; scope_id: string } };
  /** The engine token's claims the fixture's flow ran under. */
  engineToken: Record<string, unknown>;
  promote: {
    /** `POST /api/v1/memory/stores/<store>/runs/<run>/promote`. */
    request: string;
    auto: Record<string, unknown>;
    repeat: Record<string, unknown>;
    review: Record<string, unknown>;
    /** The same promotion with the store id percent-encoded (`hop%3A5%2Facme`), and its answer. */
    encoded: { request: string; response: Record<string, unknown> };
  };
}

const obj = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`memory-store fixture: ${what} missing`);
  return v as Record<string, unknown>;
};

/** null when the file is absent; throws naming the part that is missing. */
export function loadMemoryStoreFixture(path: string): MemoryStoreFixture | null {
  if (!existsSync(path)) return null;
  const raw = obj(JSON.parse(readFileSync(path, "utf8")), "the file");
  if (typeof raw.mount !== "string") throw new Error("memory-store fixture: mount missing");
  const errors = Object.entries(obj(raw.errors, "errors")).map(([name, v]) => {
    if (!Array.isArray(v) || typeof v[0] !== "number") throw new Error(`memory-store fixture: errors.${name} is not [status, body]`);
    return { name, status: v[0], body: v[1] };
  });
  const ck = obj(raw.checkpoint, "checkpoint");
  const auto = obj(raw.promote_auto, "promote_auto");
  if (typeof auto.request !== "string") throw new Error("memory-store fixture: promote_auto.request missing");
  return {
    contract: String(raw.contract ?? ""),
    mount: raw.mount,
    errors,
    checkpoint: { request: obj(ck.request, "checkpoint.request"), response: obj(ck.response, "checkpoint.response"), stagingScope: obj(ck.staging_scope, "checkpoint.staging_scope") as { scope: string; scope_id: string } },
    engineToken: obj(obj(raw.tokens, "tokens").engine, "tokens.engine"),
    promote: {
      request: auto.request,
      auto: obj(auto.response, "promote_auto.response"),
      repeat: obj(raw.promote_repeat_is_same_body, "promote_repeat_is_same_body"),
      review: obj(obj(raw.promote_review, "promote_review").response, "promote_review.response"),
      encoded: (() => {
        const e = obj(raw.store_id_percent_encoded, "store_id_percent_encoded");
        if (typeof e.request !== "string") throw new Error("memory-store fixture: store_id_percent_encoded.request missing");
        return { request: e.request, response: obj(e.response, "store_id_percent_encoded.response") };
      })(),
    },
  };
}
