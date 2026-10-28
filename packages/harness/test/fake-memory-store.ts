/**
 * An in-memory P5 memory store on Bun.serve for the engine's memory rung, kept to
 * contracts/P5-memory-store.md 1.0 (draft): the engine routes under `{MEMORY_URL}/v1` (checkpoint, search,
 * projection, promote), engine tokens scoped to one `{sid, run_id, store, shared, promotion, limits}`,
 * staging per run overlaid on the promoted store for that run's reads, promotion `auto` (one store version
 * per promotion) or `review` (a proposal), idempotent per run_id, `expected_version` preconditions,
 * `max_write_bytes` / `max_nodes`, the `{code, message?}` error envelope, and fault injection. Re-pin
 * against W5's fixture (mlpal-memory-graph tests/contract/p5) when it lands.
 */

export type FakeMemoryRoute = "checkpoint" | "search" | "projection" | "promote";

export interface FakeEngineClaims {
  sid: string;
  runId: string;
  store: string;
  shared?: Array<{ scope_id: string; access: "read" | "read_write" }>;
  promotion: "auto" | "review";
  limits?: { max_nodes?: number; max_bytes?: number; max_write_bytes?: number };
  customer?: string;
  hopVersion?: string;
}

export interface FakeNode {
  node_id: string;
  scope_id: string;
  kind: string;
  topic: string;
  key: string;
  value: string;
  version: number;
  status: "active" | "contested";
  stamp: { sid: string; run_id: string; hop_version: string; principal: string };
  /** The promoted version of the key when this node was staged (0: none): promotion re-checks it. */
  base_version: number;
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
  /** The base the grant names: `http://127.0.0.1:<port>/v1`. */
  url: string;
  mintEngine(claims: FakeEngineClaims): string;
  revoke(token: string): void;
  /** Promoted facts already in a store (another run's, or a shared store's). */
  seed(store: string, facts: Array<{ topic: string; key: string; value: string; kind?: string }>): void;
  staged(store: string, runId: string): FakeNode[];
  promoted(store: string): FakeNode[];
  storeVersion(store: string): number;
  /** Times a promotion actually moved nodes or opened a proposal (a repeat answers from the record). */
  promotions(): number;
  proposals(): FakeProposal[];
  /** The control side of the review queue: approve promotes the proposal's staging. */
  decide(proposalId: string, decision: "approve" | "reject"): void;
  /** Every request, in order (bodies parsed). */
  requests: FakeRequest[];
  /** The next `times` requests to `route` answer `status {code}` before touching state. */
  fail(route: FakeMemoryRoute, status: number, code: string, times?: number): void;
  stop(): Promise<void>;
}

interface StoreState {
  version: number;
  nodes: Map<string, FakeNode>;
}

interface Checkpointed {
  status: number;
  body: unknown;
}

const DEFAULT_LIMITS = { max_nodes: 5000, max_bytes: 10_485_760, max_write_bytes: 65_536 };

const err = (status: number, code: string, extra: Record<string, unknown> = {}): Response => Response.json({ code, message: code.replaceAll("_", " "), ...extra }, { status });

export function startFakeMemoryStore(): FakeMemoryStore {
  const tokens = new Map<string, FakeEngineClaims>();
  const stores = new Map<string, StoreState>();
  /** `${store}\0${run}` → key → node. */
  const staging = new Map<string, Map<string, FakeNode>>();
  const checkpoints = new Map<string, Checkpointed>();
  const promoteAnswers = new Map<string, { status: number; body: Record<string, unknown> }>();
  const proposals = new Map<string, FakeProposal>();
  const faults = new Map<FakeMemoryRoute, Array<{ status: number; code: string }>>();
  const requests: FakeRequest[] = [];
  let minted = 0;
  let nodeSeq = 0;
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

  /** The run's view: its own staging over the promoted store, the staging copy winning; then shared stores. */
  const visible = (c: FakeEngineClaims): FakeNode[] => {
    const own = new Map(storeOf(c.store).nodes);
    for (const [k, n] of stagingOf(c.store, c.runId)) own.set(k, n);
    const shared = (c.shared ?? []).flatMap((s) => [...storeOf(s.scope_id).nodes.values()]);
    return [...own.values(), ...shared];
  };

  const currentVersion = (c: FakeEngineClaims, key: string): number => stagingOf(c.store, c.runId).get(key)?.version ?? storeOf(c.store).nodes.get(key)?.version ?? 0;

  const promote = (store: string, run: string): number => {
    const st = storeOf(store);
    const staged = stagingOf(store, run);
    for (const [key, n] of staged) {
      const now = st.nodes.get(key);
      const changedSince = (now?.version ?? 0) !== n.base_version;
      // A key changed since staging is contested (the existing mechanism), never overwritten.
      if (changedSince && now) {
        now.status = "contested";
        continue;
      }
      st.nodes.set(key, { ...n, scope_id: store, version: (now?.version ?? 0) + 1 });
    }
    st.version += 1;
    const n = staged.size;
    staged.clear();
    return n;
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
    if (!url.pathname.startsWith("/v1/")) return err(404, "not_found");
    const path = url.pathname.slice(3);
    const promoteMatch = path.match(/^\/memory\/stores\/([^/]+)\/runs\/([^/]+)\/promote$/);
    const route: FakeMemoryRoute | null =
      req.method === "POST" && path === "/memory/checkpoint" ? "checkpoint" : req.method === "GET" && path === "/memory/search" ? "search" : req.method === "GET" && path === "/memory/projection" ? "projection" : req.method === "POST" && promoteMatch ? "promote" : null;
    if (!route) return err(404, "not_found");

    const auth = req.headers.get("authorization");
    const claims = auth?.startsWith("Bearer ") ? tokens.get(auth.slice(7)) : undefined;
    if (!claims) return err(401, "unauthenticated");
    const fault = faults.get(route)?.shift();
    if (fault) return err(fault.status, fault.code);

    if (route === "checkpoint") {
      const limits = limitsOf(claims);
      if (Buffer.byteLength(raw) > limits.max_write_bytes) return err(413, "write_too_large", { max_write_bytes: limits.max_write_bytes });
      const b = body as { event_id?: string; claims?: Array<Record<string, unknown>> };
      if (!b?.event_id) return err(422, "invalid_body");
      const seen = checkpoints.get(`${claims.runId}\0${b.event_id}`);
      if (seen) {
        const prior = seen.body as { claims: { accepted: number; duplicates: number } };
        return Response.json({ ...prior, claims: { ...prior.claims, accepted: 0, duplicates: prior.claims.accepted } }, { status: seen.status });
      }
      const items = b.claims ?? [];
      for (const c of items) {
        if (typeof c.expected_version !== "number" || typeof c.key !== "string") continue;
        const current = currentVersion(claims, c.key);
        if (current !== c.expected_version) return err(409, "version_conflict", { key: c.key, current_version: current });
      }
      const staged = stagingOf(claims.store, claims.runId);
      for (const c of items) {
        const key = String(c.key);
        const prior = staged.get(key);
        const promoted = storeOf(claims.store).nodes.get(key);
        staged.set(key, {
          node_id: `n${++nodeSeq}`,
          scope_id: `${claims.store}/run/${claims.runId}`,
          kind: String(c.kind ?? "learning"),
          topic: String(c.topic ?? ""),
          key,
          value: String(c.value ?? ""),
          version: (prior?.version ?? promoted?.version ?? 0) + 1,
          status: "active",
          stamp: { sid: claims.sid, run_id: claims.runId, hop_version: claims.hopVersion ?? "0.0.0", principal: claims.customer ?? "customer" },
          base_version: prior?.base_version ?? promoted?.version ?? 0,
        });
      }
      const answer = { event_id: b.event_id, claims: { accepted: items.length, duplicates: 0, processed: items.length, rejected: [] }, note_version: null, note_applied: false, window: null };
      checkpoints.set(`${claims.runId}\0${b.event_id}`, { status: 200, body: answer });
      return Response.json(answer);
    }

    if (route === "search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const hits = visible(claims)
        .filter((n) => !q || `${n.topic} ${n.key} ${n.value}`.toLowerCase().includes(q))
        .slice(0, limit)
        .map((n) => ({ id: n.node_id, type: n.kind, key: n.key, summary: n.value, scope_id: n.scope_id, version: n.version, status: n.status }));
      return Response.json({ nodes: hits, edges: [], passages: [], took_ms: 1 });
    }

    if (route === "projection") {
      const facts = visible(claims);
      const markdown = facts.length ? `# Memory\n${facts.map((n) => `- ${n.topic}#${n.key}: ${n.value}`).join("\n")}\n` : "# Memory\n";
      return Response.json({ markdown, estimated_tokens: Math.ceil(markdown.length / 4), fact_count: facts.length, truncated: false, took_ms: 1 });
    }

    // promote
    const [, store, run] = promoteMatch!.map(decodeURIComponent) as [string, string, string];
    if (store !== claims.store || run !== claims.runId) return err(403, "scope_forbidden");
    const key = `${store}\0${run}`;
    const prior = promoteAnswers.get(key);
    if (prior) return Response.json(prior.body, { status: prior.status });
    const staged = stagingOf(store, run);
    let answer: { status: number; body: Record<string, unknown> };
    if (staged.size === 0) answer = { status: 200, body: { state: "empty" } };
    else if (claims.promotion === "review") {
      const proposal_id = `prop_${proposals.size + 1}`;
      proposals.set(proposal_id, { proposal_id, store, run_id: run, sid: claims.sid, n_nodes: staged.size, state: "pending" });
      promotions += 1;
      answer = { status: 202, body: { state: "pending", proposal_id } };
    } else {
      const limits = limitsOf(claims);
      const fresh = [...staged.keys()].filter((k) => !storeOf(store).nodes.has(k)).length;
      if (storeOf(store).nodes.size + fresh > limits.max_nodes) return err(413, "store_full", { max_nodes: limits.max_nodes });
      const n = promote(store, run);
      promotions += 1;
      answer = { status: 200, body: { state: "promoted", store_version: storeOf(store).version, promoted: n } };
    }
    promoteAnswers.set(key, answer);
    return Response.json(answer.body, { status: answer.status });
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    mintEngine(claims) {
      const token = `test-memory-token-${++minted}`;
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
        st.nodes.set(f.key, {
          node_id: `n${++nodeSeq}`,
          scope_id: store,
          kind: f.kind ?? "learning",
          topic: f.topic,
          key: f.key,
          value: f.value,
          version: (st.nodes.get(f.key)?.version ?? 0) + 1,
          status: "active",
          stamp: { sid: "seed", run_id: "seed", hop_version: "0.0.0", principal: "seed" },
          base_version: 0,
        });
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
      if (decision === "approve") promote(p.store, p.run_id);
      else stagingOf(p.store, p.run_id).clear();
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
