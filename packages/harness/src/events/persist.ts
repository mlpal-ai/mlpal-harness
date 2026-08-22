import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventInbox, InboxSnapshot } from "./inbox";
import { host } from "../host";

/**
 * Crash-safe persistence for the async-event pipeline. Two things survive a restart:
 *
 * 1. The inbox (pending events + the idempotency filter) — so an event that arrived but was
 *    never injected is delivered exactly once after resume, and a producer replay is deduped.
 * 2. A roster of the background work that was LIVE at save time. Child processes die with the
 *    CLI (deliberate — nothing detaches), so this work is unrecoverable; on restore each entry
 *    becomes a synthetic error event telling the model it was interrupted. Loss is reported,
 *    never silent.
 *
 * Saves are debounced on every inbox mutation (emit AND drain — a stale post-drain snapshot
 * would re-deliver already-injected events on resume). The residual exposure is the few ms
 * between a drain and the debounced write; accepted for v1 (a 2-phase ack isn't worth it).
 */

export interface LiveWorkRef {
  id: string;
  kind: "shell" | "agent" | "monitor";
  label: string;
  /** Durable monitors only — enough to re-attach after a restart. */
  pid?: number;
  outFile?: string;
  filePos?: number;
  startedAt?: number;
  timeoutAt?: number;
}

interface PersistedEvents {
  version: 1;
  inbox: InboxSnapshot;
  live: LiveWorkRef[];
}

const SAVE_DEBOUNCE_MS = 300;

function fileFor(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.events.json`);
}

/**
 * Wire debounced persistence to an inbox. Returns a `flush` for deterministic saves (tests,
 * shutdown). `live()` is sampled at save time so the roster always matches the moment of the
 * crash, not the moment of wiring.
 */
export function persistInbox(
  dir: string,
  sessionId: string,
  inbox: EventInbox,
  live: () => LiveWorkRef[],
): { flush: () => Promise<void> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing = Promise.resolve();

  const save = (): Promise<void> => {
    // Serialize writes: a save never observes a half-written predecessor (temp + rename).
    writing = writing.then(async () => {
      const doc: PersistedEvents = { version: 1, inbox: inbox.snapshot(), live: live() };
      await mkdir(dir, { recursive: true });
      const path = fileFor(dir, sessionId);
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(doc), "utf8");
      await rename(tmp, path);
    });
    return writing;
  };

  inbox.onMutate = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void save();
    }, SAVE_DEBOUNCE_MS);
    timer.unref?.();
  };

  return {
    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return save();
    },
  };
}

/**
 * Restore a previous run's state into `inbox`: pending events re-queue (delivered ids stay
 * deduped), and each roster entry resolves by what actually happened while we were down:
 *
 * - durable monitor, process STILL ALIVE  → `opts.adopt` re-attaches it (no event; work resumes)
 * - durable monitor, process finished     → ONE complete event with the output tail from its file
 * - anything else (died with the old CLI) → ONE interrupted error event
 *
 * All synthetic ids enter the same `seen` filter, so repeated restores stay idempotent.
 */
export async function restoreInbox(
  dir: string,
  sessionId: string,
  inbox: EventInbox,
  opts?: {
    /** Re-attach a live durable monitor. Return true when adopted (suppresses any event). */
    adopt?: (ref: LiveWorkRef & { pid: number; outFile: string }) => boolean;
  },
): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(fileFor(dir, sessionId), "utf8");
  } catch {
    return 0; // nothing persisted for this session
  }
  let doc: PersistedEvents;
  try {
    doc = JSON.parse(raw) as PersistedEvents;
  } catch {
    // A torn file means the machine died mid-write of the temp copy's rename target — drop it
    // loudly rather than resurrect garbage.
    await unlink(fileFor(dir, sessionId)).catch(() => {});
    return 0;
  }
  inbox.preload(doc.inbox);
  let restored = doc.inbox.pending.length;
  for (const ref of doc.live) {
    if (ref.pid !== undefined && ref.outFile !== undefined) {
      if (isAlive(ref.pid) && opts?.adopt?.({ ...ref, pid: ref.pid, outFile: ref.outFile })) {
        continue; // re-attached — it reports through the normal monitor path from here on
      }
      // Finished (or unadoptable) while we were down: deliver its outcome, not a blind loss.
      const tail = await readFile(ref.outFile, "utf8").then(
        (s) => s.slice(Math.max(0, ref.filePos ?? 0)).slice(-2_000).trimEnd(),
        () => "",
      );
      const accepted = inbox.emit({
        id: `${ref.id}#offline-end`,
        source: ref.id,
        sourceType: ref.kind,
        kind: "complete",
        label: ref.label,
        body:
          `${ref.id} (${ref.kind} "${ref.label}") finished while ${host().name} was not running ` +
          `(exit status unknown).` +
          (tail ? ` Output after the last delivered point:\n${tail}` : " (no further output.)"),
        ts: Date.now(),
      });
      if (accepted) restored++;
      await unlink(ref.outFile).catch(() => {});
      continue;
    }
    const accepted = inbox.emit({
      id: `${ref.id}#interrupted`,
      source: ref.id,
      sourceType: ref.kind,
      kind: "error",
      label: ref.label,
      body:
        `${ref.id} (${ref.kind} "${ref.label}") was still running when the previous ${host().name} process ` +
        `exited, and did not survive the restart. Start it again if it's still needed.`,
      ts: Date.now(),
    });
    if (accepted) restored++;
  }
  return restored;
}

/** True when a process with this pid exists (signal 0 probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
