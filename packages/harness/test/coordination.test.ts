import { describe, expect, test } from "bun:test";
import {
  createHandoffTool,
  createListPeersTool,
  type HandoffRun,
  type PeerInfo,
} from "../src/subagent/coordination";
import { runTool, type ToolContext } from "../src/tools";
import { ToolRegistry } from "../src/tools/registry";

const ctx: ToolContext = { cwd: "/repos/frontend" };

const now = () => new Date().toISOString();
const PEERS: PeerInfo[] = [
  { sessionId: "aaaa1111", workspace: "frontend", cwd: "/repos/frontend", status: "active", model: "opus", updatedAt: now() },
  { sessionId: "bbbb2222", workspace: "backend", cwd: "/repos/backend", status: "idle", model: "gpt", updatedAt: now() },
];

function reg(...tools: Parameters<ToolRegistry["register"]>[0][]): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of tools) r.register(t);
  return r;
}

describe("ListPeers", () => {
  test("lists sessions in OTHER repos, excluding the current cwd", async () => {
    const r = reg(createListPeersTool(async () => PEERS));
    const out = await runTool(r, "ListPeers", {}, ctx);
    expect(out.content).toContain("backend");
    expect(out.content).toContain("bbbb2222");
    expect(out.content).not.toContain("frontend"); // same cwd → not a peer
  });

  test("handles no peers gracefully", async () => {
    const r = reg(createListPeersTool(async () => [PEERS[0]!])); // only the current repo
    const out = await runTool(r, "ListPeers", {}, ctx);
    expect(out.content).toContain("No agents/sessions in other repos");
  });

  test("bounded: stale idle sessions drop; many sessions per repo collapse to the newest", async () => {
    const stale = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const older = new Date(Date.now() - 3600_000).toISOString();
    const crowd: PeerInfo[] = [
      { sessionId: "old11111", workspace: "backend", cwd: "/repos/backend", status: "idle", model: "gpt", updatedAt: older },
      { sessionId: "new22222", workspace: "backend", cwd: "/repos/backend", status: "idle", model: "gpt", updatedAt: now() },
      { sessionId: "dead3333", workspace: "attic", cwd: "/repos/attic", status: "idle", model: "gpt", updatedAt: stale },
    ];
    const r = reg(createListPeersTool(async () => crowd));
    const out = String((await runTool(r, "ListPeers", {}, ctx)).content);
    expect(out).toContain("new22222"); // newest per repo survives
    expect(out).not.toContain("old11111"); // shadowed by newer sibling
    expect(out).not.toContain("attic"); // 30d-idle drops entirely
  });

  test("ignores a trailing slash when comparing cwds", async () => {
    const r = reg(createListPeersTool(async () => PEERS));
    const out = await runTool(r, "ListPeers", {}, { cwd: "/repos/frontend/" });
    expect(out.content).not.toContain("frontend");
    expect(out.content).toContain("backend");
  });
});

describe("HandoffTask", () => {
  test("delegates and reports the result + who handled it", async () => {
    const run: HandoffRun = async ({ repo, task }) => {
      expect(repo).toBe("backend");
      expect(task).toContain("add an endpoint");
      return { text: "Added GET /health in app.py.", sessionId: "s", via: "dispatch" };
    };
    const r = reg(createHandoffTool(run));
    const out = await runTool(r, "HandoffTask", { repo: "backend", task: "add an endpoint" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("freshly dispatched agent");
    expect(out.content).toContain("GET /health");
  });

  test("labels a live-agent handoff distinctly", async () => {
    const run: HandoffRun = async () => ({ text: "done", sessionId: "s", via: "live-agent" });
    const r = reg(createHandoffTool(run));
    const out = await runTool(r, "HandoffTask", { repo: "backend", task: "x" }, ctx);
    expect(out.content).toContain("already working there");
  });

  test("surfaces a handoff failure as a tool error", async () => {
    const run: HandoffRun = async () => {
      throw new Error("could not resolve repo");
    };
    const r = reg(createHandoffTool(run));
    const out = await runTool(r, "HandoffTask", { repo: "nope", task: "x" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("could not resolve repo");
  });
});
