import type { Author } from "./author.js";
import type { ContentBlock } from "./content.js";
import type { PeerMessage } from "./control.js";
import type { AskOutcome, AskQuestion } from "./questions.js";
import type { EngineEvent, SDKMessage } from "./sdk.js";
import type { Usage } from "./usage.js";

/**
 * The wire protocol between a yodex frontend (web, VS Code, the workspace UI, a remote CLI) and
 * a running engine over a transport (WebSocket). Every frontend speaks this; the engine streams
 * EngineEvents and round-trips permission, question and approval decisions. See docs/05 §8.
 *
 * yodex/2 is additive over yodex/1: every yodex/1 message keeps its shape, new fields are
 * optional, and `ready.capabilities` says which of the additions a server actually serves, so a
 * frontend gates on capabilities, never on the version string.
 */

export interface SessionSummary {
  sessionId: string;
  agentId: string;
  status: string;
  model: string;
  updatedAt: string;
  /** First user message, trimmed — the human-readable title for a session picker. */
  title: string;
  /** yodex/2 (capability "sessions_v2"): the person's /rename'd name. */
  name?: string;
  /** yodex/2: the HOP the session runs under (`name@version`). */
  hop?: string;
  /** yodex/2: absolute working directory, and the same relative to the server's workspace root
   *  ("." at the root). */
  cwd?: string;
  relCwd?: string;
  /** yodex/2: first segment of relCwd, or the workspace name at the root — for grouping. */
  projectName?: string;
  /** yodex/2: the last assistant reply, trimmed. */
  lastMessagePreview?: string;
  /** yodex/2: a question is parked for this session (`yodex questions` or the UI can answer). */
  pendingQuestion?: boolean;
  /** yodex/2: a run is streaming on this session right now. */
  live?: boolean;
  /** yodex/2 (capability "subagents"): this session is a sub-agent spawned by `sessionId`'s
   *  `Agent` call `toolUseId`. Listed only when `list_sessions.includeChildren` is set.
   *  0.20.3: a verifier session (the HOP's completion gate, not a tool call) names the session
   *  it verified, with `toolUseId` `verifier:<runId>` (that session's run it gated). */
  parent?: { sessionId: string; toolUseId: string };
  /** 0.20.0: when the session was created (ISO 8601). */
  createdAt?: string;
}

/** What a server can do beyond yodex/1. Absent from `ready` on a yodex/1 server. */
export type ServerCapability =
  | "questions" // question_request / question_response round-trips, parked questions on load_session
  | "approval" // done.pendingApproval + approval_response resumes a run parked at the safety edge
  | "attachments" // run.blocks (image/document content blocks) alongside the prompt
  | "sessions_v2" // the optional SessionSummary fields; list_sessions covers the whole workspace
  | "hop_per_run" // run.hop may name a HOP other than the server's own
  | "commands" // list_commands
  | "files" // list_files
  | "subagents" // `subagent` events, child frames tagged `childSessionId`, stop_subagent, list_sessions.includeChildren
  | "mail" // `mail` frames for an idle session's peer messages; `send` answers with send_result
  | "checkpoints" // `checkpoints` listing and `rewind` to before a message (files + conversation)
  | "usage" // `compute_units` on usage, `session_usage` totals per session and model
  | "effort" // run.effort, set_session_defaults / session_defaults
  | "describe_hop" // describe_hop → hop: the serialisable view of a HOP
  | "daemon" // the pod daemon's UI routes are reachable at `daemon/` beside the page, behind the same cookie
  | "terminal" // a shell is reachable as a WebSocket at `terminal/ws` beside the page (ttyd's protocol, subprotocol `tty`)
  | "workspace_stats"; // workspace_stats: the workspace's usage, runs, tools and outcomes aggregated by the engine (0.20.0)

/** The gateway's reasoning-effort ladder; a rung a model lacks is clamped and reported on the
 *  assistant event's `effort.applied`. */
export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** What a client may set once per session instead of on every run (capability "effort"). */
export interface SessionDefaults {
  model?: string;
  effort?: EffortLevel;
  mode?: string;
}

/**
 * The serialisable view of a composed HOP (capability "describe_hop"): the profile minus what
 * cannot cross a wire (nudge functions, regexes shown as source). Policy blocks are the HOP's
 * own data, as hop.yaml declares them; see the harness `Profile` type for their shapes.
 */
export interface HopView {
  name: string;
  version: string;
  description: string;
  source: "builtin" | "user" | "project" | "path";
  dir: string | null;
  /** Parent chain, root first. */
  extendsChain: string[];
  prompts: { system: string; verifierAgent: string };
  loop: { taskType: string; verifyCommand: string | null; envBroken: string | null; churnThreshold: number; summarizerSystem: string; condenserSystem: string; checkpointNudge: boolean };
  verification: Record<string, unknown>;
  catalog: { profile: string };
  routing: Record<string, unknown>;
  permissions: { defaultMode: string; allow: string[]; deny: string[] };
  tools: { include: string[] };
  budgets: { maxTurns: number };
  telemetry: { taskType: string };
  evals: Array<Record<string, unknown>>;
  tuning?: Record<string, unknown>;
  model?: Record<string, unknown>;
  requires?: Record<string, unknown>;
  safety?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  /** Setting paths a user or the tuner may not touch. */
  locked: string[];
  /** The declared optimization surface. */
  tunable: Array<{ path: string; range: [number, number] | string[] }>;
  modules: Record<string, { prompt: string; tools?: string[]; enabled: boolean; description?: string }>;
  warnings?: string[];
}

/** One HOP a serve can run (capability "hop_per_run"). `current` is the serve's own, in-process;
 *  `warm` means a host for it is already up, so a run on it starts without the spawn delay. */
export interface HopInfo {
  name: string;
  version: string;
  description?: string;
  /** builtin, or the directory it was installed in (project/user). */
  source: "builtin" | "project" | "user";
  current: boolean;
  warm: boolean;
}

/** The engine that answers on this socket (0.20.0, on `ready`). `harnessProtocol` is this
 *  package's version the engine was built with; gate features on capabilities, not on it. */
export interface EngineInfo {
  name: string;
  version: string;
  /** The engine's build commit, when the build recorded one. */
  sha?: string;
  harnessProtocol: string;
}

/** The window a workspace_stats request covers, in the client's time zone: `24h` is the current
 *  local hour and the 23 before it; `7d`/`30d` are today and the 6/29 local days before it;
 *  `all` is everything recorded. */
export type StatsRange = "24h" | "7d" | "30d" | "all";

/** Token counts for a bucket: input excludes cache reads and writes, as on `Usage`. */
export type StatsUsage = Required<Omit<Usage, "compute_units">>;

export interface StatsModelSlice {
  /** Input (incl. cache reads and writes) plus output tokens. */
  tokens: number;
  cu: number;
}

export interface StatsDay {
  /** The local date in the request's `tz`, `YYYY-MM-DD`. */
  day: string;
  usage: StatsUsage;
  computeUnits: number;
  /** Top-level sessions with any record that day; sub-agent sessions are `subagents`. */
  sessions: number;
  subagents: number;
  /** Runs that started that day. */
  runs: number;
  calls: number;
  /** 0.20.1: keyed by the models in `modelSlots`; every other model is summed under `(other)`. */
  byModel: Record<string, StatsModelSlice>;
}

export interface StatsHour extends Omit<StatsDay, "day"> {
  /** The hour's first instant, ISO 8601 UTC; it is a whole local hour in the request's `tz`. */
  hour: string;
}

export interface StatsRollup {
  /** Sessions with any record in the window. */
  sessions: number;
  /** Runs that started in the window. */
  runs: number;
  computeUnits: number;
  /** The newest record in the window, ISO 8601. */
  lastAt: string | null;
}

export interface StatsTopSession {
  sessionId: string;
  /** First user message, trimmed (as SessionSummary.title). */
  title: string;
  name?: string;
  hop?: string;
  model: string;
  status: string;
  /** Present on a sub-agent session, as on SessionSummary.parent: an `Agent` child, or (0.20.3)
   *  a verifier session with `toolUseId` `verifier:<runId>`. Roll a child up by `sessionId`. */
  parent?: { sessionId: string; toolUseId: string };
  computeUnits: number;
  /** Input (incl. cache) plus output tokens in the window. */
  tokens: number;
  runs: number;
  updatedAt: string;
}

/** workspace_stats's answer (capability "workspace_stats"). Every figure comes from records the
 *  engine stamped with a run (telemetry v1); `coverage` says how many sessions had none. All
 *  totals, per-* rollups and `days`/`hours` cover the window; `history`, `modelSlots` and
 *  `streak` do not (see each). Cost: `usd = computeUnits * USD_PER_CU` at the protocol's fixed
 *  rate; the gateway's rate is configurable, so cross-check compute units, not dollars. */
export interface WorkspaceStats {
  generatedAt: string;
  range: StatsRange;
  tz: string;
  /** The window's first and last instant, ISO 8601 (`since` is null for `all`). */
  window: { since: string | null; until: string };
  scope: { hop?: string; project?: string };
  /** `sessions`: in-scope sessions updated in the window or with records in it; `counted`: those
   *  with stamped records in the window; `unstamped`: those with model calls but no stamped
   *  record anywhere (an older engine); `partial` (0.20.1): counted sessions that also have
   *  unstamped calls, which the totals leave out (the figures may undercount them). */
  coverage: { sessions: number; counted: number; unstamped: number; partial?: number };
  totals: {
    usage: StatsUsage;
    computeUnits: number;
    usd: number;
    /** Top-level sessions with any record in the window. */
    sessions: number;
    subagents: number;
    /** Runs that started in the window. */
    runs: number;
    calls: number;
    /** Every tool request, refused ones included. */
    toolRuns: number;
    /** Tool runs that ran and failed. */
    toolErrors: number;
    /** Tool requests refused (policy, a person, a hook). */
    denied: number;
    compactions: number;
    checkpoints: number;
    parked: number;
    /** cache reads / (input + cache reads + cache writes); 0 without prompt tokens. */
    cacheHitRatio: number;
    code: { added: number; removed: number };
  };
  /** One row per local day of the window, oldest first, zero days included (`all`: from the
   *  first active day). */
  days: StatsDay[];
  /** `range: "24h"` only: 24 local hours, oldest first. */
  hours?: StatsHour[];
  /** The last 182 local days ending today, oldest first, whatever the range (the heatmap). */
  history: Array<{ day: string; usage: StatsUsage; computeUnits: number }>;
  /** Per model. `share` is of all tokens in the window.
   *  - `ms`: the sum of each call's wall time, the time a run waited from issuing the call to its
   *    result, with every gateway retry, failover and host suspension included ("Model time").
   *    Calls without a recorded time add nothing. Never divide it by `calls`.
   *  - `avgCallMs` (0.20.2): the mean of those wall times when every call in the window was one
   *    request with a recorded time, i.e. the average latency. Absent otherwise: a call that
   *    retried, failed over, or came from an engine that does not count requests.
   *  - `untimedCalls` and `retriedCalls` (0.20.4): the calls that keep `avgCallMs` away, by why.
   *    `retriedCalls` took more than one gateway request (a retry or a failover); `untimedCalls`
   *    have no usable time or no request count (written by an engine from before per-call
   *    timing). `avgCallMs` is present exactly when both are 0. Absent from an older serve. */
  perModel: Record<string, { calls: number; usage: StatsUsage; computeUnits: number; ms: number; avgCallMs?: number; untimedCalls?: number; retriedCalls?: number; share: number }>;
  /** The workspace's top three models by tokens, all time and unscoped: stable colour slots. */
  modelSlots: string[];
  /** By the run's HOP label (`name@version`; `(none)` when a run had none). */
  perHop: Record<string, StatsRollup>;
  /** By project: relCwd's first segment, or the workspace name at the root. */
  perProject: Record<string, StatsRollup>;
  /** `runs` counts requests. `ms` sums the wall time of the ones that ran, each from the
   *  permission decision to the result with PostToolUse hooks included; a refused one has no
   *  duration, so an average divides by `runs - denied`. */
  perTool: Record<string, { runs: number; errors: number; denied: number; ms: number }>;
  /** Runs that started in the window, by how they ended. `totals.runs` minus these five is "No
   *  result recorded": a run still going, one that crashed before its end, or an end with another
   *  subtype. */
  outcomes: { success: number; error: number; max_turns: number; cancelled: number; needs_approval: number };
  /** Consecutive local days with a model call, all time in scope: `current` ends today, or
   *  yesterday when today has none yet. */
  streak: { current: number; longest: number };
  /** Sessions with records in the window by compute units, then tokens (a page of them). */
  topSessions: StatsTopSession[];
  /** How many sessions the ranking holds, for paging `topSessions`. */
  sessionsTotal: number;
}

export interface PendingApproval {
  command: string;
  reason: string;
}

export type ClientMessage =
  | {
      type: "run";
      requestId: string;
      sessionId?: string;
      prompt: string;
      model?: string;
      mode?: string;
      /** yodex/2: attachments sent with the prompt (capability "attachments"). */
      blocks?: ContentBlock[];
      /** yodex/2: the HOP for this run, bare (`coding`: the newest installed version) or as
       *  `name@version` (`ready.hop`, `SessionSummary.hop`); both reach the same serve. Without
       *  "hop_per_run" it must be the server's own, or the server answers with an error naming
       *  its HOP. */
      hop?: string;
      /** yodex/2: working directory for this run, under the server's workspace root. */
      cwd?: string;
      /** yodex/2 (capability "effort"): reasoning effort for this run; else the session's
       *  default, else the server's. */
      effort?: EffortLevel;
    }
  /** Steer a session. yodex/2 (capability "mail"): `requestId` is echoed on the send_result. */
  | { type: "send"; requestId?: string; sessionId: string; text: string }
  /** Abort the run(s) on this connection; with `sessionId` (yodex/2) only that session's. */
  | { type: "interrupt"; sessionId?: string }
  /** yodex/2: sub-agent sessions are hidden unless `includeChildren` (capability "subagents").
   *  0.20.0: newest first by `updatedAt` (ties by id); `limit` (1–500, default 200) rows after
   *  `before`, the last row of the previous page; `sessions.hasMore` says whether more exist.
   *  `before` as that row's `{updatedAt, sessionId}` (0.20.1) seeks by position and survives the
   *  row being updated in between; as a bare id it is looked up, so an updated row restarts the
   *  order (refetch from the top on a repeat). */
  | { type: "list_sessions"; requestId?: string; includeChildren?: boolean; before?: string | { updatedAt: string; sessionId: string }; limit?: number }
  | { type: "list_models"; requestId?: string }
  | { type: "list_skills"; requestId?: string }
  /** yodex/2: `limit` returns the newest `limit` entries (before `before`, an entry uuid, when
   *  given); `session_history.hasMore` says whether older entries exist. */
  | { type: "load_session"; requestId?: string; sessionId: string; before?: string; limit?: number }
  | { type: "permission_response"; id: string; decision: "allow" | "deny"; reason?: string }
  /** yodex/2: the answer to a question_request, or to a parked question named by load_session. */
  | { type: "question_response"; id: string; outcome: AskOutcome }
  /** yodex/2: resume a session whose last run ended `needs_approval`, with the decision. */
  | { type: "approval_response"; sessionId: string; decision: "allow" | "deny"; reason?: string }
  /** yodex/2 (capability "subagents"): stop one running sub-agent; its `subagent end` event
   *  reports `cancelled`. The parent run continues. */
  | { type: "stop_subagent"; childSessionId: string }
  /** yodex/2 (capability "checkpoints"): the session's turns a rewind can go back to. */
  | { type: "checkpoints"; requestId?: string; sessionId: string }
  /** yodex/2 (capability "checkpoints"): restore files to before the human turn `beforeUuid`
   *  (a `user` event's uuid from the stream or session_history) and drop it and everything
   *  after from the conversation; the store keeps the history. Refused while a run is live. */
  | { type: "rewind"; requestId?: string; sessionId: string; beforeUuid: string }
  /** yodex/2 (capability "hop_per_run"): the HOPs this serve can run, for a HOP picker. */
  | { type: "list_hops"; requestId?: string }
  /** yodex/2 (capability "usage"): a session's spend so far, from the per-call ledger. */
  | { type: "session_usage"; requestId?: string; sessionId: string }
  /** yodex/2 (capability "effort"): defaults for later runs of the session; a field given as
   *  null clears it. Answered with session_defaults; a mode the HOP forbids is an error. */
  | { type: "set_session_defaults"; requestId?: string; sessionId: string; model?: string | null; effort?: EffortLevel | null; mode?: string | null }
  /** yodex/2 (capability "describe_hop"): the view of a HOP, the server's own when unnamed;
   *  `hop` bare or as `name@version` (a version that is not installed is an error). */
  | { type: "describe_hop"; requestId?: string; hop?: string }
  /** 0.20.0 (capability "workspace_stats"): the aggregate over the server's workspace, days
   *  bucketed in `tz` (an IANA zone). `hop` (a name or `name@version`) or `project` narrows the
   *  scope; `sessions` pages `topSessions` (offset ≥ 0, limit 1–50, default 0/20). */
  | { type: "workspace_stats"; requestId?: string; range: StatsRange; tz: string; hop?: string; project?: string; sessions?: { offset: number; limit: number } }
  /** yodex/2: receive a session's idle events (a background child's end, a rewind) on this
   *  connection without loading its history. A run or load_session watches implicitly. */
  | { type: "watch"; sessionId: string }
  /** Internal to a front serve and its per-HOP children: a peer message for an idle session,
   *  delivered by the process that owns the session's inbox. Not for clients. */
  | { type: "deliver_mail"; sessionId: string; message: PeerMessage };

export type ServerMessage =
  | { type: "ready"; protocol: string; capabilities?: ServerCapability[]; hop?: string; cwd?: string; /** 0.20.0 */ engine?: EngineInfo }
  /** `childSessionId` (capability "subagents"): `event` belongs to that sub-agent of `sessionId`
   *  and rides the parent's connection while the child runs. */
  | { type: "event"; sessionId: string; childSessionId?: string; event: EngineEvent }
  | {
      type: "permission_request";
      id: string;
      sessionId: string;
      toolName: string;
      input: Record<string, unknown>;
      /** yodex/2: why the policy asked (a mode rule, or a HOP safety reason code). */
      reason?: string;
      safetyReason?: string;
    }
  /** yodex/2: the engine asks the person structured questions mid-run. */
  | { type: "question_request"; id: string; sessionId: string; questions: AskQuestion[] }
  /** 0.20.0: `hasMore` when rows exist past this page. */
  | { type: "sessions"; requestId?: string; sessions: SessionSummary[]; hasMore?: boolean }
  | {
      type: "session_history";
      requestId?: string;
      sessionId: string;
      messages: SDKMessage[];
      /** yodex/2: a question parked for this session, answerable with question_response. */
      pendingQuestion?: { id: string; questions: AskQuestion[] };
      /** yodex/2: the last run ended at the safety edge; approval_response resumes it. */
      pendingApproval?: PendingApproval;
      /** yodex/2: a run is streaming on this session on another connection. */
      live?: boolean;
      /** yodex/2: older entries exist before the first one returned (paged load). */
      hasMore?: boolean;
    }
  | { type: "models"; requestId?: string; models: Array<{ tag: string; displayName: string }> }
  /** yodex/2 (capability "mail"): how a `send` was delivered. `sent` = a run is live on the
   *  session and folds the text in at its next boundary; `queued` = the session is idle and the
   *  text waits in its event inbox for the next run. */
  | { type: "send_result"; requestId?: string; sessionId: string; status: "sent" | "queued" }
  /** yodex/2 (capability "checkpoints"): one row per human turn that opened a checkpoint.
   *  `userUuid` is the turn's `user` event, what `rewind.beforeUuid` names; `files` counts the
   *  pre-images kept for Write/Edit in that turn (shell edits are not tracked). */
  | { type: "checkpoints"; requestId?: string; sessionId: string; turns: Array<{ turn: number; ts: string; prompt: string; userUuid: string | null; files: number }> }
  /** yodex/2 (capability "checkpoints"): a rewind happened. Watchers of the session also get
   *  the persisted `rewind` event frame; the conversation now ends at `toUuid`. */
  | { type: "rewound"; requestId?: string; sessionId: string; turn: number; toUuid: string | null; restored: string[]; deleted: string[]; failed: Array<{ path: string; error: string }> }
  /** yodex/2 (capability "hop_per_run"): the HOPs this serve can run. */
  | { type: "hops"; requestId?: string; hops: HopInfo[] }
  /** yodex/2 (capability "effort"): the session's defaults after a set_session_defaults. */
  | { type: "session_defaults"; requestId?: string; sessionId: string; defaults: SessionDefaults }
  /** yodex/2 (capability "describe_hop"). */
  | { type: "hop"; requestId?: string; hop: HopView }
  /** yodex/2 (capability "usage"): totals over every model call of the session. `usd` is
   *  `compute_units * USD_PER_CU`, present when the gateway metered any call. */
  | {
      type: "session_usage";
      requestId?: string;
      sessionId: string;
      calls: number;
      usage: Usage;
      usd?: number;
      /** 0.20.0: per model, `ms` sums call durations and `computeUnits` the gateway's meter. */
      models: Record<string, { calls: number; usage: Usage; ms?: number; computeUnits?: number }>;
      /** 0.20.0: summed model-call time, and the session's created-to-updated span. */
      apiMs?: number;
      wallMs?: number;
      /** 0.20.0: tool requests by name. */
      tools?: Record<string, number>;
      /** 0.20.0: lines added and removed by edits, and the edit count. */
      code?: { added: number; removed: number; edits: number };
      /** 0.20.0: cache reads / prompt tokens over the session. */
      cache?: { hitRatio: number };
    }
  /** yodex/2 (capability "mail"): a peer message that reached an idle session the client is
   *  watching. The model sees it at the session's next run; a run in progress sees its mail
   *  itself, as a `user` event authored by the peer. */
  | { type: "mail"; sessionId: string; from: Author; text: string; correlationId?: string; ts: string }
  | { type: "skills"; requestId?: string; skills: Array<{ name: string; description: string }> }
  | {
      type: "done";
      requestId: string;
      sessionId: string;
      subtype: string;
      /** yodex/2: the run's usage, and the parked action when subtype is needs_approval. */
      usage?: Usage;
      pendingApproval?: PendingApproval;
    }
  /** 0.20.0 (capability "workspace_stats"). */
  | ({ type: "workspace_stats"; requestId?: string } & WorkspaceStats)
  | { type: "error"; message: string; requestId?: string };

export const PROTOCOL_VERSION = "yodex/2";

/**
 * 0.20.3: the close a serve sends on a WebSocket (`/ws`, and `terminal/ws` with the capability
 * "terminal") whose upgrade carried a credential that is not this serve's token: the
 * `yodex_token` cookie, `?token=` or a Bearer header, wrong or missing. A rebind mints a new
 * token, so a page opened before it is refused this way. The same credential can never succeed:
 * the client stops retrying and asks the person to reopen the workspace link. Every other close
 * is the transport's (1006 a dropped connection, 1001 a serve going away) and may be retried;
 * the terminal's own codes are 1000 / 4001 a shell that exited zero / non-zero, 4002 the
 * terminal unavailable, 4003 too many terminals, 1009 an input frame over 64 KiB.
 * A request from another origin is refused over HTTP before any socket exists.
 */
export const CLOSE_CREDENTIAL_REFUSED = { code: 4401, reason: "credential refused" } as const;

/** This package's version, sent as `ready.engine.harnessProtocol`. Kept equal to package.json
 *  (a test checks). */
export const HARNESS_PROTOCOL_VERSION = "0.20.4";
