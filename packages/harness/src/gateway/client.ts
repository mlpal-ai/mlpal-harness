import type {
  ContentBlock,
  Message,
  StopReason,
  StreamDelta,
  Usage,
} from "@mlpal/harness-protocol";
import { type Logger, silentLogger } from "../obs/logger";
import { type Metrics, noopMetrics } from "../obs/metrics";
import { MALFORMED_INPUT_KEY, parseJsonLenient } from "../tools/json";
import { parseSSE } from "./sse";

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  /** Anthropic API version header. The gateway forwards it. */
  anthropicVersion?: string;
  maxRetries?: number;
  /** Whole-turn resume attempts across a mid-stream connection drop (laptop sleep). Default 8. */
  maxResume?: number;
  /** Per-call total timeout (connect + stream). Default 300s. */
  timeoutMs?: number;
  /** External cancellation — aborting it stops the request and stream. */
  signal?: AbortSignal;
  logger?: Logger;
  metrics?: Metrics;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolSchema[];
  toolChoice?: { type: "auto" | "any" } | { type: "tool"; name: string };
  maxTokens: number;
  temperature?: number;
  /**
   * Reasoning effort — the current Anthropic control (adaptive thinking + a discrete effort level),
   * sent as `output_config.effort`. A behavioural signal over *all* tokens (text, tool calls, and
   * thinking), not a token cap: lower effort takes fewer steps and tool calls, higher effort thinks
   * and explores more. This replaced the old `thinking.budget_tokens` knob, which the latest models
   * reject (400) — hence there is no request-side `thinking` field here. Adaptive thinking is on by
   * default; the model still emits thinking blocks in the response, which the stream parser handles.
   * Anthropic-only: it's a vendor control, so the client sends it solely for `claude-*` models and
   * leaves GPT/Gemini on their own defaults (they'd ignore it anyway).
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Per-call cancellation, combined with the client-level signal + timeout. */
  signal?: AbortSignal;
  /**
   * Ordered same-tier fallback models. If the primary `model` fails transiently *before* emitting
   * any content, the stream fails over to the next one instead of erroring — same-tier resilience
   * from the catalog. Never used once content has been emitted (that would duplicate output).
   */
  fallbackModels?: string[];
}

export interface ModelResult {
  model: string;
  message: Message; // assistant message (text + tool_use + thinking blocks)
  usage: Usage;
  stopReason: StopReason | null;
  /** Pass-through cost from the X-MLPal-Compute-Units response header (1 CU = $10, no markup).
   *  Non-streaming responses only — streaming carries no cost header by design (headers precede
   *  the body), so on yodex's streamed turns this is absent; derive from `usage` if a per-turn
   *  figure is needed. Absent ≠ 0: missing/unparseable means "unknown", never "free". */
  computeUnits?: number;
}

/** The callModel seam. GatewayClient is the production implementation; tests inject fakes. */
/** A delegation outcome reported to the gateway (POST /v1/feedback) to turn static benchmark seeds
 *  into measured, usage-driven rankings. Fire-and-forget — never on a request's hot path. */
export interface Feedback {
  model: string;
  /** One of the catalog's quality_dimensions, e.g. "coding". */
  task_type: string;
  /** accepted = output used as-is; retried = worked after a retry; escalated = wasn't good enough,
   *  redone on a stronger model (the most valuable signal); failed = hard fail. */
  outcome: "accepted" | "retried" | "escalated" | "failed";
  /** The model that succeeded instead — set only when outcome = "escalated". */
  escalated_to?: string;
  trace_id?: string;
}

export interface ModelClient {
  stream(req: ModelRequest): AsyncGenerator<StreamDelta, ModelResult, void>;
  /** Report a delegation outcome; fire-and-forget, must never throw or block the caller. */
  postFeedback?(fb: Feedback): void;
}

/** X-MLPal-Compute-Units → number, or undefined when missing/unparseable. Headers.get is
 *  case-insensitive per spec. Never coerce absence to 0 — "unknown cost" and "free" are
 *  different facts, and billing displays must be able to tell them apart. */
export function parseComputeUnits(headers: Headers): number | undefined {
  const raw = headers.get("x-mlpal-compute-units");
  if (raw === null) return undefined;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : undefined;
}

export type GatewayErrorType = "http" | "timeout" | "cancelled" | "stream" | "network";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: GatewayErrorType = "http",
    readonly errorType?: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }

  /** Transient failures worth retrying. Cancellation never is. */
  get retryable(): boolean {
    if (this.kind === "cancelled") return false;
    if (this.kind === "timeout") return true;
    if (this.kind === "network") return true;
    return (
      this.status === 408 ||
      this.status === 409 ||
      this.status === 429 ||
      this.status === 529 ||
      (this.status >= 500 && this.status < 600)
    );
  }
}

type AccBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; json: string };

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError");
}

// Connection-level failure signatures (socket reset, DNS/route loss, undici stream teardown). These
// are what a suspend/resume (laptop lid) throws when the frozen socket is torn down on wake. fetch
// wraps the OS error in a TypeError whose `cause` carries the real code, so we recurse into `cause`.
const NETWORK_RE =
  /econnreset|econnrefused|econnaborted|enetdown|enetunreach|ehostunreach|etimedout|eai_again|enotfound|epipe|fetch failed|network|socket|connection (?:closed|reset|refused|error|terminated|aborted)|terminated|other side closed|premature close|stream (?:closed|ended)/i;

function isNetworkError(e: unknown): boolean {
  if (e instanceof GatewayError) return e.kind === "network";
  if (e instanceof Error && NETWORK_RE.test(`${e.name}: ${e.message}`)) return true;
  if (e && typeof e === "object" && "cause" in e) return isNetworkError((e as { cause: unknown }).cause);
  return false;
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

/**
 * Anthropic prompt caching for the growing conversation. buildBody already caches the static
 * prefix (tools + system) behind one breakpoint; without a second, moving breakpoint the whole
 * conversation history is re-sent as fresh input every turn (~45% cache-hit measured). We mark the
 * last two messages' final block as ephemeral breakpoints — Anthropic's sliding-window pattern:
 * each turn reads the prefix cached last turn and writes the newly-extended prefix, lifting the
 * cache-hit rate toward ~90%. Non-Anthropic backends: the gateway strips these markers and relies
 * on prefix stability (which yodex already provides) so they auto-cache the same prefix. Returns
 * raw JSON (not typed Message) so cache_control can sit on any block type, not just text.
 */
export function withConversationCache(messages: Message[]): unknown[] {
  const n = messages.length;
  const mark = new Set<number>();
  if (n >= 1) mark.add(n - 1);
  if (n >= 2) mark.add(n - 2);
  return messages.map((m, i) => {
    if (!mark.has(i)) return m;
    const blocks =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content.map((b) => ({ ...b }) as Record<string, unknown>);
    if (blocks.length > 0) {
      blocks[blocks.length - 1] = {
        ...blocks[blocks.length - 1],
        cache_control: { type: "ephemeral" },
      };
    }
    return { role: m.role, content: blocks };
  });
}

export class GatewayClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly anthropicVersion: string;
  private readonly maxRetries: number;
  private readonly maxResume: number;
  private readonly timeoutMs: number;
  private readonly externalSignal?: AbortSignal;
  private readonly logger: Logger;
  private readonly metrics: Metrics;

  constructor(cfg: GatewayConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    this.anthropicVersion = cfg.anthropicVersion ?? "2023-06-01";
    this.maxRetries = cfg.maxRetries ?? 3;
    this.maxResume = cfg.maxResume ?? 8;
    this.timeoutMs = cfg.timeoutMs ?? 300_000;
    this.externalSignal = cfg.signal;
    this.logger = cfg.logger ?? silentLogger;
    this.metrics = cfg.metrics ?? noopMetrics;
  }

  /** Report a delegation outcome to the gateway (POST /v1/feedback). Fire-and-forget: it starts the
   *  request and returns immediately, and any failure (network, timeout, non-2xx) is swallowed — this
   *  is best-effort telemetry that must never affect the delegation it describes. */
  postFeedback(fb: Feedback): void {
    this.metrics.increment("gateway.feedback", 1, { outcome: fb.outcome });
    void fetch(`${this.baseUrl}/v1/feedback`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "anthropic-version": this.anthropicVersion,
      },
      body: JSON.stringify(fb),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // best-effort — a dropped feedback event is fine
    });
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamDelta, ModelResult, void> {
    const started = Date.now();
    const userSignal = anySignal(this.externalSignal, req.signal);
    this.metrics.increment("gateway.calls", 1, { model: req.model });
    // Model failover ladder: primary first, then same-tier alternates from the catalog. We advance
    // to the next model only after exhausting same-model retries, and only pre-content.
    const models = [req.model, ...(req.fallbackModels ?? []).filter((m) => m && m !== req.model)];
    // Pre-content stream retry: a stream that dies before emitting ANY delta (a transient drop
    // after a 200, an early 5xx/stream error) is safe to retry — nothing was surfaced, so a
    // retry can't duplicate output. connect() already retries the handshake; this covers the gap
    // where the connection succeeds but the SSE stream then fails immediately. Once a delta has
    // been yielded we must not retry (that would double the output) — the error is surfaced.
    // Bounded independently of connect's budget so worst-case attempts stay small.
    const maxStreamRetry = 2;
    // Whole-turn resume budget for mid-stream connectivity drops (laptop sleep, WiFi loss). The
    // suspended process freezes on the socket read and only throws on wake, so this budget is about
    // riding out reconnection flakiness after resume, not waiting out the sleep itself.
    const maxResume = this.maxResume;
    // A mid-stream *upstream* error (the gateway's provider errored after we'd already shown content)
    // is usually a transient hiccup — re-streaming the byte-identical turn (partial discarded via
    // `reset`) is as safe as a connectivity resume. Budgeted tighter than connectivity drops, though:
    // a persistent upstream error should surface after a couple of tries, not eight full re-runs.
    const maxStreamResume = 2;
    let modelIdx = 0;
    let attempt = 0;
    let resume = 0;
    let streamResume = 0;
    for (;;) {
      const model = models[modelIdx]!;
      let emitted = false;
      const idle = this.idleTimeout(userSignal);
      try {
        const res = await this.connect(this.buildBody({ ...req, model }), model, userSignal, idle);
        if (!res.body) throw new GatewayError("no response body", 502, "http");
        const computeUnits = parseComputeUnits(res.headers);
        const gen = this.consume(res.body, model, idle.reset);
        let step = await gen.next();
        while (!step.done) {
          emitted = true;
          yield step.value;
          step = await gen.next();
        }
        this.metrics.histogram("gateway.stream_ms", Date.now() - started, { model });
        return computeUnits === undefined ? step.value : { ...step.value, computeUnits };
      } catch (e) {
        const err = this.normalizeError(e, userSignal);
        // Resume across a transient connection drop *after* content was emitted (the laptop-sleep
        // signature). Re-streaming the whole turn is safe: the request is byte-identical and the
        // caller commits nothing until stream() returns, so history can't duplicate. The half-
        // rendered turn is the only casualty — `reset` tells the consumer to discard it before the
        // fresh deltas arrive. Bounded; a truly dead network still surfaces (the session is
        // separately resumable from disk). Pre-content drops fall through to retry+failover below.
        if (
          emitted &&
          err instanceof GatewayError &&
          (err.kind === "network" || err.kind === "timeout") &&
          !userSignal?.aborted &&
          resume < maxResume
        ) {
          resume++;
          this.metrics.increment("gateway.resume", 1, { model, kind: err.kind });
          this.logger.warn("connection lost mid-stream — resuming turn", {
            model,
            kind: err.kind,
            attempt: resume,
          });
          yield { type: "reset" };
          attempt = 0; // the resumed turn gets a fresh handshake-retry budget
          await sleep(backoffMs(Math.min(resume, 4)));
          continue;
        }
        // Mid-stream upstream error after content — re-stream the turn, tightly bounded (see above).
        if (
          emitted &&
          err instanceof GatewayError &&
          err.kind === "stream" &&
          !userSignal?.aborted &&
          streamResume < maxStreamResume
        ) {
          streamResume++;
          this.metrics.increment("gateway.resume", 1, { model, kind: err.kind });
          this.logger.warn("upstream stream error mid-turn — re-streaming", {
            model,
            errorType: err.errorType,
            attempt: streamResume,
          });
          yield { type: "reset" };
          attempt = 0;
          await sleep(backoffMs(streamResume));
          continue;
        }
        if (!emitted && err instanceof GatewayError && err.retryable) {
          if (attempt < maxStreamRetry) {
            attempt++;
            this.logger.warn("gateway stream retry (pre-content)", { model, attempt });
            await sleep(backoffMs(attempt));
            continue;
          }
          if (modelIdx < models.length - 1) {
            modelIdx++;
            attempt = 0;
            this.metrics.increment("gateway.failover", 1, { from: model, to: models[modelIdx]! });
            this.logger.warn("gateway model failover", { from: model, to: models[modelIdx] });
            continue;
          }
        }
        this.metrics.increment("gateway.errors", 1, {
          model,
          kind: err instanceof GatewayError ? err.kind : "unknown",
        });
        throw err;
      } finally {
        idle.clear(); // never leak the idle timer past an attempt (success, resume, or throw)
      }
    }
  }

  /** Anthropic models on the gateway are `claude-*`; GPT are `gpt-*`, Gemini `gemini-*`. Used to
   *  scope Anthropic-only request options (effort) so we never send them to other providers. */
  private static isAnthropic = (model: string): boolean => model.startsWith("claude");

  private buildBody(req: ModelRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: withConversationCache(req.messages),
      max_tokens: req.maxTokens,
      stream: true,
    };
    if (req.system !== undefined) {
      body.system = [
        { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
      ];
    }
    if (req.tools?.length) body.tools = req.tools;
    if (req.toolChoice) body.tool_choice = req.toolChoice;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // Effort is Anthropic's control (adaptive thinking depth). The gateway tolerates it for other
    // providers (verified: no error, just a no-op/soft-map), but sending a vendor-specific knob to a
    // non-Anthropic model is noise — and could break if the gateway tightens later. So only send it
    // for Anthropic models; GPT/Gemini keep their own defaults. Keeps the harness provider-agnostic.
    if (req.effort && GatewayClient.isAnthropic(req.model)) body.output_config = { effort: req.effort };
    return body;
  }

  /** Connect with retries (retryable status / timeout / network). Streaming does not retry. */
  private async connect(
    body: Record<string, unknown>,
    model: string,
    userSignal: AbortSignal | undefined,
    idle: { signal: AbortSignal; reset: () => void },
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      if (userSignal?.aborted) {
        throw new GatewayError("request cancelled", 0, "cancelled");
      }
      try {
        idle.reset(); // each handshake attempt gets a fresh idle window
        const res = await this.fetchOnce(body, idle.signal);
        if (res.ok) return res;
        const err = await this.toError(res);
        if (!err.retryable || attempt >= this.maxRetries) throw err;
        attempt++;
        const delay = this.retryDelay(res, attempt);
        this.logger.warn("gateway retry", { model, status: res.status, attempt, delay });
        await sleep(delay);
      } catch (e) {
        if (e instanceof GatewayError && !e.retryable) throw e;
        if (isAbort(e)) {
          if (userSignal?.aborted) {
            throw new GatewayError("request cancelled", 0, "cancelled");
          }
          if (attempt >= this.maxRetries) {
            throw new GatewayError(`request timed out after ${this.timeoutMs}ms`, 408, "timeout");
          }
          attempt++;
          this.logger.warn("gateway timeout retry", { model, attempt });
          await sleep(backoffMs(attempt));
          continue;
        }
        if (e instanceof GatewayError) {
          // retryable http error already handled above; this is the throw path
          if (attempt >= this.maxRetries) throw e;
          attempt++;
          await sleep(backoffMs(attempt));
          continue;
        }
        // network-level error
        if (attempt >= this.maxRetries) throw e;
        attempt++;
        this.logger.warn("gateway network retry", { model, attempt, error: String(e) });
        await sleep(backoffMs(attempt));
      }
    }
  }

  /**
   * An IDLE timeout, not a total-time one. `timeoutMs` of *silence* aborts; every received
   * SSE event resets the clock via `reset()`. A total-time budget (the old
   * `AbortSignal.timeout`) killed legitimately long turns mid-stream, and because a timeout
   * is a resumable error, the loop re-streamed the byte-identical turn straight into the same
   * wall — up to `maxResume` full re-bills and a structurally uncompletable turn. Idle-based:
   * an actively-streaming turn never times out; a genuinely stalled connection still aborts
   * and resumes correctly.
   */
  private idleTimeout(userSignal: AbortSignal | undefined): {
    signal: AbortSignal;
    reset: () => void;
    clear: () => void;
  } {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer = setTimeout(() => ctrl.abort(new DOMException("idle timeout", "TimeoutError")), this.timeoutMs);
      timer.unref?.();
    };
    arm();
    const combined = userSignal ? anySignal(userSignal, ctrl.signal)! : ctrl.signal;
    return {
      signal: combined,
      reset: () => {
        if (timer) clearTimeout(timer);
        arm();
      },
      clear: () => {
        if (timer) clearTimeout(timer);
      },
    };
  }

  private fetchOnce(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "anthropic-version": this.anthropicVersion,
      },
      body: JSON.stringify(body),
      signal,
    });
  }

  private retryDelay(res: Response, attempt: number): number {
    const ra = res.headers.get("retry-after");
    if (ra) {
      const secs = Number(ra);
      if (!Number.isNaN(secs)) return Math.min(secs * 1000, 30_000);
    }
    return backoffMs(attempt);
  }

  private async toError(res: Response): Promise<GatewayError> {
    let detail = res.statusText;
    let type: string | undefined;
    try {
      const j = (await res.json()) as { error?: { type?: string; message?: string } };
      if (j.error?.message) detail = j.error.message;
      type = j.error?.type;
    } catch {
      // non-JSON body
    }
    return new GatewayError(`gateway ${res.status}: ${detail}`, res.status, "http", type);
  }

  private normalizeError(e: unknown, userSignal: AbortSignal | undefined): Error {
    if (e instanceof GatewayError) return e;
    // If the user's signal aborted (Ctrl-C), ANY resulting error is a cancellation — don't
    // depend on the error being a DOMException AbortError (its shape varies across runtimes),
    // else an interrupt gets mis-reported as a generic failure, skipping the clean affordance.
    if (userSignal?.aborted) return new GatewayError("request cancelled", 0, "cancelled");
    if (isAbort(e)) return new GatewayError("request timed out", 408, "timeout");
    // A connection drop mid-stream (suspend/resume, WiFi loss) surfaces as a raw TypeError, not a
    // GatewayError. Tag it so stream() can resume the turn instead of surfacing a hard failure.
    if (isNetworkError(e)) return new GatewayError("connection lost", 0, "network");
    return e instanceof Error ? e : new Error(String(e));
  }

  private async *consume(
    stream: ReadableStream<Uint8Array>,
    fallbackModel: string,
    onEvent?: () => void,
  ): AsyncGenerator<StreamDelta, ModelResult, void> {
    const blocks = new Map<number, AccBlock>();
    let model = fallbackModel;
    let usage: Usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: StopReason | null = null;
    let sawStop = false;

    for await (const ev of parseSSE(stream)) {
      onEvent?.(); // reset the idle-timeout clock: this stream is alive
      const type = ev.type as string;
      if (type === "message_stop") sawStop = true;
      switch (type) {
        case "message_start": {
          const msg = (ev.message ?? {}) as { model?: string; usage?: Partial<Usage> };
          if (msg.model) model = msg.model;
          if (msg.usage) usage = { ...usage, ...normalizeUsage(msg.usage) };
          break;
        }
        case "content_block_start": {
          const index = ev.index as number;
          const cb = ev.content_block as Record<string, unknown>;
          blocks.set(index, startBlock(cb));
          if (cb.type === "tool_use") {
            yield { type: "tool_use_start", id: cb.id as string, name: cb.name as string };
          }
          break;
        }
        case "content_block_delta": {
          const index = ev.index as number;
          const block = blocks.get(index);
          const delta = ev.delta as Record<string, unknown>;
          if (!block) break;
          if (delta.type === "text_delta" && block.type === "text") {
            block.text += delta.text as string;
            yield { type: "text_delta", text: delta.text as string };
          } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
            block.json += (delta.partial_json as string) ?? "";
          } else if (delta.type === "thinking_delta" && block.type === "thinking") {
            block.thinking += delta.thinking as string;
            yield { type: "thinking_delta", text: delta.thinking as string };
          } else if (delta.type === "signature_delta" && block.type === "thinking") {
            block.signature = (block.signature ?? "") + (delta.signature as string);
          }
          break;
        }
        case "message_delta": {
          const delta = (ev.delta ?? {}) as { stop_reason?: StopReason | null };
          const u = (ev.usage ?? {}) as Partial<Usage>;
          if (delta.stop_reason) stopReason = delta.stop_reason;
          // Merge every usage field present, not just output_tokens: some providers only
          // learn input/cache counts at end-of-stream (OpenAI), so the gateway delivers
          // them here rather than in message_start. Last write wins; absent fields keep
          // whatever message_start reported.
          if (typeof u.input_tokens === "number" && u.input_tokens > 0) usage.input_tokens = u.input_tokens;
          if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
          if (typeof u.cache_creation_input_tokens === "number") usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
          if (typeof u.cache_read_input_tokens === "number") usage.cache_read_input_tokens = u.cache_read_input_tokens;
          break;
        }
        case "error": {
          const e = (ev.error ?? {}) as { type?: string; message?: string };
          throw new GatewayError(e.message ?? "stream error", 502, "stream", e.type);
        }
        default:
          break;
      }
    }

    // A stream that ends without message_stop/message_delta was truncated by a mid-message
    // connection close (LB idle-close, proxy restart) — no error event, no thrown read error,
    // just a clean FIN. Returning the partial as a finished turn presents truncated text as
    // the final answer and turns a half-streamed tool_use into a malformed-JSON retry. Treat
    // it as a resumable stream error so the loop re-streams instead.
    if (!sawStop && stopReason === null) {
      throw new GatewayError("stream closed before completion", 0, "network");
    }

    return {
      model,
      message: { role: "assistant", content: assembleBlocks(blocks) },
      usage,
      stopReason,
    };
  }
}

function startBlock(cb: Record<string, unknown>): AccBlock {
  switch (cb.type) {
    case "text":
      return { type: "text", text: (cb.text as string) ?? "" };
    case "thinking":
      return {
        type: "thinking",
        thinking: (cb.thinking as string) ?? "",
        signature: cb.signature as string | undefined,
      };
    case "tool_use":
      return { type: "tool_use", id: cb.id as string, name: cb.name as string, json: "" };
    default:
      return { type: "text", text: "" };
  }
}

function assembleBlocks(blocks: Map<number, AccBlock>): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const index of [...blocks.keys()].sort((a, b) => a - b)) {
    const b = blocks.get(index)!;
    if (b.type === "text") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "thinking") {
      out.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
    } else {
      out.push({ type: "tool_use", id: b.id, name: b.name, input: parseJsonInput(b.json) });
    }
  }
  return out;
}

export function parseJsonInput(json: string): Record<string, unknown> {
  const trimmed = json.trim();
  if (!trimmed) return {};
  // Lenient, not strict: streamed tool-call JSON from models carries the usual malformations
  // (truncation aside — bad escapes, smart quotes, trailing commas). Repair what's repairable.
  const parsed = parseJsonLenient(trimmed);
  if (parsed.ok && parsed.value !== null && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
    return parsed.value as Record<string, unknown>;
  }
  // Unrecoverable: do NOT degrade to {} — that turns a malformed call into a "successful" call
  // with empty input and a baffling "field required" error downstream. Plant the marker; the
  // registry converts it into a precise, self-correctable error for the model.
  return { [MALFORMED_INPUT_KEY]: trimmed.slice(0, 600) };
}

function normalizeUsage(u: Partial<Usage>): Usage {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
  };
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
