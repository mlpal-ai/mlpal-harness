/**
 * The stamp: what a record belongs to. Every record the harness writes about its own work, and
 * every call it makes to a service, carries it, so the gateway's usage row, the memory write,
 * the sandbox exec and the harness's own log line about one turn can be joined without guessing.
 *
 * A SESSION is the conversation, which can live for weeks. A RUN is one turn: a prompt in, a
 * result out; it is the unit of telemetry and the unit of a trace. A PROMPT is the person's
 * prompt that started the turn (a steer or a peer message inside a turn keeps the turn's
 * prompt). PARENT_RUN is set on a subagent and names the turn that spawned it. The host supplies
 * hop, origin and workspace once; the loop supplies session, run and prompt per turn.
 */
export interface StampConfig {
  /** `name@version` of the HOP running. */
  hop?: string;
  /** local | managed | routine | workflow | peer … */
  origin?: string;
  workspace?: string;
}

export interface RunStamp extends StampConfig {
  session: string;
  run: string;
  prompt?: string;
  parent_run?: string;
}

/** The record fields, in a fixed order, with absent optionals left out. */
export function stampFields(s: RunStamp): Record<string, string> {
  const out: Record<string, string> = { session: s.session, run: s.run };
  if (s.prompt) out.prompt = s.prompt;
  if (s.parent_run) out.parent_run = s.parent_run;
  if (s.hop) out.hop = s.hop;
  if (s.origin) out.origin = s.origin;
  if (s.workspace) out.workspace = s.workspace;
  return out;
}

/** The W3C headers for an outbound call: `traceparent` names the run's trace and the calling
 *  span, `baggage` carries the stamp so a service can record it. Trace and span ids are derived
 *  from the run and the call so they are stable across retries of the same call. */
export function traceHeaders(s: RunStamp, callId: string, hash: (text: string) => string): Record<string, string> {
  const traceId = hash(`trace:${s.run}`).slice(0, 32);
  const spanId = hash(`span:${s.run}:${callId}`).slice(0, 16);
  const baggage = Object.entries(stampFields(s))
    .map(([k, v]) => `mlpal.${k}=${encodeURIComponent(v)}`)
    .join(",");
  return { traceparent: `00-${traceId}-${spanId}-01`, baggage };
}
