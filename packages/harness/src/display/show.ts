import {
  asDisplayError,
  checkShowInput,
  DISPLAY_CATALOG,
  DISPLAY_LIMITS,
  HOST_OWNED_KINDS,
  isBlockKind,
  noteInputSchema,
  showInputSchema,
  type BlockDisplay,
  type DisplayEnvelope,
  type DisplayError,
  type DisplaySource,
  type Note,
  type TextDisplay,
  type ValidShow,
} from "@mlpal/harness-protocol";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Logger } from "../obs/logger";
import type { Metrics } from "../obs/metrics";
import { parseJsonLenient } from "../tools/json";
import { declaredArgsOf, defineTool, sanitizeJsonSchema, type Tool, type ToolContext, type ToolResult } from "../tools/types";
import type { DisplayHistory } from "./history";
import type { DisplayPolicy } from "./policy";

/**
 * Show (DISPLAY-PROTOCOL-v0 §3): the engine's tool for putting one typed block in front of the person. Its input is
 * checked before any client sees it; a refusal is a tool error carrying the code, path and hint the model repairs
 * from, and while it repairs the person sees the fallback (a `text` envelope, `repairing`). Each block gets one
 * repair a turn: a second failure is RETRY_EXHAUSTED and the fallback stays (`fallback_only`); a third call is refused
 * unseen. Only a client that draws blocks is offered Show (resolveDisplay).
 *
 * Counting, deliberately: the repair is one per failure, and a success clears it, so a block that alternates between
 * failing and succeeding in one turn gets a repair after each failure (bounded by 200 revisions a block). Two failing
 * Shows of one block in one message count as the failure and its repair, as two calls in a row would.
 * `display.repair{outcome=attempted}` is counted at the first failure: a repair is now owed; `repaired` and
 * `exhausted` say how it ended.
 *
 * The model reads one short line; the step's `content` (what a client that draws nothing else shows) is that line
 * and the complete fallback. Nothing the model wrote is logged: counters and log lines carry the id, kind, level,
 * revision, size and error code only.
 */

export const SHOW_TOOL = "Show";

/** What a call falls back to when the store cannot be read: revisions continue from this session's own. */
const EMPTY_HISTORY: DisplayHistory = { revisions: new Map(), toolUseIds: new Set() };

export interface ShowToolDeps {
  policy: DisplayPolicy;
  /** The session's record as it stands now (the store, after rewinds), seen from the Show call `toolUseId`. */
  history: (toolUseId?: string) => Promise<DisplayHistory>;
  logger: Logger;
  metrics: Metrics;
}

/** The model's schema: the protocol's Show input. The tool's own schema accepts anything, so that every fault is
 *  answered with a typed code by the check (and the fallback shown), never with the registry's generic error. */
const SHOW_JSON = zodToJsonSchema(showInputSchema, { $refStrategy: "none" }) as { required?: string[] } & Record<string, unknown>;
/** The keys Show declares, read before sanitising (which drops additionalProperties: false): a rule that reads
 *  arguments can judge a Show call, and a key outside them is undeclared (permission/engine.ts). */
const SHOW_DECLARED_ARGS = declaredArgsOf(SHOW_JSON);
const SHOW_JSON_SCHEMA = (() => {
  const js = structuredClone(SHOW_JSON);
  sanitizeJsonSchema(js);
  js.required = [...new Set([...(js.required ?? []), "spec"])];
  return js;
})();

const DESCRIPTION =
  "Show the person one typed block (a chart, summary tiles or a data grid) beside your answer, when it makes the answer clearer than prose. " +
  "Your instructions list the kinds this client draws and each kind's spec. fallback.text is required: the conclusion and the key numbers in plain markdown, " +
  "which is all a person who cannot see the block reads. Name sources in words (which tool or data, as of when); a tool call id only if you have it verbatim. " +
  "Show again with the same block_id to replace a block. A refusal names a code, a path and a hint: " +
  "fix it and call Show once more with the same block_id.";

/** Fields models hand over as JSON strings. A fallback is text in its own right, so only an object-looking one is
 *  parsed. */
const NESTED = ["spec", "notes", "placement", "sources"] as const;

function lenientInput(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const parse = (k: string, openers: RegExp) => {
    const v = out[k];
    if (typeof v !== "string" || !openers.test(v)) return;
    // A string the reader cannot take (a stack overflow on a pathological nesting included) stays a string, which the
    // check then refuses with a typed code.
    try {
      const parsed = parseJsonLenient(v);
      if (parsed.ok) out[k] = parsed.value;
    } catch {
      return;
    }
  };
  for (const k of NESTED) parse(k, /^\s*[[{]/);
  parse("fallback", /^\s*\{/);
  return out;
}

type Outcome = { ok: true; show: ValidShow; provenance: Provenance } | { ok: false; error: DisplayError; errors?: DisplayError[]; omitted?: number; block_id?: string; fallback?: string };

/** Per-turn repair state and the revisions this session assigned but may not have written yet (calls in one
 *  message run concurrently). */
class ShowState {
  private run: string | undefined;
  private failures = new Map<string, number>();
  private lastFallback = new Map<string, string>();
  private shownThisTurn = new Set<string>();
  private readonly assigned = new Map<string, number>();

  turn(runId: string | undefined): void {
    if (runId === this.run) return;
    this.run = runId;
    this.failures = new Map();
    this.lastFallback = new Map();
    this.shownThisTurn = new Set();
  }

  failuresOf(id: string): number {
    return this.failures.get(id) ?? 0;
  }

  fail(id: string, fallback: string | undefined): number {
    const n = this.failuresOf(id) + 1;
    this.failures.set(id, n);
    if (fallback) this.lastFallback.set(id, fallback);
    return n;
  }

  succeed(id: string): void {
    this.failures.delete(id);
    this.lastFallback.delete(id);
  }

  /** The last valid fallback this turn's failed attempts at a block carried. */
  fallbackOf(id: string): string | undefined {
    return this.lastFallback.get(id);
  }

  revisionOf(id: string, history: DisplayHistory): number {
    return Math.max(history.revisions.get(id) ?? 0, this.assigned.get(id) ?? 0);
  }

  nextRevision(id: string, history: DisplayHistory): number {
    const r = this.revisionOf(id, history) + 1;
    this.assigned.set(id, r);
    this.shownThisTurn.add(id);
    return r;
  }

  isNewThisTurn(id: string): boolean {
    return !this.shownThisTurn.has(id);
  }

  blocksThisTurn(): number {
    return this.shownThisTurn.size;
  }
}

function sourceOf(show: ValidShow, ids: string[]): DisplaySource {
  return { by: "model", ...(ids.length ? { tool_use_ids: ids } : {}), ...(show.as_of ? { as_of: show.as_of } : {}) };
}

/** How a source the model named was taken: an id of this session (verified), a tool name called once since the
 *  person's last message (mapped, verified), words (unverified, kept as a label), or unusable (dropped: control
 *  characters, too long, empty; never echoed). */
type SourceState = "verified" | "mapped" | "unverified" | "dropped";

/** A label as a source note's text: what the protocol's note text allows. */
const LABEL = noteInputSchema.shape.text;

interface Provenance {
  ids: string[];
  notes: Note[];
  states: SourceState[];
}

/**
 * Provenance is verified when it can be, never a gate (the first real-model run cited the command line: models do not
 * reliably know their tool call ids). Sources and notes' tool call refs are resolved against the calls that completed
 * without an error before this Show's message (DisplayHistory.verifiableIds); what does not resolve is shown
 * unverified or dropped, and the block is shown.
 */
function resolveProvenance(show: ValidShow, history: DisplayHistory, state: ShowState): Provenance {
  const recent = history.recentCalls ?? [];
  const callOf = (s: string): { id: string; state: "verified" | "mapped" } | null => {
    if (history.verifiableIds?.has(s)) return { id: s, state: "verified" };
    const hits = recent.filter((c) => c.name === s.trim());
    return hits.length === 1 ? { id: hits[0]!.id, state: "mapped" } : null;
  };
  const usable = (s: string) => LABEL.safeParse(s.trim()).success;
  const states: SourceState[] = [];
  const ids: string[] = [];
  const labels: string[] = [];
  for (const s of show.sources ?? []) {
    const call = callOf(s);
    if (call) {
      if (!ids.includes(call.id)) ids.push(call.id);
      states.push(call.state);
    } else if (usable(s)) {
      labels.push(s.trim());
      states.push("unverified");
    } else states.push("dropped");
  }
  const notes: Note[] = [];
  for (const n of show.notes ?? []) {
    const id = n.ref?.tool_use_id;
    const block = n.ref?.block_id;
    if (id === undefined) {
      const verified = block !== undefined ? state.revisionOf(block, history) > 0 : undefined;
      notes.push(verified === undefined ? n : { ...n, verified });
      continue;
    }
    const call = callOf(id);
    if (call) {
      states.push(call.state);
      notes.push({ ...n, ref: { ...n.ref, tool_use_id: call.id }, verified: true });
      continue;
    }
    states.push(usable(id) && id.length <= 128 ? "unverified" : "dropped");
    const { tool_use_id: _dropped, ...rest } = n.ref!;
    const { ref: _ref, ...note } = n;
    notes.push({ ...note, ...(Object.keys(rest).length ? { ref: rest } : {}), verified: false });
  }
  const taken = new Set(notes.map((n) => n.id));
  let next = 1;
  for (const text of labels) {
    if (notes.length >= DISPLAY_LIMITS.notes) {
      states[states.indexOf("unverified")] = "dropped";
      continue;
    }
    while (taken.has(`source-${next}`)) next++;
    taken.add(`source-${next}`);
    notes.push({ id: `source-${next}`, kind: "source", text, verified: false });
  }
  return { ids, notes, states };
}

function displayError(code: DisplayError["code"], path: string, message: string, hint?: string): DisplayError {
  return { code, path, message, ...(hint ? { hint } : {}) };
}

/** Engine checks the protocol cannot make: the turn's block count, a block's revision count. Provenance is resolved
 *  here too, and never refuses. */
function checkSession(show: ValidShow, history: DisplayHistory, state: ShowState): Outcome {
  if (state.isNewThisTurn(show.block_id) && state.blocksThisTurn() >= DISPLAY_LIMITS.blocksPerTurn) {
    return { ok: false, error: displayError("TOO_MANY_BLOCKS", "block_id", `at most ${DISPLAY_LIMITS.blocksPerTurn} blocks a turn`, "replace a block you showed (same block_id) or say the rest in prose") };
  }
  if (state.revisionOf(show.block_id, history) >= DISPLAY_LIMITS.revisionsPerBlock) {
    return { ok: false, error: displayError("TOO_MANY_BLOCKS", "block_id", `${show.block_id} has ${DISPLAY_LIMITS.revisionsPerBlock} revisions`, "show it under a new block_id") };
  }
  return { ok: true, show, provenance: resolveProvenance(show, history, state) };
}

function blockEnvelope(show: ValidShow, provenance: Provenance, revision: number): BlockDisplay {
  return {
    v: 1,
    block_id: show.block_id,
    revision,
    op: "snapshot",
    level: "block",
    kind: show.kind,
    catalog: DISPLAY_CATALOG,
    spec: show.spec,
    fallback: { text: show.fallback },
    source: sourceOf(show, provenance.ids),
    ...(show.title ? { title: show.title } : {}),
    ...(show.caption ? { caption: show.caption } : {}),
    ...(show.placement ? { placement: show.placement } : {}),
    ...(provenance.notes.length ? { notes: provenance.notes } : {}),
    status: "ok",
  } as BlockDisplay;
}

/** What Show answers: `model` is what the model reads, `shown` the step's display string (the line and the fallback). */
function result(o: { model: string; shown: string; display?: DisplayEnvelope[]; outcome: "shown" | "refused" }): ToolResult {
  return {
    content: [{ type: "text", text: o.model }],
    ...(o.outcome === "refused" ? { isError: true } : {}),
    meta: { displayText: o.shown, ...(o.display ? { display: o.display } : {}) },
  };
}

/** The final text of a block whose repair failed and none of whose attempts carried a valid fallback. */
const COULD_NOT_SHOW = "This block could not be shown; the answer is in the conversation.";

export function createShowTool(deps: ShowToolDeps): Tool<unknown> {
  const { policy, logger: log, metrics } = deps;
  const state = new ShowState();

  function shown(show: ValidShow, provenance: Provenance, history: DisplayHistory): ToolResult {
    const repaired = state.failuresOf(show.block_id) > 0;
    state.succeed(show.block_id);
    if (repaired) metrics.increment("display.repair", 1, { outcome: "repaired" });
    const revision = state.nextRevision(show.block_id, history);
    const envelope = blockEnvelope(show, provenance, revision);
    for (const st of provenance.states) metrics.increment("display.sources", 1, { state: st });
    const unknown = provenance.states.filter((st) => st === "unverified" || st === "dropped").length;
    if (unknown) metrics.increment("display.notices", 1, { code: "SOURCE_UNKNOWN" });
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    metrics.increment("display.emitted", 1, { level: "block", kind: show.kind, source: "model" });
    metrics.histogram("display.bytes", bytes, { level: "block", kind: show.kind });
    log.info("display shown", { block_id: show.block_id, kind: show.kind, level: "block", revision, bytes });
    const where = show.placement?.surface === "canvas" ? "on the canvas" : "in the thread";
    const notice = unknown
      ? `\nSOURCE_UNKNOWN (a notice, not an error): ${unknown === 1 ? "1 source is not a tool call" : `${unknown} sources are not tool calls`} of this session, so ${unknown === 1 ? "it is" : "they are"} shown as unverified.`
      : "";
    return result({ model: `Shown ${show.block_id} r${revision} (${show.kind}) ${where}.${notice}`, shown: `[shown ${show.block_id} r${revision} · ${show.kind}]\n${show.fallback}`, display: [envelope], outcome: "shown" });
  }

  /** One text envelope for a block, counted. */
  function textEnvelope(id: string, text: string, status: TextDisplay["status"], history: DisplayHistory): TextDisplay {
    metrics.increment("display.fallback_shown", 1, { reason: "validation" });
    metrics.increment("display.emitted", 1, { level: "text", kind: "none", source: "model" });
    return { v: 1, block_id: id, revision: state.nextRevision(id, history), op: "snapshot", level: "text", fallback: { text }, source: { by: "model" }, status };
  }

  function refused(o: Extract<Outcome, { ok: false }>, kind: string, history: DisplayHistory): ToolResult {
    const { error } = o;
    const faults = o.errors?.length ? o.errors : [error];
    // counters count the primary code only, one per refused call
    metrics.increment("display.validation_errors", 1, { code: error.code, kind });
    const list = faultList(faults, o.omitted ?? 0);
    if (!o.block_id) {
      log.warn("display refused", { code: error.code, kind, attempt: 1, faults: faults.length + (o.omitted ?? 0), fallback_shown: false });
      return { content: `${JSON.stringify({ error: error.code, ...withoutCode(error), attempt: 1, ...faultFields(faults, o.omitted) })}\n${list}Nothing was shown.`, isError: true };
    }
    const id = o.block_id;
    const attempt = state.fail(id, o.fallback);
    if (attempt >= 2) return exhausted(id, error, kind, attempt, o.fallback, history, faults, o.omitted);
    metrics.increment("display.repair", 1, { outcome: "attempted" });
    log.warn("display refused", { code: error.code, block_id: id, kind, attempt, faults: faults.length + (o.omitted ?? 0), fallback_shown: o.fallback !== undefined });
    const body = JSON.stringify({ error: error.code, block_id: id, ...withoutCode(error), attempt, ...faultFields(faults, o.omitted) });
    const fix = faults.length > 1 ? "Fix them all" : "Fix this";
    if (!o.fallback) return { content: `${body}\n${list}Nothing was shown. ${fix} and call Show again with block_id "${id}"; it is the one repair this block gets this turn.`, isError: true };
    const envelope = textEnvelope(id, o.fallback, "repairing", history);
    return result({
      model: `${body}\n${list}The person sees your fallback meanwhile. ${fix} and call Show again with block_id "${id}"; it is the one repair this block gets this turn.`,
      shown: `[display ${id} r${envelope.revision} · repairing]\n${o.fallback}`,
      display: [envelope],
      outcome: "refused",
    });
  }

  /** The repair failed: the block ends `fallback_only` on this attempt's fallback, else the last valid one this turn,
   *  else a plain sentence, so no block is left `repairing` by a model that gave up. */
  function exhausted(id: string, cause: DisplayError, kind: string, attempt: number, fallback: string | undefined, history: DisplayHistory, faults: DisplayError[], omitted?: number): ToolResult {
    metrics.increment("display.repair", 1, { outcome: "exhausted" });
    const last = fallback ?? state.fallbackOf(id);
    const envelope = textEnvelope(id, last ?? COULD_NOT_SHOW, "fallback_only", history);
    log.warn("display refused", { code: cause.code, block_id: id, kind, attempt, fallback_shown: true, final: true });
    const sees = fallback ? "your fallback" : last ? "your last valid fallback" : `a note that ${id} could not be shown`;
    return result({
      model: `${JSON.stringify({ error: "RETRY_EXHAUSTED", block_id: id, cause, attempt, ...faultFields(faults, omitted) })}\n${faultList(faults, omitted ?? 0)}The repair failed, so the person sees ${sees}. Do not call Show for ${id} again this turn; say what it would have shown in your reply.`,
      shown: `[display ${id} r${envelope.revision} · fallback only]\n${envelope.fallback.text}`,
      display: [envelope],
      outcome: "refused",
    });
  }

  const tool = defineTool<unknown>({
    name: SHOW_TOOL,
    hands: "pure",
    description: DESCRIPTION,
    readOnly: true,
    schema: z.unknown(),
    async call(raw: unknown, ctx: ToolContext): Promise<ToolResult> {
      state.turn(ctx.runId);
      const input = lenientInput(raw);
      const id = typeof (input as { block_id?: unknown })?.block_id === "string" ? (input as { block_id: string }).block_id : undefined;
      const kind = kindLabel((input as { kind?: unknown })?.kind);
      if (id && state.failuresOf(id) >= 2) {
        metrics.increment("display.validation_errors", 1, { code: "RETRY_EXHAUSTED", kind });
        log.warn("display refused", { code: "RETRY_EXHAUSTED", block_id: id, kind, attempt: state.failuresOf(id) + 1, fallback_shown: false });
        return { content: `${JSON.stringify({ error: "RETRY_EXHAUSTED", block_id: id })}\n${id} failed twice this turn; the person sees its fallback. Do not call Show for it again this turn.`, isError: true };
      }
      // checkShowInput never throws (a validator bug is its VALIDATION_INTERNAL); the store read and the session
      // checks may, and become the same typed refusal, so the fallback is shown and the attempt counted.
      const check = checkShowInput(input, { kinds: policy.kinds });
      let history = EMPTY_HISTORY;
      let outcome: Outcome;
      try {
        history = await deps.history(ctx.toolUseId);
        outcome = check.ok ? checkSession(check.show, history, state) : check;
      } catch (e) {
        log.error("display check failed unexpectedly", { error: e instanceof Error ? e.name : typeof e, kind });
        const known = check.ok ? { block_id: check.show.block_id, fallback: check.show.fallback } : { block_id: check.block_id, fallback: check.fallback };
        outcome = { ok: false, error: asDisplayError(e), ...known };
      }
      return outcome.ok ? shown(outcome.show, outcome.provenance, history) : refused(outcome, kind, history);
    },
  });
  return { ...tool, jsonSchema: SHOW_JSON_SCHEMA, ...(SHOW_DECLARED_ARGS ? { declaredArgs: SHOW_DECLARED_ARGS } : {}) };
}

/** A metric label from the model's kind: a catalog or host kind as it is, anything else one bucket (low cardinality,
 *  and nothing the model wrote reaches a label). */
function kindLabel(kind: unknown): string {
  if (typeof kind !== "string") return "none";
  return isBlockKind(kind) || HOST_OWNED_KINDS.has(kind) ? kind : "other";
}

/** Every fault of a refusal, for the model's JSON line: listed only when there is more than one. */
function faultFields(faults: DisplayError[], omitted?: number): { faults?: DisplayError[]; more?: number } {
  return faults.length > 1 || omitted ? { faults, ...(omitted ? { more: omitted } : {}) } : {};
}

/** The faults as plain lines, so one repair can fix them all; empty for a single fault (the JSON line says it). */
function faultList(faults: DisplayError[], omitted: number): string {
  if (faults.length < 2 && !omitted) return "";
  const total = faults.length + omitted;
  const lines = faults.map((f) => `- ${f.code}${f.path ? ` at ${f.path}` : ""}: ${f.message}${f.hint ? ` (${f.hint})` : ""}`);
  return `${total} faults; fix all of them in this one repair:\n${lines.join("\n")}\n${omitted ? `(and ${omitted} more)\n` : ""}`;
}

function withoutCode(e: DisplayError): Omit<DisplayError, "code"> {
  const { code: _code, ...rest } = e;
  return rest;
}
