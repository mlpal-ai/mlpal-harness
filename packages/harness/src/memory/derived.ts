import { z } from "zod";
import { defineTool, type Tool } from "../tools/types";
import type { Store } from "../store/types";

/**
 * Derived memories: durable facts the agent learns during sessions, written by the model
 * itself via the Memorize tool (no extra extraction calls) into
 * the unified store's memory area, and injected into the system prompt next session.
 *
 * Frontmatter is chosen to sync losslessly into the mlpal-memory-graph service
 * (POST /api/v1/episodes, EpisodeEnvelope) later:
 *   event_id   — stable UUID per assertion; the envelope PK (idempotent re-sync).
 *   occurred   — VALID-time: when the fact became true in the world.
 *   created/updated — belief-time (maps to ingested_at); updates mint a new event_id
 *   supersedes — prior event_id chain, so the graph's bitemporal invalidation
 *                (invalid_at on the old edge) can fire without an LLM judge.
 *   scope      — project → graph scope "repo" (scope_id = workspace);
 *                global  → graph scope "user".
 *   sessions   — provenance (maps to subject.chat_id list).
 *   type       — local tag (graph core ontology is closed; lands in props).
 */

export type MemoryScope = "project" | "global";
export type MemoryType = "decision" | "gotcha" | "preference" | "reference" | "fact";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function topicKey(scope: MemoryScope, workspace: string, slug: string): string {
  return scope === "global" ? `global--${slug}` : `${workspace}--${slug}`;
}

export function frontmatter(meta: Record<string, string>): string {
  const body = Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${body}\n---\n`;
}

export interface ParsedTopic {
  meta: Record<string, string>;
  content: string;
}

export function parseTopic(raw: string): ParsedTopic {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { meta: {}, content: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, content: m[2]!.trim() };
}

/**
 * Map a parsed topic onto the mlpal-memory-graph bitemporal episode envelope — the single
 * translation a sync worker (topic files → POST /api/v1/episodes) needs. Kept here beside
 * the frontmatter writer so the two never drift. Fields the envelope lacks natively
 * (supersedes / created / updated / type) ride in `payload`; the server sets belief-time.
 * `scope_id` is the workspace for project scope (a stable id is a hosted-mode concern).
 */
export interface EpisodeEnvelope {
  event_id: string;
  occurred_at: string;
  scope: "user" | "org" | "repo";
  scope_id?: string;
  action_type?: string;
  content: string;
  payload: Record<string, string>;
}

export function topicToEnvelope(topic: string, parsed: ParsedTopic): EpisodeEnvelope {
  const m = parsed.meta;
  const isGlobal = topic.startsWith("global--") || m.scope === "global";
  return {
    event_id: m.event_id ?? crypto.randomUUID(),
    occurred_at: m.occurred ?? m.updated ?? m.created ?? new Date().toISOString(),
    // yodex scope → envelope scope: global→user, project→repo (the memory-graph enum).
    scope: isGlobal ? "user" : "repo",
    scope_id: isGlobal ? undefined : m.workspace,
    action_type: m.type,
    content: parsed.content,
    payload: {
      ...(m.type ? { type: m.type } : {}),
      ...(m.supersedes ? { supersedes: m.supersedes } : {}),
      ...(m.created ? { created: m.created } : {}),
      ...(m.updated ? { updated: m.updated } : {}),
      ...(m.sessions ? { sessions: m.sessions } : {}),
    },
  };
}

/**
 * Render the derived-memory section for the system prompt: full content of every topic
 * in scope (global + this workspace), newest-updated first, capped so it can't crowd
 * the window. Memories are distilled facts — they should be small.
 */
export async function derivedMemorySection(
  store: Store,
  workspace: string,
  maxChars = 6000,
): Promise<string> {
  const topics = await store.memory.listTopics();
  const mine = topics.filter((t) => t.startsWith("global--") || t.startsWith(`${workspace}--`));
  if (mine.length === 0) return "";
  const entries: Array<{ t: string; updated: string; body: string }> = [];
  for (const t of mine) {
    const raw = await store.memory.readTopic(t);
    if (!raw) continue;
    const { meta, content } = parseTopic(raw);
    entries.push({
      t,
      updated: meta.updated ?? meta.created ?? "",
      body: `## ${t.replace(/^.*?--/, "")} (${meta.type ?? "fact"}, ${meta.updated ?? meta.created ?? "?"})\n${content}`,
    });
  }
  entries.sort((a, b) => b.updated.localeCompare(a.updated));
  const out: string[] = [];
  let used = 0;
  let dropped = 0;
  for (const e of entries) {
    if (used + e.body.length > maxChars) {
      dropped++;
      continue;
    }
    out.push(e.body);
    used += e.body.length;
  }
  if (out.length === 0) return "";
  return (
    "\n\n# Derived memories\nFacts you saved in past sessions (point-in-time — verify against current code before relying on file/line specifics). Update them with Memorize when they change.\n\n" +
    out.join("\n\n") +
    (dropped ? `\n\n(${dropped} older memories omitted — see /memory)` : "")
  );
}

/** Provenance stamped on every memory write, so an audit can find every memory written under a
 *  given HOP + prompt (a wrong verifier rule once became a memorised policy; by timestamp alone
 *  that is unfindable). Supplied by the host, which knows the loaded HOP and how the run began. */
export interface MemorizeProvenance {
  /** `<name>@<version>` of the loaded HOP. */
  hop?: string;
  /** Short hash of the loaded prompts (system + verifier task framing). */
  promptSha?: string;
  /** `routine:<name>` | `one-shot` | `interactive`. */
  origin?: string;
}

export interface MemorizeDeps {
  store: Store;
  workspace: string;
  sessionId?: string;
  /** Called per write (the host may resolve it lazily). */
  provenance?: () => MemorizeProvenance;
}

export function createMemorizeTool(deps: MemorizeDeps): Tool<{
  slug: string;
  content: string;
  scope?: MemoryScope;
  type?: MemoryType;
}> {
  return defineTool({
    name: "Memorize",
    description:
      "Save a durable fact to persistent memory so future sessions know it: decisions + why, hard-won gotchas, user preferences, important commands/URLs. NOT for anything derivable from the repo itself or only relevant right now. Re-using an existing slug updates that memory (state the fact fresh, don't append). scope=global for user-level facts, project (default) for this workspace.",
    readOnly: true, // writes user memory, not the workspace — never worth a permission stop
    schema: z.object({
      slug: z.string().describe("stable kebab-case id, e.g. 'deploy-process' (reuse to update)"),
      content: z.string().describe("the fact, self-contained, with the why when it matters"),
      scope: z.enum(["project", "global"]).optional().describe("default: project"),
      type: z.enum(["decision", "gotcha", "preference", "reference", "fact"]).optional(),
    }),
    async call(input, ctx) {
      if (!SLUG_RE.test(input.slug)) {
        return { content: `invalid slug "${input.slug}" — use kebab-case (a-z, 0-9, -)`, isError: true };
      }
      const scope = input.scope ?? "project";
      const key = topicKey(scope, deps.workspace, input.slug);
      const existing = await deps.store.memory.readTopic(key);
      const prior = existing ? parseTopic(existing) : null;
      const now = new Date().toISOString();
      const sessions = new Set(
        (prior?.meta.sessions?.split(",").map((s) => s.trim()).filter(Boolean)) ?? [],
      );
      // Provenance for the memory-graph subject.chat_id — the live session wins; the
      // construction-time deps.sessionId is a fallback for callers that pin one.
      const provenance = ctx.sessionId ?? deps.sessionId;
      if (provenance) sessions.add(provenance.slice(0, 8));
      const meta: Record<string, string> = {
        event_id: crypto.randomUUID(), // new assertion per write (update = new event)
        type: input.type ?? prior?.meta.type ?? "fact",
        scope,
        workspace: deps.workspace,
        occurred: prior && input.content.trim() === prior.content ? (prior.meta.occurred ?? now) : now,
        created: prior?.meta.created ?? now,
        updated: now,
        sessions: [...sessions].join(", "),
        status: "active",
      };
      if (prior?.meta.event_id) meta.supersedes = prior.meta.event_id;
      const prov = deps.provenance?.() ?? {};
      if (prov.hop) meta.hop = prov.hop;
      if (prov.promptSha) meta.prompt_sha = prov.promptSha;
      if (prov.origin) meta.origin = prov.origin;
      await deps.store.memory.writeTopic(key, frontmatter(meta) + input.content.trim() + "\n");
      return { content: `${prior ? "updated" : "saved"} memory ${key}` };
    },
  });
}

/** List memories for /memory: [{key, scope, type, updated, hook}] */
export async function listMemories(
  store: Store,
  workspace: string,
): Promise<Array<{ key: string; type: string; updated: string; hook: string }>> {
  const topics = await store.memory.listTopics();
  const mine = topics.filter((t) => t.startsWith("global--") || t.startsWith(`${workspace}--`));
  const out = [];
  for (const t of mine.sort()) {
    const raw = await store.memory.readTopic(t);
    if (!raw) continue;
    const { meta, content } = parseTopic(raw);
    out.push({
      key: t,
      type: meta.type ?? "fact",
      updated: (meta.updated ?? meta.created ?? "").slice(0, 10),
      hook: content.split("\n")[0]?.slice(0, 80) ?? "",
    });
  }
  return out;
}

export async function readMemory(store: Store, key: string): Promise<string | null> {
  return store.memory.readTopic(key);
}
