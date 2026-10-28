/**
 * An in-memory P5 memory store on Bun.serve for the engine's memory rung, kept to contracts/P5-memory-store.md 1.3
 * and pinned on W5's fixture (test/fixtures/memory-store, memory-graph e9b18ab) by memory-store.contract.test.ts:
 * the engine routes under `/api/v1` (checkpoint, search, projection, promote), FastAPI's `{"detail": {"code",
 * "message", …}}` envelope, engine tokens scoped to one `{sid, run_id, store, shared, promotion, limits}`, staging
 * per run (`<publication>/<customer>/run/<run_id>` under scope `hop`) overlaid on the promoted store for that run's
 * reads, `expected_version` on keyed kinds only and against the promoted store, versions counting distinct values,
 * note sections refused, promotion `auto` (one store version, conflicts left staged and reported) or `review` (a
 * proposal), idempotent per run_id, `max_write_bytes` / `max_nodes` / `max_bytes`, store ids in the promote path with
 * their slash or percent-encoded, and fault injection. §f (rollback, redact, export, delete) is the control token's
 * and not here.
 */
import { CryptoHasher } from "bun";

export type FakeMemoryRoute = "checkpoint" | "search" | "projection" | "promote";

export interface FakeEngineClaims {
  sid: string;
  runId: string;
  /** The grant's spelling, `hop:<publication>/<customer>`. */
  store: string;
  shared?: Array<{ scope_id: string; access: "read" | "read_write" }>;
  promotion: "auto" | "review";
  limits?: { max_nodes?: number; max_bytes?: number; max_write_bytes?: number };
  customer?: string;
  hopVersion?: string;
}

export interface FakeNode {
  /** The claim's anchor key. */
  key: string;
  kind: string;
  topic: string;
  value: string;
  /** Memory's own spelling: the store's `scope_id` without the `hop:` prefix (staging: `…/run/<run_id>`). */
  scope_id: string;
  /** Promoted: the number of distinct values the key has held. Staged: unused (0). */
  version: number;
  stamp: { sid: string; run_id: string; hop_version: string; principal: string };
  /** Staged keyed claims: the store's version of the key at staging time (§e). */
  seen_version: number;
  /** `<checkpoint event_id>:claim:<i>`. */
  staged_event_id: string;
}

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeProposal {
  proposal_id: string;
  store: string;
  run_id: string;
  sid: string;
  n_nodes: number;
  state: "pending" | "promoted" | "rejected";
}

export interface FakeMemoryStore {
  /** The base a grant names: `http://127.0.0.1:<port>/api/v1`. */
  url: string;
  /** An engine token shaped as the real one (an hs256 JWT whose payload carries the P5 engine claims; the fake
   *  checks it by lookup, not by signature). */
  mintEngine(claims: FakeEngineClaims): string;
  revoke(token: string): void;
  /** Promoted facts written to a store directly (another run's, a person's, a shared store's): one store version. */
  seed(store: string, facts: Array<{ topic: string; key: string; value: string; kind?: string }>): void;
  staged(store: string, runId: string): FakeNode[];
  promoted(store: string): FakeNode[];
  storeVersion(store: string): number;
  /** Times a promotion actually folded claims or opened a proposal (a repeat answers from the record). */
  promotions(): number;
  proposals(): FakeProposal[];
  /** The control side of the review queue: approve folds the proposal's staging, reject records it. */
  decide(proposalId: string, decision: "approve" | "reject"): void;
  /** Every request, in order (bodies parsed). */
  requests: FakeRequest[];
  /** The next `times` requests to `route` answer `status {detail: {code}}` before touching state. */
  fail(route: FakeMemoryRoute, status: number, code: string, times?: number): void;
  stop(): Promise<void>;
}

interface StoreState {
  version: number;
  /** anchor → node. */
  nodes: Map<string, FakeNode>;
}

const MOUNT = "/api/v1";
const DEFAULT_LIMITS = { max_nodes: 5000, max_bytes: 10_485_760, max_write_bytes: 65_536 };
const KEYED = new Set(["state", "preference", "record"]);

const refuse = (status: number, code: string, message: string, fields: Record<string, unknown> = {}): Response => Response.json({ detail: { code, message, ...fields } }, { status });
/** `hop:5/acme` → `5/acme`, memory's scope_id under scope `hop`. */
const scopeIdOf = (store: string): string => store.replace(/^hop:/, "");
/** A keyed claim's anchor is its key; a learning (or a deviation) is one fact per topic and key. */
const anchorOf = (c: { kind: string; topic: string; key: string }): string => `${c.kind}:${c.topic}:${c.key}`;
const bytesOf = (n: FakeNode): number => Buffer.byteLength(n.key) + Buffer.byteLength(n.value);

export function startFakeMemoryStore(): FakeMemoryStore {
  const tokens = new Map<string, FakeEngineClaims>();
  const stores = new Map<string, StoreState>();
  /** `${store}\0${run}` → anchor → node. */
  const staging = new Map<string, Map<string, FakeNode>>();
  const checkpoints = new Map<string, { accepted: number; window: boolean }>();
  const promoteAnswers = new Map<string, Record<string, unknown>>();
  const proposals = new Map<string, FakeProposal>();
  const faults = new Map<FakeMemoryRoute, Array<{ status: number; code: string }>>();
  const requests: FakeRequest[] = [];
  let promotions = 0;

  const storeOf = (name: string): StoreState => {
    let s = stores.get(name);
    if (!s) {
      s = { version: 0, nodes: new Map() };
      stores.set(name, s);
    }
    return s;
  };
  const stagingOf = (store: string, run: string): Map<string, FakeNode> => {
    const k = `${store}\0${run}`;
    let m = staging.get(k);
    if (!m) {
      m = new Map();
      staging.set(k, m);
    }
    return m;
  };
  const limitsOf = (c: FakeEngineClaims) => ({ ...DEFAULT_LIMITS, ...c.limits });

  /** Writes a value into the promoted store: a new value bumps the key's version, the current one again does not. */
  const write = (st: StoreState, anchor: string, n: FakeNode, store: string): void => {
    const now = st.nodes.get(anchor);
    const version = !now ? 1 : now.value === n.value ? now.version : now.version + 1;
    st.nodes.set(anchor, { ...n, scope_id: scopeIdOf(store), version, seen_version: 0 });
  };

  /** The run's view: its own staging, then the promoted store (one copy per key, the narrowest first), then shared. */
  const visible = (c: FakeEngineClaims): FakeNode[] => {
    const out = new Map<string, FakeNode>(stagingOf(c.store, c.runId));
    for (const [k, n] of storeOf(c.store).nodes) if (!out.has(k)) out.set(k, n);
    return [...out.values(), ...(c.shared ?? []).flatMap((s) => [...storeOf(s.scope_id).nodes.values()])];
  };

  /** Folds a run's staging into its store; a keyed claim the store moved since staging stays staged as a conflict. */
  const fold = (store: string, run: string): { promoted: number; conflicts: Array<Record<string, unknown>> } => {
    const st = storeOf(store);
    const staged = stagingOf(store, run);
    const conflicts: Array<Record<string, unknown>> = [];
    let promoted = 0;
    for (const [anchor, n] of [...staged]) {
      const current = st.nodes.get(anchor)?.version ?? 0;
      if (KEYED.has(n.kind) && current !== n.seen_version) {
        conflicts.push({ key: n.key, topic: n.topic, seen_version: n.seen_version, current_version: current, staged_event_id: n.staged_event_id });
        continue;
      }
      write(st, anchor, n, store);
      staged.delete(anchor);
      promoted += 1;
    }
    if (promoted > 0) st.version += 1;
    return { promoted, conflicts };
  };

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const raw = req.method === "POST" ? await req.text() : "";
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers.entries()), body });
    if (!url.pathname.startsWith(`${MOUNT}/`)) return refuse(404, "not_found", "no such route");
    const path = url.pathname.slice(MOUNT.length);
    const promoteMatch = path.match(/^\/memory\/stores\/(.+)\/runs\/([^/]+)\/promote$/);
    const route: FakeMemoryRoute | null =
      req.method === "POST" && path === "/memory/checkpoint" ? "checkpoint" : req.method === "GET" && path === "/memory/search" ? "search" : req.method === "GET" && path === "/memory/projection" ? "projection" : req.method === "POST" && promoteMatch ? "promote" : null;
    if (!route) return refuse(404, "not_found", "no such route");

    const auth = req.headers.get("authorization");
    const claims = auth?.startsWith("Bearer ") ? tokens.get(auth.slice(7)) : undefined;
    if (!claims) return refuse(401, "unauthenticated", "the memory token is missing, bad or expired");
    const fault = faults.get(route)?.shift();
    if (fault) return refuse(fault.status, fault.code, "injected");

    if (route === "checkpoint") return checkpoint(claims, raw, body as CheckpointBody);

    if (route === "search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const hits = visible(claims)
        .filter((n) => !q || `${n.topic} ${n.key} ${n.value}`.toLowerCase().includes(q))
        .slice(0, limit)
        .map((n) => ({ id: n.staged_event_id || `${n.scope_id}#${n.key}`, type: n.kind, key: n.key, summary: n.value, scope: "hop", scope_id: n.scope_id, version: n.version }));
      return Response.json({ nodes: hits, edges: [], passages: [], took_ms: 1 });
    }

    if (route === "projection") {
      const facts = visible(claims);
      const markdown = facts.length ? `# Memory\n${facts.map((n) => `- ${n.topic}#${n.key}: ${n.value}`).join("\n")}\n` : "# Memory\n";
      return Response.json({ markdown, estimated_tokens: Math.ceil(markdown.length / 4), fact_count: facts.length, truncated: false, took_ms: 1 });
    }

    const [, store, run] = promoteMatch!.map(decodeURIComponent) as [string, string, string];
    if (store !== claims.store) return refuse(404, "unknown_store", `this token's store is ${claims.store}`);
    if (run !== claims.runId) return refuse(404, "unknown_run", `this token is run ${claims.runId}`);
    return promote(claims, store, run);
  }

  interface CheckpointBody {
    event_id?: string;
    claims?: Array<Record<string, unknown>>;
    note?: Record<string, string>;
    window?: unknown;
  }

  function checkpoint(claims: FakeEngineClaims, raw: string, b: CheckpointBody): Response {
    const limits = limitsOf(claims);
    const size = Buffer.byteLength(raw);
    if (size > limits.max_write_bytes) return refuse(413, "write_too_large", `${size} bytes over the grant's ${limits.max_write_bytes}`, { size, limit: limits.max_write_bytes });
    if (!b?.event_id) return Response.json({ detail: [{ loc: ["body", "event_id"], msg: "Field required", type: "missing" }] }, { status: 422 });
    if (b.note && Object.keys(b.note).length > 0) return refuse(422, "note_not_staged", "a run's checkpoint stages claims and the window; note sections are not staged in this cut");
    const items = (b.claims ?? []).map((c) => ({ kind: String(c.kind), topic: String(c.topic), key: String(c.key), value: String(c.value), expected_version: c.expected_version }));
    const done = checkpoints.get(`${claims.runId}\0${b.event_id}`);
    if (done) return Response.json(checkpointAnswer(b.event_id, 0, done.accepted, done.window));
    const st = storeOf(claims.store);
    for (const c of items) {
      if (typeof c.expected_version !== "number") continue;
      if (!KEYED.has(c.kind)) return refuse(422, "invalid_precondition", `expected_version applies to keyed claims, not a ${c.kind}`, { key: c.key });
      const current = st.nodes.get(anchorOf(c))?.version ?? 0;
      if (current !== c.expected_version) return refuse(409, "version_conflict", `${c.key} is at version ${current}, not ${c.expected_version}`, { key: c.key, current_version: current });
    }
    const staged = stagingOf(claims.store, claims.runId);
    items.forEach((c, i) => {
      const anchor = anchorOf(c);
      staged.set(anchor, {
        key: c.key,
        kind: c.kind,
        topic: c.topic,
        value: c.value,
        scope_id: `${scopeIdOf(claims.store)}/run/${claims.runId}`,
        version: 0,
        stamp: { sid: claims.sid, run_id: claims.runId, hop_version: claims.hopVersion ?? "0.0.0", principal: claims.customer ?? "customer" },
        seen_version: st.nodes.get(anchor)?.version ?? 0,
        staged_event_id: `${b.event_id}:claim:${i}`,
      });
    });
    const window = b.window !== undefined && b.window !== null;
    checkpoints.set(`${claims.runId}\0${b.event_id}`, { accepted: items.length, window });
    return Response.json(checkpointAnswer(b.event_id, items.length, 0, window));
  }

  function checkpointAnswer(eventId: string, accepted: number, duplicates: number, window: boolean): Record<string, unknown> {
    return {
      claims: { accepted, duplicates, processed: accepted, rejected: [] },
      event_id: eventId,
      note_applied: false,
      note_version: null,
      window: window ? { event_id: `${eventId}:window`, status: "processed" } : null,
    };
  }

  function promote(claims: FakeEngineClaims, store: string, run: string): Response {
    const key = `${store}\0${run}`;
    const prior = promoteAnswers.get(key);
    if (prior) return Response.json(prior);
    const st = storeOf(store);
    const staged = stagingOf(store, run);
    if (staged.size === 0) return Response.json({ state: "empty", store_version: st.version });
    let answer: Record<string, unknown>;
    if (claims.promotion === "review") {
      const proposal_id = `proposal:${new CryptoHasher("sha1").update(key).digest("hex")}`;
      proposals.set(proposal_id, { proposal_id, store, run_id: run, sid: claims.sid, n_nodes: staged.size, state: "pending" });
      answer = { conflicts: [], promoted: 0, proposal_id, state: "pending", store_version: null };
    } else {
      const limits = limitsOf(claims);
      const after = new Map(st.nodes);
      for (const [a, n] of staged) after.set(a, n);
      if (after.size > limits.max_nodes) return refuse(413, "store_full", `the store would hold ${after.size} nodes over the grant's ${limits.max_nodes}`, { nodes: after.size, limit: limits.max_nodes });
      const bytes = [...after.values()].reduce((sum, n) => sum + bytesOf(n), 0);
      if (bytes > limits.max_bytes) return refuse(413, "store_full", `the store would hold ${bytes} bytes over the grant's ${limits.max_bytes}`, { bytes, limit: limits.max_bytes });
      const { promoted, conflicts } = fold(store, run);
      answer = { conflicts, promoted, proposal_id: null, state: "promoted", store_version: st.version };
    }
    promotions += 1;
    promoteAnswers.set(key, answer);
    return Response.json(answer);
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });

  return {
    url: `http://127.0.0.1:${server.port}${MOUNT}`,
    requests,
    mintEngine(claims) {
      const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      const payload = { role: "engine", sid: claims.sid, run_id: claims.runId, store: claims.store, shared: claims.shared ?? [], promotion: claims.promotion, limits: limitsOf(claims), customer: claims.customer ?? "customer", hop: { version: claims.hopVersion ?? "0.0.0" }, exp: 4102444800 };
      const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.${Buffer.from(crypto.randomUUID()).toString("base64url")}`;
      tokens.set(token, claims);
      storeOf(claims.store);
      return token;
    },
    revoke(token) {
      tokens.delete(token);
    },
    seed(store, facts) {
      const st = storeOf(store);
      for (const f of facts) {
        const kind = f.kind ?? "learning";
        write(st, anchorOf({ kind, topic: f.topic, key: f.key }), { key: f.key, kind, topic: f.topic, value: f.value, scope_id: scopeIdOf(store), version: 0, stamp: { sid: "seed", run_id: "seed", hop_version: "0.0.0", principal: "seed" }, seen_version: 0, staged_event_id: "" }, store);
      }
      st.version += 1;
    },
    staged: (store, runId) => [...stagingOf(store, runId).values()],
    promoted: (store) => [...storeOf(store).nodes.values()],
    storeVersion: (store) => storeOf(store).version,
    promotions: () => promotions,
    proposals: () => [...proposals.values()],
    decide(proposalId, decision) {
      const p = proposals.get(proposalId);
      if (!p || p.state !== "pending") throw new Error(`proposal ${proposalId} is not pending`);
      p.state = decision === "approve" ? "promoted" : "rejected";
      const key = `${p.store}\0${p.run_id}`;
      if (decision === "approve") {
        const { promoted, conflicts } = fold(p.store, p.run_id);
        promoteAnswers.set(key, { conflicts, promoted, proposal_id: proposalId, state: "promoted", store_version: storeOf(p.store).version });
      } else {
        stagingOf(p.store, p.run_id).clear();
        promoteAnswers.set(key, { conflicts: [], promoted: 0, proposal_id: proposalId, state: "rejected", store_version: null });
      }
    },
    fail(route, status, code, times = 1) {
      const list = faults.get(route) ?? [];
      for (let i = 0; i < times; i++) list.push({ status, code });
      faults.set(route, list);
    },
    async stop() {
      await server.stop(true);
    },
  };
}
