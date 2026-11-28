import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLOCK_KINDS,
  checkShowInput,
  DISPLAY_CATALOG,
  HOME_LIMITS,
  isBlockKind,
  type BlockDisplay,
  type DisplayKind,
  type DisplayError,
  type HomeBlock,
  type HomeRefreshError,
  type HomeScripts,
  type HomeView,
  type TextDisplay,
} from "@mlpal/harness-protocol";
import { type Logger, silentLogger } from "../obs/logger";
import { type Metrics, noopMetrics } from "../obs/metrics";
import type { HopUi, HopUiBlock } from "../profile/ui";
import type { HomeScriptRunner } from "./home-script";

const HOME_KINDS: ReadonlySet<DisplayKind> = new Set(BLOCK_KINDS);

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
 * Load bounds: one run of a block at a time, joined by every caller (so at most one per connection, too); a block run
 * in the last 60 s is not run again, whoever asks (a page reloaded ten times starts nothing new); at most two scripts at
 * once per resolver, and a serve has one, for its own HOP; a run whose every caller's signal aborted (their connections
 * closed) is killed, and `close` kills them all.
 *
 * The last good block of each is kept in memory per (hop@version, block id) and on disk under `cacheDir`
 * (`<hop>@<version>/<block>.json`), so a woken workspace shows something at once. Logs and counters carry the HOP, the
 * block id, the outcome and sizes: never what a script printed, on either stream.
 */

export interface HomeResolverOptions {
  hop: { name: string; version: string; ui?: HopUi };
  /** Whether scripts may run (home-trust.ts, the serve's kill switch). Anything but `run`: the view has the starters,
   *  `blocks: []` and this reason, and no script is ever started. */
  scripts: "run" | HomeScripts;
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
  // a home block is a wave-1 block (chart, kpis, grid): a home script names no workspace file
  const check = checkShowInput({ ...(raw as Record<string, unknown>), block_id: block.id, title: block.title }, { kinds: HOME_KINDS });
  if (!check.ok) {
    const e = check.error;
    return { ok: false, error: "invalid_block", detail: `${e.code}${e.path ? ` at ${e.path}` : ""}: ${e.message}${e.hint ? ` (${e.hint})` : ""}`, faults: check.errors, ...(check.fallback ? { fallback: check.fallback } : {}) };
  }
  const s = check.show;
  if (!isBlockKind(s.kind)) return { ok: false, error: "invalid_block", detail: `KIND_NOT_ALLOWED: a home block is ${BLOCK_KINDS.join(", ")}` };
  return { ok: true, kind: s.kind, spec: s.spec as BlockDisplay["spec"], fallback: s.fallback, ...(s.as_of ? { as_of: s.as_of } : {}), ...(s.notices ? { notices: s.notices } : {}) };
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

/** What the disk keeps of a block's last good run: the script's own stdout, checked again at every read exactly as a
 *  fresh run's is, so a file anyone wrote never reaches the person unchecked. */
interface CacheFile {
  v: 2;
  stdout: string;
  /** When the script ran (ISO 8601). */
  ran_at: string;
  revision: number;
}

export class HomeResolver {
  private readonly hopLabel: string;
  private readonly blocks: HopUiBlock[];
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Run>();
  private closed = false;
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
   *  this call started or joined, once, as its refresh ends. `signal` is the caller's interest (its connection): a run
   *  every interested caller has left is killed. Without one, the caller's interest never ends. */
  get(onUpdate?: (block: HomeBlock) => void, signal?: AbortSignal): HomeView {
    const view = this.view();
    if (this.opts.scripts !== "run" || this.closed || signal?.aborted) return view;
    for (const b of this.blocks) {
      const e = this.entries.get(b.id)!;
      const due = e.attemptedAt === null || this.now() - e.attemptedAt >= HOME_LIMITS.rerunAfterMs;
      const run = this.inflight.get(b.id) ?? (due ? this.refresh(b) : undefined);
      if (!run) continue;
      joinRun(run, signal);
      if (onUpdate) void run.promise.then(onUpdate);
    }
    return view;
  }

  /** The cached view, running nothing. */
  view(): HomeView {
    const starters = [...(this.opts.hop.ui?.starters ?? [])];
    if (this.opts.scripts !== "run") return { hop: this.hopLabel, starters, blocks: [], scripts: this.opts.scripts };
    this.loadCache();
    return { hop: this.hopLabel, starters, blocks: this.blocks.map((b) => this.item(b)) };
  }

  /** Kill every running script and start no more (the serve is stopping). */
  close(): void {
    this.closed = true;
    for (const run of this.inflight.values()) run.controller.abort();
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

  private refresh(b: HopUiBlock): Run {
    const e = this.entries.get(b.id)!;
    const before = e.attemptedAt;
    e.attemptedAt = this.now();
    const run: Run = { controller: new AbortController(), interest: 0, forever: false, cleanups: [], promise: undefined as unknown as Promise<HomeBlock> };
    run.promise = this.slot(() => this.resolve(b, run.controller.signal, before))
      .catch((err: unknown) => {
        // resolve never throws by design; if it ever does, the block keeps what it had and says it could not refresh
        this.log.error("home.block.internal", { hop: this.hopLabel, block: b.id, error: (err as Error)?.name ?? typeof err });
        this.fail(b, "not_started");
      })
      .then(() => this.item(b))
      .finally(() => {
        this.inflight.delete(b.id);
        for (const c of run.cleanups) c();
      });
    this.inflight.set(b.id, run);
    return run;
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

  private async resolve(b: HopUiBlock, signal: AbortSignal, attemptedBefore: number | null): Promise<void> {
    const ran = await this.opts.run({ block: b.id, scriptPath: b.scriptPath, signal });
    this.metrics.histogram("home.script_ms", ran.ms, { hop: this.opts.hop.name });
    if (!ran.ok) {
      if (ran.error === "cancelled") {
        // no one waits for it: nothing is learnt about the block, so the next request runs it again
        this.entries.get(b.id)!.attemptedAt = attemptedBefore;
        this.metrics.increment("home.refresh", 1, { outcome: "cancelled" });
        this.log.info("home.block.cancelled", { hop: this.hopLabel, block: b.id, ms: ran.ms });
        return;
      }
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
    const display = blockDisplay(b, out, e.revision + 1);
    Object.assign(e, { display, as_of: out.as_of ?? new Date(at).toISOString(), goodAt: at, displayAt: at, current: true, error: undefined, revision: display.revision });
    this.metrics.increment("home.refresh", 1, { outcome: "ok" });
    this.log.info("home.block.refreshed", { hop: this.hopLabel, block: b.id, kind: out.kind, ms: ran.ms, stdout_bytes: Buffer.byteLength(ran.stdout), revision: display.revision });
    this.writeCache(b.id, { v: 2, stdout: ran.stdout, ran_at: new Date(at).toISOString(), revision: display.revision });
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

  /** Once: every block's last good result from disk, its stored stdout checked by checkHomeOutput as a fresh run's is.
   *  A file that is unreadable, of another shape, or whose output no longer passes is removed and said (the block then
   *  resolves by running its script, as a block with no file does). */
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
      const c = parseCache(text);
      const out = c ? checkHomeOutput(b, c.stdout) : undefined;
      if (!c || !out?.ok) {
        this.log.warn("home.cache.unreadable", { hop: this.hopLabel, block: b.id, error: c ? "refused" : "invalid", ...(out && !out.ok && out.faults?.[0] ? { code: out.faults[0].code } : {}) });
        rmSync(join(this.dir(), `${b.id}.json`), { force: true });
        continue;
      }
      const at = Date.parse(c.ran_at);
      Object.assign(entry, { display: blockDisplay(b, out, c.revision), as_of: out.as_of ?? c.ran_at, goodAt: at, displayAt: at, revision: c.revision });
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

/** One refresh of a block, shared by every caller that started or joined it. */
interface Run {
  promise: Promise<HomeBlock>;
  controller: AbortController;
  /** Callers with a signal not yet aborted. */
  interest: number;
  /** A caller without a signal joined: the run is never cancelled for lack of interest. */
  forever: boolean;
  cleanups: Array<() => void>;
}

function joinRun(run: Run, signal: AbortSignal | undefined): void {
  if (!signal) {
    run.forever = true;
    return;
  }
  run.interest++;
  const leave = () => {
    run.interest--;
    if (run.interest === 0 && !run.forever) run.controller.abort();
  };
  signal.addEventListener("abort", leave, { once: true });
  run.cleanups.push(() => signal.removeEventListener("abort", leave));
}

/** A checked output as the block the person sees: the HOP's id and title, drawn by the host. */
function blockDisplay(b: Pick<HopUiBlock, "id" | "title">, out: Extract<HomeOutput, { ok: true }>, revision: number): BlockDisplay {
  return {
    v: 1,
    block_id: b.id,
    revision,
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
}

/** The file's shape only; its stdout is checked by the caller. */
function parseCache(text: string): CacheFile | null {
  let raw: Partial<CacheFile>;
  try {
    raw = JSON.parse(text) as Partial<CacheFile>;
  } catch {
    return null;
  }
  if (raw?.v !== 2 || typeof raw.stdout !== "string" || typeof raw.ran_at !== "string" || Number.isNaN(Date.parse(raw.ran_at))) return null;
  if (Buffer.byteLength(raw.stdout) > HOME_LIMITS.scriptOutputBytes || !Number.isInteger(raw.revision) || raw.revision! < 1) return null;
  return { v: 2, stdout: raw.stdout, ran_at: raw.ran_at, revision: raw.revision! };
}
