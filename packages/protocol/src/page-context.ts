/**
 * C2 PageContextV1 (managed-v1 contracts): what page the person is on, asserted by their browser. It authorises
 * nothing, it is data and never instructions, and it never becomes memory. A consumer checks it by shape only, never
 * against a copy of the frontend's route or figure tables, so a new page needs no consumer deploy.
 */

export type PageEntityKind =
  | "static_agent"
  | "mcp_server"
  | "assistant"
  | "hop"
  | "publication"
  | "schedule"
  | "skill"
  | "plugin"
  | "secret"
  | "workspace"
  | "site";

export type PageFigureUnit = "cu" | "usd" | "tokens" | "gb" | "count" | "seconds";

export interface PageContextV1 {
  v: 1;
  /** Rises per change within one socket connection; the server keeps the highest. */
  seq: number;
  surface: "landing" | "dashboard";
  routeId: string;
  /** The route pattern (`/dashboard/static-agents/:id`), never the URL. */
  route: string;
  title: string;
  view?: { tab?: string; section?: string };
  /** At most 10. `name` is the one user-authored field. */
  entities?: Array<{ kind: PageEntityKind; id: string; name?: string; status?: string }>;
  /** At most 20. A string value is a token, never free text. */
  figures?: Array<{ key: string; value: number | string; unit?: PageFigureUnit }>;
}

/** Why a context was refused (C2's vector reasons, plus `not_object` and `size`). */
export type PageContextRejection =
  | "not_object"
  | "size"
  | "unknown_field"
  | "version"
  | "seq"
  | "surface"
  | "routeId"
  | "route"
  | "title"
  | "view"
  | "entity"
  | "figure";

export type PageContextCheck = { ok: true; context: PageContextV1 } | { ok: false; reason: PageContextRejection };

/** C2: the whole object as compact UTF-8 JSON. */
export const PAGE_CONTEXT_MAX_BYTES = 2048;

const TOKEN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const ROUTE = /^\/[A-Za-z0-9/:_-]{0,119}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const KINDS: ReadonlySet<string> = new Set<PageEntityKind>(["static_agent", "mcp_server", "assistant", "hop", "publication", "schedule", "skill", "plugin", "secret", "workspace", "site"]);
const UNITS: ReadonlySet<string> = new Set<PageFigureUnit>(["cu", "usd", "tokens", "gb", "count", "seconds"]);
const utf8 = new TextEncoder();
const TOP_FIELDS = new Set(["v", "seq", "surface", "routeId", "route", "title", "view", "entities", "figures"]);

class Rejected extends Error {
  constructor(readonly reason: PageContextRejection) {
    super(reason);
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const tok = (x: unknown): boolean => typeof x === "string" && TOKEN.test(x);
/** 1–80 characters, none of them a control character. */
const text = (x: unknown): boolean => typeof x === "string" && x.length >= 1 && [...x].length <= 80 && !CONTROL.test(x);

function only(o: Record<string, unknown>, fields: readonly string[]): void {
  for (const k of Object.keys(o)) if (!fields.includes(k)) throw new Rejected("unknown_field");
}

function need(ok: boolean, reason: PageContextRejection): void {
  if (!ok) throw new Rejected(reason);
}

function checkList(list: unknown, max: number, reason: PageContextRejection, fields: readonly string[], item: (o: Record<string, unknown>) => boolean): void {
  if (list === undefined) return;
  need(Array.isArray(list) && list.length <= max, reason);
  for (const e of list as unknown[]) {
    need(isRecord(e), reason);
    only(e as Record<string, unknown>, fields);
    need(item(e as Record<string, unknown>), reason);
  }
}

function check(x: unknown): PageContextV1 {
  need(isRecord(x), "not_object");
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) need(TOP_FIELDS.has(k), "unknown_field");
  need(o.v === 1, "version");
  need(Number.isSafeInteger(o.seq) && (o.seq as number) >= 0, "seq");
  need(o.surface === "landing" || o.surface === "dashboard", "surface");
  need(tok(o.routeId), "routeId");
  need(typeof o.route === "string" && ROUTE.test(o.route), "route");
  need(text(o.title), "title");
  if (o.view !== undefined) {
    need(isRecord(o.view), "view");
    const view = o.view as Record<string, unknown>;
    only(view, ["tab", "section"]);
    need(Object.values(view).every(tok), "view");
  }
  checkList(o.entities, 10, "entity", ["kind", "id", "name", "status"], (e) =>
    typeof e.kind === "string" && KINDS.has(e.kind) && typeof e.id === "string" && ID_TOKEN.test(e.id) && (e.name === undefined || text(e.name)) && (e.status === undefined || tok(e.status)),
  );
  checkList(o.figures, 20, "figure", ["key", "value", "unit"], (f) =>
    tok(f.key) && ((typeof f.value === "number" && Number.isFinite(f.value)) || tok(f.value)) && (f.unit === undefined || (typeof f.unit === "string" && UNITS.has(f.unit))),
  );
  need(utf8.encode(JSON.stringify(o)).length <= PAGE_CONTEXT_MAX_BYTES, "size");
  return o as unknown as PageContextV1;
}

/** C2's shape rules. An invalid context is the caller's to drop (never the turn), with the reason counted. */
export function checkPageContext(x: unknown): PageContextCheck {
  try {
    return { ok: true, context: check(x) };
  } catch (e) {
    if (e instanceof Rejected) return { ok: false, reason: e.reason };
    throw e;
  }
}
