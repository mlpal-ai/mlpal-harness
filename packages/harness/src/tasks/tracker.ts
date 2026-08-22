import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The persistent task tracker — the plan as STATE, not as tool-call history.
 *
 * TodoWrite kept the plan inside the transcript: the model rewrote the whole list each
 * call, and after compaction the plan only survived via a verbatim re-injection hack.
 * Here tasks are first-class: stable numbered ids the model can update individually
 * ("mark #3 completed"), a subject plus an optional description that carries the task's
 * own context, and a JSON file per session so the plan survives restarts, resumes, and
 * compaction untouched.
 *
 * Saves are debounced; hosts MUST call flushAll() on process exit or the last mutation
 * before a quit can be lost.
 *
 * One store serves every session (main and sub-agents alike): trackers are keyed by
 * sessionId, so a child planning its own subtask can never touch the main plan.
 */
export type TaskItemStatus = "pending" | "in_progress" | "completed";

export interface TaskItem {
  id: number;
  subject: string;
  description?: string;
  status: TaskItemStatus;
  createdAt: string;
  updatedAt: string;
}

interface TrackerFile {
  seq: number;
  items: TaskItem[];
}

const SAVE_DEBOUNCE_MS = 150;

export class TaskTracker {
  private readonly items = new Map<number, TaskItem>();
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly path: string) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as TrackerFile;
      this.seq = raw.seq ?? 0;
      for (const it of raw.items ?? []) this.items.set(it.id, it);
    } catch {
      // absent or unreadable — a fresh plan
    }
  }

  create(input: { subject: string; description?: string; status?: TaskItemStatus }): TaskItem {
    const now = new Date().toISOString();
    const item: TaskItem = {
      id: ++this.seq,
      subject: input.subject,
      ...(input.description ? { description: input.description } : {}),
      status: input.status ?? "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    this.save();
    return item;
  }

  update(
    id: number,
    patch: { subject?: string; description?: string; status?: TaskItemStatus },
  ): TaskItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    if (patch.subject !== undefined) item.subject = patch.subject;
    if (patch.description !== undefined) item.description = patch.description;
    if (patch.status !== undefined) item.status = patch.status;
    item.updatedAt = new Date().toISOString();
    this.save();
    return item;
  }

  get(id: number): TaskItem | undefined {
    return this.items.get(id);
  }

  list(): TaskItem[] {
    return [...this.items.values()].sort((a, b) => a.id - b.id);
  }

  /** One-line summary the tools echo back so the model sees progress without a TaskList. */
  summary(): string {
    const all = this.list();
    const done = all.filter((t) => t.status === "completed").length;
    const active = all.find((t) => t.status === "in_progress");
    return `${all.length} task(s), ${done} done${active ? `; now: #${active.id} ${active.subject}` : ""}`;
  }

  /** The plan rendered for compaction/resume injection — always the CURRENT state (the
   *  old mechanism re-injected the last TodoWrite call verbatim, which could be stale). */
  snapshot(): string | null {
    const all = this.list();
    if (all.length === 0) return null;
    return all
      .map((t) => `#${t.id} [${t.status}] ${t.subject}${t.description ? ` — ${t.description}` : ""}`)
      .join("\n");
  }

  /** Debounced atomic write: tmp + rename, so a crash never leaves a torn plan file. */
  private save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const data: TrackerFile = { seq: this.seq, items: this.list() };
    const tmp = `${this.path}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
      renameSync(tmp, this.path);
    } catch {
      // persistence is best-effort; the in-memory plan is still authoritative this session
    }
  }
}

/** Per-session trackers, created lazily — ToolContext.sessionId is the key, so the main
 *  loop and every sub-agent get isolated plans with zero routing code in the tools. */
export class TaskStore {
  private readonly trackers = new Map<string, TaskTracker>();

  constructor(private readonly dir: string) {}

  /** Write every dirty tracker NOW — wired to process exit, because the debounced save
   *  loses the final mutation when the CLI quits within the debounce window. */
  flushAll(): void {
    for (const t of this.trackers.values()) t.flush();
  }

  for(sessionId: string): TaskTracker {
    let t = this.trackers.get(sessionId);
    if (!t) {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      t = new TaskTracker(join(this.dir, `${sessionId}.json`));
      this.trackers.set(sessionId, t);
    }
    return t;
  }
}
