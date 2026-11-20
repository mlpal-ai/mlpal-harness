import { describe, expect, test } from "bun:test";
import type { PeerMessage } from "@mlpal/harness-protocol";
import { createPeerTools, livePeers, resolvePeer, wakeCandidates } from "../src/tools/builtin/peers";
import { renderEvents, type AgentEvent } from "../src/events/inbox";
import { BackgroundAgents } from "../src/subagent/background";
import type { SessionRecord } from "../src/store/types";

const now = () => new Date().toISOString();
const stale = () => new Date(Date.now() - 10 * 60_000).toISOString();

function rec(over: Partial<SessionRecord>): SessionRecord {
  return {
    sessionId: crypto.randomUUID(),
    agentId: "local",
    workspace: "repo",
    cwd: "/tmp/repo",
    status: "listening",
    head: null,
    model: "claude-opus-5",
    createdAt: now(),
    updatedAt: now(),
    ...over,
  };
}

describe("livePeers", () => {
  test("keeps fresh active/listening; drops self, stale, idle, done", () => {
    const self = rec({ workspace: "me" });
    const sessions = [
      self,
      rec({ workspace: "fresh-listening" }),
      rec({ workspace: "fresh-active", status: "active" }),
      rec({ workspace: "stale-active", status: "active", updatedAt: stale() }),
      rec({ workspace: "idle", status: "idle" }),
      rec({ workspace: "done", status: "done" }),
    ];
    const names = livePeers(sessions, self.sessionId).map((p) => p.workspace);
    expect(names.sort()).toEqual(["fresh-active", "fresh-listening"]);
  });

  test("a fresh-looking record whose pid is dead is a ghost — excluded instantly", () => {
    const ghost = rec({ workspace: "killed", pid: 4999999 });
    const live = rec({ workspace: "alive", pid: 12345 });
    const noPid = rec({ workspace: "legacy" });
    const isAlive = (pid: number) => pid === 12345;
    const names = livePeers([ghost, live, noPid], "self", isAlive).map((p) => p.workspace);
    expect(names.sort()).toEqual(["alive", "legacy"]);
  });
});

describe("resolvePeer", () => {
  const a = rec({ workspace: "backend", sessionId: "aaaa1111-0000-0000-0000-000000000000" });
  const b = rec({ workspace: "frontend", sessionId: "bbbb2222-0000-0000-0000-000000000000" });
  const b2 = rec({ workspace: "frontend", sessionId: "cccc3333-0000-0000-0000-000000000000" });

  test("workspace name resolves when unique; ambiguity names the candidates", () => {
    expect(resolvePeer([a, b], "backend").peer?.sessionId).toBe(a.sessionId);
    const amb = resolvePeer([a, b, b2], "frontend");
    expect(amb.peer).toBeUndefined();
    expect(amb.error).toContain("2 live sessions");
    expect(amb.error).toContain("bbbb2222");
  });

  test("session id prefix resolves; short/ambiguous prefixes are refused; miss explains", () => {
    expect(resolvePeer([a, b], "bbbb").peer?.sessionId).toBe(b.sessionId);
    expect(resolvePeer([a, b], a.sessionId).peer?.sessionId).toBe(a.sessionId);
    expect(resolvePeer([a, b], "zzz").error).toContain("no live session");
  });
});

describe("peer tools", () => {
  function build(sessions: SessionRecord[], posts: Array<{ sid: string; pm: PeerMessage }>) {
    const agents = new BackgroundAgents();
    const tools = createPeerTools({
      registry: {
        listSessions: async () => sessions,
      } as never,
      mailbox: {
        post: async (sid: string, pm: PeerMessage) => void posts.push({ sid, pm }),
        drain: async () => [],
        peek: async () => [],
      } as never,
      agents,
      selfSessionId: () => "self-0000",
      selfWorkspace: "my-repo",
    });
    return { tools, agents };
  }

  test("ListAgents shows peers with workspace, id8, status; empty case says so", async () => {
    const peer = rec({ workspace: "backend", status: "active" });
    const { tools } = build([peer], []);
    const list = tools.find((t) => t.name === "ListAgents")!;
    const out = (await list.call({}, {} as never)).content as string;
    expect(out).toContain("You are: my-repo [self-000"); // self-identity — correct reply address
    expect(out).toContain("backend");
    expect(out).toContain(peer.sessionId.slice(0, 8));
    expect(out).toContain("active");
    const empty = build([], []).tools.find((t) => t.name === "ListAgents")!;
    expect((await empty.call({}, {} as never)).content).toContain("No agents or live peer sessions");
  });

  test("SendMessage posts to the resolved peer's mailbox with this session's identity", async () => {
    const peer = rec({ workspace: "backend" });
    const posts: Array<{ sid: string; pm: PeerMessage }> = [];
    const { tools } = build([peer], posts);
    const send = tools.find((t) => t.name === "SendMessage")!;
    const r = await send.call({ to: "backend", message: "gateway deployed — re-run your smoke" }, {} as never);
    expect(r.isError).toBeUndefined();
    expect(posts.length).toBe(1);
    expect(posts[0]!.sid).toBe(peer.sessionId);
    expect(posts[0]!.pm.text).toContain("re-run your smoke");
    expect(posts[0]!.pm.from.displayName).toBe("my-repo");
    expect(posts[0]!.pm.from.id).toBe("sess-self-000");
  });

  test("SendMessage to an unknown target is an error, not a silent drop", async () => {
    const { tools } = build([], []);
    const send = tools.find((t) => t.name === "SendMessage")!;
    const r = await send.call({ to: "ghost", message: "hi" }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no live session");
  });

  test("SendMessage to a known-but-dead session queues the mail and WAKES it", async () => {
    const dead = rec({ workspace: "backend", status: "idle" });
    const posts: Array<{ sid: string; pm: PeerMessage }> = [];
    const woken: string[] = [];
    const agents = new BackgroundAgents();
    const tools = createPeerTools({
      registry: { listSessions: async () => [dead] } as never,
      mailbox: { post: async (sid: string, pm: PeerMessage) => void posts.push({ sid, pm }), drain: async () => [], peek: async () => [] } as never,
      agents,
      selfSessionId: () => "self-0000",
      selfWorkspace: "my-repo",
      wake: async (r) => {
        woken.push(r.sessionId);
        return "woke it (pid 123)";
      },
    });
    const send = tools.find((t) => t.name === "SendMessage")!;
    const r = await send.call({ to: "backend", message: "resume and check CI" }, {} as never);
    expect(r.isError).toBeUndefined();
    expect(posts[0]!.sid).toBe(dead.sessionId); // mail queued BEFORE wake — the child drains it
    expect(woken).toEqual([dead.sessionId]);
    expect(r.content).toContain("woke it");
  });

  test("without a wake hook, a dead-session send still queues with an honest note", async () => {
    const dead = rec({ workspace: "backend", status: "idle" });
    const posts: Array<{ sid: string; pm: PeerMessage }> = [];
    const { tools } = build([], posts);
    const toolsDead = createPeerTools({
      registry: { listSessions: async () => [dead] } as never,
      mailbox: { post: async (sid: string, pm: PeerMessage) => void posts.push({ sid, pm }), drain: async () => [], peek: async () => [] } as never,
      agents: new BackgroundAgents(),
      selfSessionId: () => "self-0000",
      selfWorkspace: "my-repo",
    });
    const send = toolsDead.find((t) => t.name === "SendMessage")!;
    const r = await send.call({ to: "backend", message: "hi" }, {} as never);
    expect(posts.length).toBe(1);
    expect(r.content).toContain("not running");
    void tools;
  });
});

describe("wake targeting quality (the 20-stale-sessions problem)", () => {
  const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  test("wakeCandidates: newest per repo, recency-bounded, live excluded", () => {
    const old1 = rec({ workspace: "frontend", cwd: "/w/frontend", updatedAt: days(5), status: "idle" });
    const old2 = rec({ workspace: "frontend", cwd: "/w/frontend", updatedAt: days(2), status: "idle" });
    const old3 = rec({ workspace: "frontend", cwd: "/w/frontend", updatedAt: days(9), status: "idle" });
    const ancient = rec({ workspace: "backend", cwd: "/w/backend", updatedAt: days(40), status: "idle" });
    const liveOne = rec({ workspace: "gateway", cwd: "/w/gateway", status: "listening" });
    const out = wakeCandidates([old1, old2, old3, ancient, liveOne], "self", new Set([liveOne.sessionId]));
    expect(out.length).toBe(1); // 3 frontend sessions collapse to the newest; ancient + live dropped
    expect(out[0]!.sessionId).toBe(old2.sessionId);
  });

  function buildWake(sessions: SessionRecord[]) {
    const posts: Array<{ sid: string }> = [];
    const woken: string[] = [];
    const tools = createPeerTools({
      registry: { listSessions: async () => sessions } as never,
      mailbox: { post: async (sid: string) => void posts.push({ sid }), drain: async () => [], peek: async () => [] } as never,
      agents: new BackgroundAgents(),
      selfSessionId: () => "self-0000",
      selfWorkspace: "my-repo",
      wake: async (r) => {
        woken.push(r.sessionId);
        return "woke";
      },
    });
    return { send: tools.find((t) => t.name === "SendMessage")!, posts, woken };
  }

  test("name wake picks the newest session of the ONE matching repo (yodex -c semantics)", async () => {
    const s1 = rec({ workspace: "frontend", cwd: "/w/frontend", updatedAt: days(3), status: "idle" });
    const s2 = rec({ workspace: "frontend", cwd: "/w/frontend", updatedAt: days(1), status: "idle" });
    const { send, woken } = buildWake([s1, s2]);
    const r = await send.call({ to: "frontend", message: "hi" }, {} as never);
    expect(r.isError).toBeUndefined();
    expect(woken).toEqual([s2.sessionId]);
  });

  test("name matching two different repos is refused with ids, never guessed", async () => {
    const a = rec({ workspace: "frontend", cwd: "/w/checkout-a", updatedAt: days(1), status: "idle" });
    const b = rec({ workspace: "frontend", cwd: "/w/checkout-b", updatedAt: days(2), status: "idle" });
    const { send, woken } = buildWake([a, b]);
    const r = await send.call({ to: "frontend", message: "hi" }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("2 different repos");
    expect(woken).toEqual([]);
  });

  test("stale-only name is refused with the explicit-id escape hatch; explicit id wakes any age", async () => {
    const ancient = rec({ workspace: "frontend", cwd: "/w/frontend", updatedAt: days(30), status: "idle" });
    const { send, woken } = buildWake([ancient]);
    const r = await send.call({ to: "frontend", message: "hi" }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("too stale");
    expect(r.content).toContain(ancient.sessionId.slice(0, 8));
    const byId = await send.call({ to: ancient.sessionId, message: "hi" }, {} as never);
    expect(byId.isError).toBeUndefined();
    expect(woken).toEqual([ancient.sessionId]);
  });

  test("ListAgents surfaces wakeable candidates so targeting is informed", async () => {
    const idle = rec({ workspace: "frontend", cwd: "/w/frontend", updatedAt: days(1), status: "idle" });
    const tools = createPeerTools({
      registry: { listSessions: async () => [idle] } as never,
      mailbox: { post: async () => {}, drain: async () => [], peek: async () => [] } as never,
      agents: new BackgroundAgents(),
      selfSessionId: () => "self-0000",
      selfWorkspace: "my-repo",
    });
    const out = (await tools.find((t) => t.name === "ListAgents")!.call({}, {} as never)).content as string;
    expect(out).toContain("not running");
    expect(out).toContain("frontend");
    expect(out).toContain("1d ago");
  });
});

// Ruling R18 (harness-e2e E-26): a confined (sandboxed) run can never cause unconfined execution elsewhere. Its
// SendMessage reaches a session only when that session runs confined too (the sandbox its loop recorded), and a wake
// it starts must be one that runs confined; otherwise nothing is posted. An unconfined sender is unchanged.
describe("R18: a confined sender never reaches an unconfined session", () => {
  function build(sessions: SessionRecord[], over: Partial<Parameters<typeof createPeerTools>[0]> = {}) {
    const log: string[] = [];
    const agents = new BackgroundAgents();
    const tools = createPeerTools({
      registry: { listSessions: async () => sessions } as never,
      mailbox: { post: async (sid: string) => void log.push(`post ${sid}`), drain: async () => [], peek: async () => [] } as never,
      agents,
      selfSessionId: () => "self-0000",
      selfWorkspace: "my-repo",
      confined: true,
      ...over,
    });
    return { send: tools.find((t) => t.name === "SendMessage")!, log, agents };
  }

  test("a live session with no sandbox on its record (or `none`) is refused, and nothing is posted", async () => {
    for (const peer of [rec({ workspace: "backend" }), rec({ workspace: "backend", sandbox: "none" })]) {
      const { send, log } = build([peer]);
      const r = await send.call({ to: "backend", message: "run the deploy" }, {} as never);
      expect(r.isError).toBe(true);
      expect(r.content).toBe(`not sent: this session runs sandboxed and backend [${peer.sessionId.slice(0, 8)}] does not, so a message from here could have commands run unconfined there. Ask the user to relay it.`);
      expect(log).toEqual([]);
    }
  });

  test("a live session that runs confined gets the message", async () => {
    for (const sandbox of ["seatbelt", "bwrap", "remote"] as const) {
      const peer = rec({ workspace: "backend", sandbox });
      const { send, log } = build([peer]);
      const r = await send.call({ to: "backend", message: "hi" }, {} as never);
      expect(r.isError).toBeUndefined();
      expect(log).toEqual([`post ${peer.sessionId}`]);
    }
  });

  test("a session that is not running is woken only by a wake that runs confined, decided before the post", async () => {
    const dead = rec({ workspace: "backend", status: "idle", sandbox: "seatbelt" });
    const woken = build([dead], {
      confinedWake: async (r) => ({
        start: async () => {
          woken.log.push(`start ${r.sessionId}`);
          return "woke it sandboxed (pid 7)";
        },
      }),
      wake: async () => {
        throw new Error("the unconfined wake must not run for a confined sender");
      },
    });
    const ok = await woken.send.call({ to: "backend", message: "hi" }, {} as never);
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toContain("woke it sandboxed (pid 7)");
    expect(woken.log).toEqual([`post ${dead.sessionId}`, `start ${dead.sessionId}`]);

    const refused = build([dead], { confinedWake: async () => ({ refused: "no sandbox can confine a woken session here" }) });
    const no = await refused.send.call({ to: "backend", message: "hi" }, {} as never);
    expect(no.isError).toBe(true);
    expect(no.content).toBe(`not sent to backend [${dead.sessionId.slice(0, 8)}]: this session runs sandboxed, and no sandbox can confine a woken session here. Ask the user to relay it.`);
    expect(refused.log).toEqual([]);
  });

  test("with no confined wake (a woken child, a host without one) nothing is left queued for a later run", async () => {
    const dead = rec({ workspace: "backend", status: "idle" });
    const { send, log } = build([dead], {
      wake: async () => {
        throw new Error("the unconfined wake must not run for a confined sender");
      },
    });
    const r = await send.call({ to: dead.sessionId, message: "hi" }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("it is not running, and a message left for its next run could be read by a run that is not sandboxed");
    expect(log).toEqual([]);
  });

  test("its own agents are steered as before (they run under the same sandbox)", async () => {
    const { send, agents } = build([]);
    const task = agents.track("a long search");
    const r = await send.call({ to: task.id, message: "narrow it" }, {} as never);
    expect(r.isError).toBeUndefined();
    expect(task.steerQueue).toEqual(["narrow it"]);
    agents.killAll();
  });

  test("an unconfined sender behaves exactly as before: live post, post-then-wake, queue with a note", async () => {
    const live = rec({ workspace: "frontend", cwd: "/w/frontend" });
    const dead = rec({ workspace: "backend", cwd: "/w/backend", status: "idle" });
    const never = async () => {
      throw new Error("the confined wake is a confined sender's");
    };
    const a = build([live, dead], { confined: false, confinedWake: never, wake: async () => "woke it (pid 123)" });
    expect((await a.send.call({ to: "frontend", message: "hi" }, {} as never)).content).toBe(
      `sent to frontend [${live.sessionId.slice(0, 8)}] — delivered at its next turn boundary (running) or idle wake. A reply, if any, arrives as a background event.`,
    );
    expect((await a.send.call({ to: "backend", message: "hi" }, {} as never)).content).toBe(`queued for backend [${dead.sessionId.slice(0, 8)}]; woke it (pid 123)`);
    expect(a.log).toEqual([`post ${live.sessionId}`, `post ${dead.sessionId}`]);
    const b = build([dead], { confined: false });
    expect((await b.send.call({ to: "backend", message: "hi" }, {} as never)).content).toBe(
      `queued for backend [${dead.sessionId.slice(0, 8)}] — it is not running; the message delivers when that session next runs.`,
    );
    expect(b.log).toEqual([`post ${dead.sessionId}`]);
  });
});

describe("renderEvents mail framing", () => {
  test("mail batches carry the teammate guidance line; non-mail batches do not", () => {
    const mail: AgentEvent = {
      id: "m1",
      source: "mlpal-backend",
      sourceType: "peer",
      kind: "mail",
      label: "mlpal-backend",
      body: "deployed 0.2.3 — links now canonical",
      ts: Date.now(),
    };
    const done: AgentEvent = {
      id: "d1",
      source: "bg1",
      sourceType: "shell",
      kind: "complete",
      label: "npm test",
      body: "ok",
      ts: Date.now(),
    };
    const withMail = renderEvents([mail, done]);
    expect(withMail).toContain('mlpal-backend (peer "mlpal-backend") says');
    expect(withMail).toContain("deployed 0.2.3");
    expect(withMail).toContain("teammate's request");
    expect(withMail).toContain("permission settings");
    const noMail = renderEvents([done]);
    expect(noMail).not.toContain("teammate's request");
  });
});

describe("parked ask outcome", () => {
  test("formatOutcome(parked) instructs park-and-summarize, not guess or re-ask", async () => {
    const { formatOutcome } = await import("../src/tools/builtin/ask");
    const txt = formatOutcome({ parked: true });
    expect(txt).toContain("PARKED");
    expect(txt).toContain("notification");
    expect(txt).toContain("Do not guess");
  });
});

describe("continue prefers human sessions", () => {
  test("routine-origin sessions never hijack yodex -c", async () => {
    const { LocalStore } = await import("../src/store/local");
    const { mostRecentSessionId } = await import("../src/store/sessions");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const store = new LocalStore(mkdtempSync(join(tmpdir(), "yodex-cont-")));
    const mk = async (sid: string, origin: string | undefined, updatedAt: string) => {
      await store.registry.putSession({
        sessionId: sid, agentId: "local", workspace: "w", cwd: "/repo",
        status: "idle", head: null, model: "m", createdAt: updatedAt, updatedAt, origin,
      } as never);
      // recentSessions reads conversations — seed one entry so the session is listed.
      await store.conversation.append(sid, { type: "system", subtype: "init", sessionId: sid, agentId: "local", model: "m", cwd: "/repo", ts: updatedAt } as never, null);
    };
    await mk("human-1", undefined, "2026-08-17T10:00:00Z");
    await mk("routine-1", "routine:tick", "2026-08-17T12:00:00Z"); // newer!
    const picked = await mostRecentSessionId(store, "/repo");
    expect(picked).toBe("human-1");
  });
});
