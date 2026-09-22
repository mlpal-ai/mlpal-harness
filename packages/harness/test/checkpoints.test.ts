import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore } from "../src/checkpoints/store";
import { effectiveEntries } from "../src/loop/messages";
import type { ConversationEntry } from "@mlpal/harness-protocol";

function tmp(): { ws: string; cp: CheckpointStore } {
  const root = mkdtempSync(join(tmpdir(), "cp-"));
  const ws = join(root, "ws");
  mkdirSync(ws);
  return { ws, cp: new CheckpointStore(join(root, "checkpoints")) };
}

describe("CheckpointStore", () => {
  test("turns are dense and carry the head to replay up to; first touch per turn per path is the pre-image", async () => {
    const { ws, cp } = tmp();
    const a = join(ws, "a.txt");
    writeFileSync(a, "v0");
    expect(await cp.beginTurn("first prompt", null)).toBe(1);
    await cp.snapshot(1, a);
    writeFileSync(a, "v1");
    await cp.snapshot(1, a); // same turn again: ignored, v0 stays the pre-image
    writeFileSync(a, "v1b");
    expect(await cp.beginTurn("second prompt with   spaces", "uuid-1")).toBe(2);
    await cp.snapshot(2, a);
    writeFileSync(a, "v2");
    const list = await cp.list();
    expect(list.map((t) => [t.turn, t.toUuid, t.files])).toEqual([[1, null, 1], [2, "uuid-1", 1]]);
    expect(list[1]!.prompt).toBe("second prompt with spaces");
    const r = await cp.rewind(2);
    expect(r.restored).toEqual([a]);
    expect(readFileSync(a, "utf8")).toBe("v1b"); // before turn 2, not before turn 1
    expect(r.toUuid).toBe("uuid-1");
    expect((await cp.list()).length).toBe(1); // turn 2 forgotten
    const r1 = await cp.rewind(1);
    expect(readFileSync(a, "utf8")).toBe("v0");
    expect(r1.toUuid).toBeNull();
    expect(await cp.list()).toEqual([]);
  });

  test("a file created during a turn is deleted on rewind; blobs are shared by content", async () => {
    const { ws, cp } = tmp();
    const created = join(ws, "new", "deep", "b.txt");
    const c = join(ws, "c.txt");
    writeFileSync(c, "same");
    await cp.beginTurn("p", null);
    await cp.snapshot(1, created); // absent before
    await cp.snapshot(1, c);
    mkdirSync(join(ws, "new", "deep"), { recursive: true });
    writeFileSync(created, "made");
    writeFileSync(c, "changed");
    await cp.beginTurn("p2", "u1");
    writeFileSync(c, "same"); // back to the original content: same blob
    await cp.snapshot(2, c);
    const files = await cp.files();
    expect(files.find((f) => f.path === created)!.blob).toBeNull();
    expect(files.filter((f) => f.path === c).map((f) => f.blob)).toEqual([files[1]!.blob, files[1]!.blob]);
    const r = await cp.rewind(1);
    expect(r.deleted).toEqual([created]);
    expect(existsSync(created)).toBe(false);
    expect(readFileSync(c, "utf8")).toBe("same");
  });

  test("rewinding to an unknown turn is an error naming the range", async () => {
    const { cp } = tmp();
    await cp.beginTurn("p", null);
    await expect(cp.rewind(3)).rejects.toThrow("no checkpoint for turn 3 (have 1..1)");
  });
});

describe("effectiveEntries (rewind boundary in replay)", () => {
  const e = (uuid: string, type: "user" | "assistant" | "rewind" | "compact", extra: Record<string, unknown> = {}): ConversationEntry =>
    ({ uuid, parentUuid: null, ts: "t", payload: { type, ...extra } } as unknown as ConversationEntry);
  test("drops everything after the target, composes, and a null target drops all", () => {
    const entries = [e("1", "user"), e("2", "assistant"), e("3", "user"), e("4", "assistant"), e("r1", "rewind", { toUuid: "2", turn: 2 }), e("5", "user"), e("6", "assistant"), e("r2", "rewind", { toUuid: "5", turn: 3 }), e("7", "user")];
    expect(effectiveEntries(entries).map((x) => x.uuid)).toEqual(["1", "2", "5", "7"]);
    expect(effectiveEntries([e("1", "user"), e("r", "rewind", { toUuid: null, turn: 1 }), e("2", "user")]).map((x) => x.uuid)).toEqual(["2"]);
  });
  test("an unknown target rewinds nothing; a rewind crosses a compaction boundary", () => {
    expect(effectiveEntries([e("1", "user"), e("r", "rewind", { toUuid: "zzz", turn: 9 })]).map((x) => x.uuid)).toEqual(["1"]);
    const across = [e("1", "user"), e("c", "compact", { summary: "s" }), e("2", "user"), e("r", "rewind", { toUuid: "1", turn: 1 })];
    expect(effectiveEntries(across).map((x) => x.uuid)).toEqual(["1"]);
  });
});
