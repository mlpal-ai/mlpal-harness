import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@mlpal/harness-protocol";
import { JsonLogger } from "../src/obs/logger";
import { BLOB_THRESHOLD } from "../src/store/blobs";
import { LocalStore } from "../src/store/local";
import { EventTooLargeError } from "../src/store/remote/batcher";
import { LeaseLostError, SeqConflictError, SessionStoreClient } from "../src/store/remote/client";
import { LeaseKeeper } from "../src/store/remote/lease";
import { MailboxUnavailableError, RemoteStore, type RemoteStoreOptions, SessionMismatchError } from "../src/store/remote/remote-store";
import type { LogChannel, MemoryStore, SessionRecord, Store } from "../src/store/types";
import { FakeClock } from "./fake-clock";
import { type FakeSessionStore, startFakeSessionStore } from "./fake-session-store";

let fake: FakeSessionStore;
let root: string;

beforeEach(() => {
  fake = startFakeSessionStore();
  fake.createSession("s1");
  root = mkdtempSync(join(tmpdir(), "yodex-remote-store-"));
});
afterEach(async () => {
  await fake.stop();
  rmSync(root, { recursive: true, force: true });
});

const memory: MemoryStore = {
  readIndex: async () => "index",
  writeTopic: async () => {},
  readTopic: async (name) => `topic ${name}`,
  listTopics: async () => ["a"],
};

async function openRemote(over: Partial<RemoteStoreOptions> = {}): Promise<{ store: RemoteStore; lease: LeaseKeeper }> {
  // Control leases; the engine is handed the lease and a token scoped to it.
  const g = fake.grant("s1", { ttlS: 30 });
  const client = new SessionStoreClient({ baseUrl: fake.url, tokenProvider: () => g.token });
  const lease = new LeaseKeeper({ client, sid: "s1", ttlS: 30 });
  lease.adopt({ leaseId: g.leaseId });
  const store = new RemoteStore({ client, sid: "s1", lease, memory, artifactsDir: join(root, "artifacts"), ...over });
  await store.open();
  return { store, lease };
}

const record: SessionRecord = {
  sessionId: "s1",
  agentId: "a1",
  workspace: "w",
  cwd: "/w",
  status: "active",
  head: null,
  model: "m",
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
};

const CHANNELS: LogChannel[] = ["exec", "model", "events"];

/** One run's worth of writes, the same for every backend. */
async function script(store: Store): Promise<void> {
  await store.registry.putSession(record);
  await store.logs.write("s1", "events", { kind: "run.start", run: "r1" });
  const sys = await store.conversation.append("s1", { type: "system", subtype: "init", sessionId: "s1", agentId: "a1", model: "m", cwd: "/w", ts: "t0" } as SDKMessage, null);
  const user = await store.conversation.append("s1", { type: "user", message: { role: "user", content: "hi" }, author: { type: "human" }, ts: "t1" } as SDKMessage, sys.uuid);
  await store.logs.write("s1", "model", { kind: "model.call", tokens: 12 });
  const asst = await store.conversation.append("s1", { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] }, usage: { input_tokens: 3, output_tokens: 4 }, stopReason: "tool_use", model: "m", ts: "t2" } as SDKMessage, user.uuid);
  await store.logs.write("s1", "exec", { kind: "tool.run", tool: "Bash", ms: 3 });
  const tr = await store.conversation.append("s1", { type: "tool_result", toolUseId: "tu1", content: "a\nb", isError: false, ts: "t3" } as SDKMessage, asst.uuid);
  const res = await store.conversation.append("s1", { type: "result", subtype: "success", usage: { input_tokens: 3, output_tokens: 4 }, ts: "t4" } as unknown as SDKMessage, tr.uuid);
  await store.registry.patchSession("s1", { status: "idle", head: res.uuid, name: "named" });
  await store.registry.patchSession("s1", { mode: "plan" });
  await store.logs.write("s1", "events", { kind: "run.end", run: "r1" });
  const rewind = await store.conversation.append("s1", { type: "rewind", toUuid: user.uuid, turn: 1, ts: "t5" }, res.uuid);
  const compact = await store.conversation.append("s1", { type: "compact", summary: "we listed the files", trigger: "manual", replacedMessages: 4, ts: "t6" }, rewind.uuid);
  const sub = await store.conversation.append(
    "s1",
    { type: "subagent", kind: "start", toolUseId: "tu2", childSessionId: "child-1", description: "list the files", background: false, ts: "t7" },
    compact.uuid,
  );
  // Over the blob threshold: LocalStore keeps it beside the file and rebuilds it on read; the store holds it inline.
  const image = Buffer.alloc(BLOB_THRESHOLD * 2, 7).toString("base64");
  const withImage = await store.conversation.append(
    "s1",
    { type: "user", message: { role: "user", content: [{ type: "text", text: "and this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: image } }] }, author: { type: "human" }, ts: "t8" } as SDKMessage,
    sub.uuid,
  );
  await store.registry.patchSession("s1", { head: withImage.uuid });
}

/** The backend-neutral view: entry ids become positions, wall-clock stamps are dropped. */
async function views(store: Store) {
  const entries = await store.conversation.read("s1");
  const at = new Map(entries.map((e, i) => [e.uuid, i]));
  const logs: Record<string, unknown[]> = {};
  for (const c of CHANNELS) logs[c] = (await store.logs.read("s1", c)).map(({ ts, ...r }) => (expect(typeof ts).toBe("string"), r));
  const session = await store.registry.getSession("s1");
  const { updatedAt, ...rest } = session!;
  const sessionView = { ...rest, head: rest.head === null ? null : at.get(rest.head) };
  return {
    conversation: entries.map((e) => ({
      parent: e.parentUuid === null ? null : at.get(e.parentUuid),
      payload: e.payload.type === "rewind" ? { ...e.payload, toUuid: e.payload.toUuid === null ? null : at.get(e.payload.toUuid) } : e.payload,
    })),
    head: at.get((await store.conversation.head("s1"))!),
    logs,
    session: sessionView,
    sessions: (await store.registry.listSessions()).length,
  };
}

describe("RemoteStore: the contract with LocalStore", () => {
  test("the same appends, log writes and registry patches read back the same from both backends, also after a fresh open()", async () => {
    const local = new LocalStore(join(root, "local"));
    await script(local);
    await local.close();
    const { store: remote } = await openRemote();
    await script(remote);
    const want = await views(new LocalStore(join(root, "local")));
    expect(want.conversation.map((e) => (e.payload as { type: string }).type)).toEqual(["system", "user", "assistant", "tool_result", "result", "rewind", "compact", "subagent", "user"]);
    expect(await views(remote)).toEqual(want);
    await remote.close();
    const { store: reopened } = await openRemote();
    expect(await views(reopened)).toEqual(want);
    await reopened.close();
  });

  test("open() on a pre-filled store restores the same views, uuids and stamps included", async () => {
    const first = await openRemote();
    await script(first.store);
    const before = {
      read: await first.store.conversation.read("s1"),
      head: await first.store.conversation.head("s1"),
      logs: await Promise.all(CHANNELS.map((c) => first.store.logs.read("s1", c))),
      session: await first.store.registry.getSession("s1"),
    };
    await first.store.close();
    const { store: again } = await openRemote();
    expect(await again.conversation.read("s1")).toEqual(before.read);
    expect(await again.conversation.head("s1")).toBe(before.head);
    expect(await Promise.all(CHANNELS.map((c) => again.logs.read("s1", c)))).toEqual(before.logs);
    expect(await again.registry.getSession("s1")).toEqual(before.session);
    expect(again.lastSeq).toBe(fake.events("s1").length);
    expect(again.events().map((e) => e.seq)).toEqual(fake.events("s1").map((e) => e.seq));
    await again.close();
  });

  test("the wire: entries as kind = payload.type with the entry as data; logs and records as their own kinds", async () => {
    const { store } = await openRemote();
    await script(store);
    await store.flush();
    const kinds = fake.events("s1").map((e) => e.kind);
    expect(kinds).toEqual(["record", "log", "system", "user", "log", "assistant", "log", "tool_result", "result", "record", "record", "log", "rewind", "compact", "subagent", "user", "record"]);
    const user = fake.events("s1")[3]!.data as { uuid: string; parentUuid: string; payload: { type: string } };
    expect(user.payload.type).toBe("user");
    expect(user.parentUuid).toBe((fake.events("s1")[2]!.data as { uuid: string }).uuid);
    expect(fake.events("s1")[1]!.data).toMatchObject({ channel: "events", record: { kind: "run.start", run: "r1" } });
    expect(fake.events("s1")[9]!.data).toMatchObject({ status: "idle", name: "named" });
    expect(fake.events("s1")[9]!.data).not.toHaveProperty("sessionId");
    await store.close();
  });

  test("reads include what is still queued; tails page by cursor", async () => {
    const { store } = await openRemote();
    const a = await store.conversation.append("s1", { type: "user", message: { role: "user", content: "x" }, author: { type: "human" }, ts: "t" } as SDKMessage, null);
    await store.logs.write("s1", "events", { kind: "k1" });
    expect(fake.events("s1")).toHaveLength(0); // nothing has reached the store yet
    expect((await store.conversation.read("s1")).map((e) => e.uuid)).toEqual([a.uuid]);
    expect(await store.conversation.head("s1")).toBe(a.uuid);
    const t1 = await store.conversation.tail!("s1", 0);
    expect(t1.entries.map((e) => e.uuid)).toEqual([a.uuid]);
    const b = await store.conversation.append("s1", { type: "assistant", message: { role: "assistant", content: "y" }, ts: "t" } as SDKMessage, a.uuid);
    expect((await store.conversation.tail!("s1", t1.cursor)).entries.map((e) => e.uuid)).toEqual([b.uuid]);
    const l1 = await store.logs.tail!("s1", "events", 0);
    expect(l1.records.map((r) => r.kind)).toEqual(["k1"]);
    await store.logs.write("s1", "events", { kind: "k2" });
    expect((await store.logs.tail!("s1", "events", l1.cursor)).records.map((r) => r.kind)).toEqual(["k2"]);
    await store.close();
    expect(fake.events("s1")).toHaveLength(4);
  });

  test("host kinds: appendEvent resolves to the seq; events() and lastSeq carry them; conversation and logs skip them", async () => {
    const { store } = await openRemote();
    await store.conversation.append("s1", { type: "user", message: { role: "user", content: "x" }, author: { type: "human" }, ts: "t" } as SDKMessage, null);
    const seq = await store.appendEvent("s1", "tool_started", { toolUseId: "tu1", name: "Bash" });
    expect(seq).toBe(2);
    void store.appendEvent("s1", "text_delta", { type: "text_delta", text: "partial" });
    await store.flush();
    expect(store.lastSeq).toBe(3);
    expect(store.events().map((e) => [e.seq, e.kind])).toEqual([[1, "user"], [2, "tool_started"], [3, "text_delta"]]);
    await store.close();
    const { store: again } = await openRemote();
    expect(await again.conversation.read("s1")).toHaveLength(1);
    expect(again.events().find((e) => e.kind === "tool_started")?.data).toEqual({ toolUseId: "tu1", name: "Bash" });
    expect(await again.logs.read("s1", "events")).toEqual([]);
    await again.close();
  });

  test("reads hand out copies: changing what read returned, or the payload after append, changes nothing stored", async () => {
    const { store } = await openRemote();
    const payload = { type: "user", message: { role: "user", content: "x" }, author: { type: "human" }, ts: "t" } as SDKMessage & { ts: string };
    await store.conversation.append("s1", payload, null);
    payload.ts = "changed";
    const first = await store.conversation.read("s1");
    (first[0]!.payload as { ts: string }).ts = "changed too";
    expect(((await store.conversation.read("s1"))[0]!.payload as { ts: string }).ts).toBe("t");
    await store.logs.write("s1", "events", { kind: "k" });
    (await store.logs.read("s1", "events"))[0]!.kind = "changed";
    expect((await store.logs.read("s1", "events"))[0]!.kind).toBe("k");
    await store.registry.putSession(record);
    (await store.registry.getSession("s1"))!.status = "error";
    expect((await store.registry.getSession("s1"))!.status).toBe("active");
    await store.close();
  });

  test("an event over maxEventBytes is refused before it is queued: EventTooLargeError, no memory entry, the session goes on", async () => {
    const fatals: Error[] = [];
    const { store } = await openRemote({ maxEventBytes: 64 * 1024, onFatal: (e) => fatals.push(e) });
    const a = await store.conversation.append("s1", { type: "user", message: { role: "user", content: "a" }, author: { type: "human" }, ts: "t" } as SDKMessage, null);
    const big = { type: "tool_result", toolUseId: "tu1", content: "x".repeat(100 * 1024), isError: false, ts: "t" } as SDKMessage;
    const err = await store.conversation.append("s1", big, a.uuid).catch((e) => e);
    expect(err).toBeInstanceOf(EventTooLargeError);
    expect(err).toMatchObject({ limit: 64 * 1024 });
    expect(await store.logs.write("s1", "events", { blob: "y".repeat(100 * 1024) }).catch((e) => e)).toBeInstanceOf(EventTooLargeError);
    expect((await store.conversation.read("s1")).map((e) => e.uuid)).toEqual([a.uuid]);
    expect(await store.conversation.head("s1")).toBe(a.uuid);
    expect(await store.logs.read("s1", "events")).toEqual([]);
    await store.conversation.append("s1", { type: "assistant", message: { role: "assistant", content: "ok" }, ts: "t" } as SDKMessage, a.uuid);
    await store.close();
    expect(fatals).toEqual([]);
    expect(fake.events("s1").map((e) => e.kind)).toEqual(["user", "assistant"]);
  });

  test("an event that goes alone is acknowledged before append returns: the store's event_too_large rejects it, the limit is learned, the writer goes on", async () => {
    await fake.stop();
    fake = startFakeSessionStore({ maxEventBytes: 1536 * 1024 });
    fake.createSession("s1");
    const logs: Record<string, unknown>[] = [];
    const { store } = await openRemote({ logger: new JsonLogger({ level: "debug", sink: (line) => void logs.push(JSON.parse(line)) }) });
    const a = await store.conversation.append("s1", { type: "user", message: { role: "user", content: "a" }, author: { type: "human" }, ts: "t" } as SDKMessage, null);
    const err = await store.conversation
      .append("s1", { type: "tool_result", toolUseId: "tu1", content: "x".repeat(2 * 1024 * 1024), isError: false, ts: "t" } as SDKMessage, a.uuid)
      .catch((e) => e);
    expect(err).toBeInstanceOf(EventTooLargeError);
    expect(err).toMatchObject({ limit: 1536 * 1024 });
    expect((await store.conversation.read("s1")).map((e) => e.uuid)).toEqual([a.uuid]);
    expect(await store.appendEvent("s1", "tool_result", "x".repeat(2 * 1024 * 1024)).catch((e) => e)).toBeInstanceOf(EventTooLargeError); // learned
    await store.appendEvent("s1", "tool_started", { toolUseId: "tu2" });
    await store.close();
    expect(fake.events("s1").map((e) => e.kind)).toEqual(["user", "tool_started"]);
    expect(logs.filter((l) => l.msg === "store.event_dropped")).toEqual([]); // the caller was told: no hole
  });

  test("an event that shared a batch and is refused later leaves memory and is logged as store.event_dropped", async () => {
    await fake.stop();
    fake = startFakeSessionStore({ maxEventBytes: 512 * 1024 });
    fake.createSession("s1");
    const logs: Record<string, unknown>[] = [];
    const { store } = await openRemote({ logger: new JsonLogger({ level: "debug", sink: (line) => void logs.push(JSON.parse(line)) }) });
    const a = await store.conversation.append("s1", { type: "user", message: { role: "user", content: "a" }, author: { type: "human" }, ts: "t" } as SDKMessage, null);
    await store.flush();
    const big = await store.conversation.append("s1", { type: "tool_result", toolUseId: "tu1", content: "x".repeat(600 * 1024), isError: false, ts: "t" } as SDKMessage, a.uuid);
    expect((await store.conversation.read("s1")).map((e) => e.uuid)).toEqual([a.uuid, big.uuid]); // not known to be too large yet
    await store.flush();
    expect((await store.conversation.read("s1")).map((e) => e.uuid)).toEqual([a.uuid]);
    await store.close();
    const dropped = logs.filter((l) => l.msg === "store.event_dropped");
    expect(dropped).toEqual([expect.objectContaining({ level: "error", sid: "s1", uuid: big.uuid, kind: "tool_result", limit: 512 * 1024 })]);
  });

  test("mailbox: post is refused with a clear error; peek and drain are empty", async () => {
    const { store } = await openRemote();
    const msg = { from: "s2", body: "hi" } as never;
    await expect(store.mailbox.post("s9", msg)).rejects.toBeInstanceOf(MailboxUnavailableError);
    await expect(store.mailbox.post("s1", msg)).rejects.toThrow("cross-session mail is not available in remote store mode (phase 2)");
    expect(await store.mailbox.peek("s1")).toEqual([]);
    expect(await store.mailbox.drain("s1")).toEqual([]);
    await store.close();
  });

  test("any other session id is refused with SessionMismatchError", async () => {
    const { store } = await openRemote();
    const other = "s2";
    const calls: (() => Promise<unknown>)[] = [
      () => store.conversation.append(other, { type: "user" } as SDKMessage, null),
      () => store.conversation.read(other),
      () => store.conversation.head(other),
      () => store.conversation.tail!(other, 0),
      () => store.logs.write(other, "events", {}),
      () => store.logs.read(other, "events"),
      () => store.logs.tail!(other, "events", 0),
      () => store.registry.putSession({ ...record, sessionId: other }),
      () => store.registry.patchSession(other, {}),
      () => store.registry.getSession(other),
      () => store.mailbox.peek(other),
      () => store.mailbox.drain(other),
      async () => store.artifactPath(other, "x"),
    ];
    for (const call of calls) expect(await call().catch((e) => e)).toBeInstanceOf(SessionMismatchError);
    expect(fake.events("s1")).toEqual([]);
    await store.close();
  });

  test("memory delegates; artifacts live under artifactsDir/<sid>; agents stay in memory", async () => {
    const { store } = await openRemote();
    expect(store.memory).toBe(memory);
    expect(store.artifactPath("s1", "pre.bin")).toBe(join(root, "artifacts", "s1", "pre.bin"));
    await store.registry.putAgent({ agentId: "a1", displayName: "A", createdAt: "t", lastSeen: "t" });
    expect((await store.registry.listAgents()).map((a) => a.agentId)).toEqual(["a1"]);
    expect(await store.registry.getSession("s1")).toBeNull();
    expect(await store.registry.listSessions()).toEqual([]);
    await store.registry.patchSession("s1", { status: "idle" }); // no record yet: a no-op, as in LocalStore
    expect(await store.registry.getSession("s1")).toBeNull();
    await store.flush();
    expect(fake.events("s1")).toEqual([]);
    await store.close();
  });

  test("close() flushes, then releases the lease; a failed release is logged, not thrown", async () => {
    const { store } = await openRemote();
    await store.logs.write("s1", "events", { kind: "last" });
    await store.close();
    expect(fake.events("s1")).toHaveLength(1);
    expect(fake.lease("s1")).toBeNull();

    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m), error: () => {}, info: () => {}, debug: () => {}, log: () => {}, child: () => logger } as never;
    const { store: again } = await openRemote({ logger });
    fake.failNext("release", 503, "store_unavailable");
    await again.close();
    expect(warnings.join("\n")).toContain("release");
  });

  test("a lost lease surfaces to every later write as the LeaseLostError, for the host's exit 76", async () => {
    await fake.stop();
    const clock = new FakeClock();
    fake = startFakeSessionStore({ clock: clock.now });
    fake.createSession("s1");
    const g = fake.grant("s1", { ttlS: 30 });
    const client = new SessionStoreClient({ baseUrl: fake.url, tokenProvider: () => g.token });
    const lease = new LeaseKeeper({ client, sid: "s1", ttlS: 30, timers: clock });
    const fatals: Error[] = [];
    const store = new RemoteStore({ client, sid: "s1", lease, memory, artifactsDir: join(root, "artifacts"), onFatal: (e) => fatals.push(e) });
    await store.open();
    lease.adopt({ leaseId: g.leaseId });
    while (clock.pending() < 2) await new Promise((r) => setTimeout(r, 1)); // the first renew landed
    fake.failNext("renew", 409, "lease_lost");
    clock.advance(10_000);
    while (!lease.signal.aborted) await new Promise((r) => setTimeout(r, 1));
    await store.logs.write("s1", "events", { kind: "after the loss" });
    await expect(store.flush()).rejects.toBeInstanceOf(LeaseLostError);
    expect(fatals[0]).toBeInstanceOf(LeaseLostError);
    await expect(store.conversation.append("s1", { type: "user" } as SDKMessage, null)).rejects.toBeInstanceOf(LeaseLostError);
    expect(fake.events("s1")).toEqual([]);
  });

  test("a fatal append ends the session for this engine: onFatal once, and every later write throws", async () => {
    const fatals: Error[] = [];
    const { store } = await openRemote({ onFatal: (e) => fatals.push(e) });
    fake.failNext("append", 409, "seq_conflict");
    await store.logs.write("s1", "events", { kind: "k" });
    await expect(store.flush()).rejects.toBeInstanceOf(SeqConflictError);
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toBeInstanceOf(SeqConflictError);
    await expect(store.conversation.append("s1", { type: "user" } as SDKMessage, null)).rejects.toBeInstanceOf(SeqConflictError);
    await expect(store.logs.write("s1", "events", {})).rejects.toBeInstanceOf(SeqConflictError);
    await expect(store.registry.patchSession("s1", {})).rejects.toBeInstanceOf(SeqConflictError);
    await expect(store.appendEvent("s1", "x", {})).rejects.toBeInstanceOf(SeqConflictError);
    await expect(store.close()).rejects.toBeInstanceOf(SeqConflictError);
    expect(fake.lease("s1")).toBeNull(); // released all the same
    expect(fake.events("s1")).toEqual([]);
  });
});
