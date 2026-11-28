import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkShowInput,
  DISPLAY_CATALOG,
  displayEnvelopeSchema,
  HOME_LIMITS,
  type BlockDisplay,
  type DisplayError,
  type HomeBlock,
  type HomeRefreshError,
  type HomeView,
  type TextDisplay,
} from "@mlpal/harness-protocol";
import { type Logger, silentLogger } from "../obs/logger";
import { type Metrics, noopMetrics } from "../obs/metrics";
import type { HopUi, HopUiBlock } from "../profile/ui";
import type { HomeScriptRunner } from "./home-script";

/**
 * W3-1: the HOP-shaped home (WAVE-3-HOP-SHAPED-HOME §3). `get` answers the cached view at once and refreshes, in the
 * background, every block whose last attempt is older than 60 s: one script per block, at most two at a time, and a
 * block already refreshing is joined, never run twice. No model is called and no token is spent; the cost is what the
 * scripts do.
 *
 * What a script prints is checked exactly as a model's Show is (checkShowInput: the bounds, the 256 KiB limit,
 * validateBlock with the chart grammar and the cost walker, the fallback rules of v0 §2.5 with the stored text
 * neutralised), as `{kind, spec, fallback, as_of?}` with the block's id and its declared title. A failure of any kind
 * (a timeout, a crash, junk, too much output, a block the checks refuse) keeps the last good block, marked stale with
 * the reason; nothing a script does can fail `get` or another block.
 *
 * The last good block of each is kept in memory per (hop@version, block id) and on disk under `cacheDir`
 * (`<hop>@<version>/<block>.json`), so a woken workspace shows something at once. Logs and counters carry the HOP, the
 * block id, the outcome and sizes: never what a script printed, on either stream.
 */

export interface HomeResolverOptions {
  hop: { name: string; version: string; ui?: HopUi };
  run: HomeScriptRunner;
  /** `~/.yodex/home-cache` in a workspace. */
  cacheDir: string;
  logger?: Logger;
  metrics?: Metrics;
  now?: () => number;
}

/** What one script's output came to: a block (or, failing that, its fallback alone) or the reason it is neither. */
export type HomeOutput =
  | { ok: true; kind: BlockDisplay["kind"]; spec: BlockDisplay["spec"]; fallback: string; as_of?: string; notices?: string[] }
  | { ok: false; error: "not_json" | "invalid_block"; detail: string; faults?: DisplayError[]; fallback?: string };

const OUTPUT_KEYS = new Set(["kind", "spec", "fallback", "as_of"]);

/** Check one script's stdout as the block `block` (pure): what `get` and `yodex hop lint --home` both run. */
export function checkHomeOutput(block: Pick<HopUiBlock, "id" | "title">, stdout: string): HomeOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "not_json", detail: "stdout is not one JSON object" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "not_json", detail: "stdout is JSON but not an object" };
  const extra = Object.keys(raw).filter((k) => !OUTPUT_KEYS.has(k));
  if (extra.length) return { ok: false, error: "invalid_block", detail: `unknown field${extra.length === 1 ? "" : "s"} ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}: a home script prints {kind, spec, fallback, as_of?}` };
  const check = checkShowInput({ ...(raw as Record<string, unknown>), block_id: block.id, title: block.title });
  if (!check.ok) {
    const e = check.error;
    return { ok: false, error: "invalid_block", detail: `${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}${e.hint ? ` (${e.hint})` : ""}`, faults: check.errors, ...(check.fallback ? { fallback: check.fallback } : {}) };
  }
  const s = check.show;
  return { ok: true, kind: s.kind, spec: s.spec, fallback: s.fallback, ...(s.as_of ? { as_of: s.as_of } : {}), ...(s.notices ? { notices: s.notices } : {}) };
}

interface Entry {
  /** The last good block, or the fallback alone of a block that never resolved. */
  display: BlockDisplay | TextDisplay | null;
  as_of: string | null;
  /** When `display` became the last good block (ms); null for none, or for a fallback alone. */
  goodAt: number | null;
  /** When `display` was produced (ms). */
  displayAt: number | null;
  /** `display` came from the newest refresh that ended (or from disk, before any here). */
  current: boolean;
  /** When the newest refresh started (ms); null when none has, in this process. */
  attemptedAt: number | null;
  error?: HomeRefreshError;
  revision: number;
}

interface CacheFile {
  v: 1;
  display: BlockDisplay;
  as_of: string;
  good_at: string;
  revision: number;
}

export class HomeResolver {
  private readonly hopLabel: string;
  private readonly blocks: HopUiBlock[];
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<HomeBlock>>();
  private readonly queue: Array<() => void> = [];
  private running = 0;
  private loaded = false;
  private readonly log: Logger;
  private readonly metrics: Metrics;
  private readonly now: () => number;

  constructor(private readonly opts: HomeResolverOptions) {
    this.hopLabel = `${opts.hop.name}@${opts.hop.version}`;
    this.blocks = opts.hop.ui?.home?.blocks ?? [];
    this.log = opts.logger ?? silentLogger;
    this.metrics = opts.metrics ?? noopMetrics;
    this.now = opts.now ?? Date.now;
  }

  /** The view now, and a refresh of every block whose last attempt is older than 60 s; `onUpdate` hears each block
   *  this call started or joined, once, as its refresh ends. */
  get(onUpdate?: (block: HomeBlock) => void): HomeView {
    this.loadCache();
    const view = this.view();
    for (const b of this.blocks) {
      const e = this.entries.get(b.id)!;
      const due = e.attemptedAt === null || this.now() - e.attemptedAt >= HOME_LIMITS.rerunAfterMs;
      const p = this.inflight.get(b.id) ?? (due ? this.refresh(b) : undefined);
      if (p && onUpdate) void p.then(onUpdate);
    }
    return view;
  }

  /** The cached view, running nothing. */
  view(): HomeView {
    this.loadCache();
    return { hop: this.hopLabel, starters: [...(this.opts.hop.ui?.starters ?? [])], blocks: this.blocks.map((b) => this.item(b)) };
  }

  private item(b: HopUiBlock): HomeBlock {
    const e = this.entries.get(b.id)!;
    const old = e.displayAt !== null && this.now() - e.displayAt > b.refreshMs;
    return {
      id: b.id,
      title: b.title,
      as_of: e.display ? e.as_of : null,
      stale: e.display !== null && (!e.current || old),
      display: e.display,
      ...(e.error ? { error: e.error } : {}),
    };
  }

  private refresh(b: HopUiBlock): Promise<HomeBlock> {
    const e = this.entries.get(b.id)!;
    e.attemptedAt = this.now();
    const p = this.slot(() => this.resolve(b))
      .catch((err: unknown) => {
        // resolve never throws by design; if it ever does, the block keeps what it had and says it could not refresh
        this.log.error("home.block.internal", { hop: this.hopLabel, block: b.id, error: (err as Error)?.name ?? typeof err });
        this.fail(b, "not_started");
      })
      .then(() => this.item(b))
      .finally(() => this.inflight.delete(b.id));
    this.inflight.set(b.id, p);
    return p;
  }

  /** At most HOME_LIMITS.concurrency scripts at once; the rest wait their turn in order. */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= HOME_LIMITS.concurrency) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  private async resolve(b: HopUiBlock): Promise<void> {
    const ran = await this.opts.run({ block: b.id, scriptPath: b.scriptPath });
    this.metrics.histogram("home.script_ms", ran.ms, { hop: this.opts.hop.name });
    if (!ran.ok) {
      this.log.warn("home.block.refresh_failed", { hop: this.hopLabel, block: b.id, error: ran.error, ms: ran.ms, stderr_bytes: ran.stderrBytes, ...(ran.exitCode !== undefined ? { exit_code: ran.exitCode } : {}) });
      return this.fail(b, ran.error);
    }
    const out = checkHomeOutput(b, ran.stdout);
    if (!out.ok) {
      this.log.warn("home.block.refresh_failed", { hop: this.hopLabel, block: b.id, error: out.error, ms: ran.ms, stdout_bytes: Buffer.byteLength(ran.stdout), ...(out.faults?.[0] ? { code: out.faults[0].code } : {}) });
      return this.fail(b, out.error, out.fallback);
    }
    const e = this.entries.get(b.id)!;
    const at = this.now();
    const as_of = out.as_of ?? new Date(at).toISOString();
    const display = {
      v: 1,
      block_id: b.id,
      revision: e.revision + 1,
      op: "snapshot",
      level: "block",
      kind: out.kind,
      catalog: DISPLAY_CATALOG,
      spec: out.spec,
      fallback: { text: out.fallback },
      source: { by: "host", origin: "home" },
      title: b.title,
      status: "ok",
    } as BlockDisplay;
    Object.assign(e, { display, as_of, goodAt: at, displayAt: at, current: true, error: undefined, revision: display.revision });
    this.metrics.increment("home.refresh", 1, { outcome: "ok" });
    this.log.info("home.block.refreshed", { hop: this.hopLabel, block: b.id, kind: out.kind, ms: ran.ms, stdout_bytes: Buffer.byteLength(ran.stdout), revision: display.revision });
    this.writeCache(b.id, { v: 1, display, as_of, good_at: new Date(at).toISOString(), revision: display.revision });
  }

  /** The refresh failed: the last good block stays (stale); a block with none shows the newest valid fallback alone. */
  private fail(b: HopUiBlock, error: HomeRefreshError, fallback?: string): void {
    const e = this.entries.get(b.id)!;
    e.error = error;
    e.current = false;
    this.metrics.increment("home.refresh", 1, { outcome: error });
    if (e.goodAt !== null || fallback === undefined) return;
    const revision = e.revision + 1;
    const at = this.now();
    e.display = { v: 1, block_id: b.id, revision, op: "snapshot", level: "text", fallback: { text: fallback }, source: { by: "host", origin: "home" }, title: b.title, status: "fallback_only" };
    Object.assign(e, { as_of: new Date(at).toISOString(), displayAt: at, current: true, revision });
  }

  private dir(): string {
    return join(this.opts.cacheDir, this.hopLabel);
  }

  /** Once: every block's last good result from disk; a file that is missing, unreadable or not a valid block of this
   *  block is skipped (and said, unless it is simply missing). */
  private loadCache(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const b of this.blocks) {
      const entry: Entry = { display: null, as_of: null, goodAt: null, displayAt: null, current: true, attemptedAt: null, revision: 0 };
      this.entries.set(b.id, entry);
      let text: string;
      try {
        text = readFileSync(join(this.dir(), `${b.id}.json`), "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log.warn("home.cache.unreadable", { hop: this.hopLabel, block: b.id, error: (e as NodeJS.ErrnoException).code ?? "read" });
        continue;
      }
      const c = parseCache(text, b.id);
      if (!c) {
        this.log.warn("home.cache.unreadable", { hop: this.hopLabel, block: b.id, error: "invalid" });
        continue;
      }
      const at = Date.parse(c.good_at);
      Object.assign(entry, { display: c.display, as_of: c.as_of, goodAt: at, displayAt: at, revision: c.revision });
    }
  }

  private writeCache(id: string, c: CacheFile): void {
    const file = join(this.dir(), `${id}.json`);
    const tmp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    try {
      mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (e) {
      this.log.warn("home.cache.write_failed", { hop: this.hopLabel, block: id, error: (e as NodeJS.ErrnoException).code ?? "write" });
    }
  }
}

function parseCache(text: string, id: string): CacheFile | null {
  let raw: Partial<CacheFile>;
  try {
    raw = JSON.parse(text) as Partial<CacheFile>;
  } catch {
    return null;
  }
  if (raw?.v !== 1 || typeof raw.as_of !== "string" || typeof raw.good_at !== "string" || Number.isNaN(Date.parse(raw.good_at))) return null;
  if (!Number.isInteger(raw.revision) || raw.revision! < 1) return null;
  const env = displayEnvelopeSchema.safeParse(raw.display);
  if (!env.success || env.data.level !== "block" || env.data.block_id !== id || env.data.source.by !== "host") return null;
  return { v: 1, display: env.data as BlockDisplay, as_of: raw.as_of, good_at: raw.good_at, revision: raw.revision! };
}
