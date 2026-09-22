import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Checkpoints: the pre-image of every file the agent edits, taken the first time a turn touches
 * it, so a session can be rewound to any earlier turn. Content-addressed blobs (a file edited in
 * ten turns from the same base is stored once), one JSONL of turns and one of file touches, all
 * under the session's artifact dir. Only Write/Edit are tracked — a shell command's edits are
 * not, and /rewind says so. Rewinding to turn N restores each touched path to its state BEFORE
 * the earliest turn >= N that touched it (absent => deleted), and forgets those turns so a later
 * rewind sees a consistent ledger. The conversation side of a rewind is the host's `rewind`
 * record; this store only knows files.
 */
export interface CheckpointTurn {
  turn: number;
  ts: string;
  /** The user's prompt, clipped, for the picker. */
  prompt: string;
  /** Conversation head before this turn's user message: what a rewind replays up to. */
  toUuid: string | null;
}

export interface CheckpointFile {
  turn: number;
  path: string;
  /** Blob sha of the pre-image; null = the file did not exist before this turn. */
  blob: string | null;
  mode?: number;
}

export interface RewindResult {
  turn: number;
  toUuid: string | null;
  restored: string[];
  deleted: string[];
  /** Paths whose restore failed (unwritable dir, etc.), with the reason. */
  failed: { path: string; error: string }[];
}

const PROMPT_CLIP = 120;

export class CheckpointStore {
  constructor(private readonly dir: string) {}

  private get turnsFile(): string {
    return join(this.dir, "turns.jsonl");
  }
  private get filesFile(): string {
    return join(this.dir, "files.jsonl");
  }
  private blobPath(sha: string): string {
    return join(this.dir, "blobs", sha);
  }

  private async readJsonl<T>(file: string): Promise<T[]> {
    try {
      return (await readFile(file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T);
    } catch {
      return [];
    }
  }

  async turns(): Promise<CheckpointTurn[]> {
    return this.readJsonl<CheckpointTurn>(this.turnsFile);
  }
  async files(): Promise<CheckpointFile[]> {
    return this.readJsonl<CheckpointFile>(this.filesFile);
  }

  /** Start a turn; returns its number (1-based, dense). */
  async beginTurn(prompt: string, toUuid: string | null, now = new Date()): Promise<number> {
    const turn = (await this.turns()).length + 1;
    mkdirSync(this.dir, { recursive: true });
    const rec: CheckpointTurn = { turn, ts: now.toISOString(), prompt: prompt.replace(/\s+/g, " ").trim().slice(0, PROMPT_CLIP), toUuid };
    await appendFile(this.turnsFile, `${JSON.stringify(rec)}\n`);
    return turn;
  }

  /** Record `absPath`'s pre-image for `turn` — once per turn per path; later touches in the same
   *  turn are already covered by the first. Cheap when the turn already has it. */
  async snapshot(turn: number, absPath: string): Promise<void> {
    const files = await this.files();
    if (files.some((f) => f.turn === turn && f.path === absPath)) return;
    let rec: CheckpointFile;
    if (existsSync(absPath)) {
      const data = readFileSync(absPath);
      const sha = createHash("sha256").update(data).digest("hex");
      const blob = this.blobPath(sha);
      if (!existsSync(blob)) {
        mkdirSync(dirname(blob), { recursive: true });
        writeFileSync(blob, data);
      }
      rec = { turn, path: absPath, blob: sha, mode: statSync(absPath).mode & 0o777 };
    } else {
      rec = { turn, path: absPath, blob: null };
    }
    mkdirSync(this.dir, { recursive: true });
    await appendFile(this.filesFile, `${JSON.stringify(rec)}\n`);
  }

  /** Turns with how many files each touched, for the picker. */
  async list(): Promise<(CheckpointTurn & { files: number })[]> {
    const files = await this.files();
    return (await this.turns()).map((t) => ({ ...t, files: files.filter((f) => f.turn === t.turn).length }));
  }

  /** Restore the working tree to before `turn` and forget turns >= `turn`. */
  async rewind(turn: number): Promise<RewindResult> {
    const turns = await this.turns();
    const target = turns.find((t) => t.turn === turn);
    if (!target) throw new Error(`no checkpoint for turn ${turn} (have 1..${turns.length})`);
    const files = await this.files();
    // Earliest touch per path at or after the target turn is the pre-image to restore.
    const first = new Map<string, CheckpointFile>();
    for (const f of files) {
      if (f.turn < turn) continue;
      const seen = first.get(f.path);
      if (!seen || f.turn < seen.turn) first.set(f.path, f);
    }
    const res: RewindResult = { turn, toUuid: target.toUuid, restored: [], deleted: [], failed: [] };
    for (const f of first.values()) {
      try {
        if (f.blob === null) {
          if (existsSync(f.path)) unlinkSync(f.path);
          res.deleted.push(f.path);
        } else {
          mkdirSync(dirname(f.path), { recursive: true });
          writeFileSync(f.path, readFileSync(this.blobPath(f.blob)), { mode: f.mode });
          res.restored.push(f.path);
        }
      } catch (e) {
        res.failed.push({ path: f.path, error: String((e as Error)?.message ?? e) });
      }
    }
    // Forget the rewound turns; blobs stay (content-addressed, harmless, reusable).
    writeFileSync(this.turnsFile, turns.filter((t) => t.turn < turn).map((t) => `${JSON.stringify(t)}\n`).join(""));
    writeFileSync(this.filesFile, files.filter((f) => f.turn < turn).map((f) => `${JSON.stringify(f)}\n`).join(""));
    return res;
  }
}
