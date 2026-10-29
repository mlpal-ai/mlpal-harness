/**
 * Tool hands classes (`Tool.hands`): where a tool's model-chosen paths, commands and URLs land. A host with no local
 * hands (an engine pod on the platform) restricts its registries to `pure` and `routed` tools; an unclassified tool is
 * refused like a `local` one, so a tool added later without a class is never offered there.
 */
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { McpManager } from "../src/mcp/manager";
import type { ProcessHandle, ProcessHost } from "../src/mcp/process-host";
import { createMemorizeTool } from "../src/memory/derived";
import { createSkillTool } from "../src/skills/skills";
import { createHandoffTool, createListPeersTool } from "../src/subagent/coordination";
import { agentOutputTool, createTaskTool } from "../src/subagent/task";
import { createTaskTools } from "../src/tasks/tools";
import { createAskUserQuestionTool } from "../src/tools/builtin/ask";
import { createAskModelTool, createListModelsTool } from "../src/tools/builtin/gateway";
import { createLspTool } from "../src/tools/builtin/lsp";
import { createPeerTools } from "../src/tools/builtin/peers";
import { createToolSearchTool } from "../src/tools/builtin/toolsearch";
import { createEgressWebFetchTool } from "../src/tools/builtin/web";
import { createWebSearchTools } from "../src/tools/builtin/websearch";
import { DeferredTools } from "../src/tools/deferred";
import { BUILTIN_TOOLS, digestTool, monitorTool } from "../src/tools/index";
import { ToolRegistry } from "../src/tools/registry";
import { createSandboxHands } from "../src/tools/remote/sandbox-hands";
import { defineTool, type Tool, type ToolHands } from "../src/tools/types";
import { createWorkflowTool } from "../src/workflow/tool";
import { z } from "zod";

const SERVER = join(import.meta.dir, "fixtures", "mock-mcp-server.mjs");
// Factories are only constructed here, never called: their dependencies are inert stand-ins.
const inert = {} as never;

function tool(name: string, hands?: ToolHands): Tool {
  return defineTool({ name, description: name, readOnly: true, ...(hands ? { hands } : {}), schema: z.object({}), call: async () => ({ content: name }) }) as Tool;
}

/** Every tool a harness factory can hand a host, with the class it must carry. */
function everyHarnessTool(): Tool[] {
  return [
    ...BUILTIN_TOOLS,
    monitorTool,
    digestTool,
    agentOutputTool,
    createTaskTool(inert, [], inert),
    ...createTaskTools(inert),
    createSkillTool([]),
    createToolSearchTool(new DeferredTools(), new ToolRegistry()),
    createLspTool({ languages: () => [] } as never),
    ...createPeerTools(inert),
    createListPeersTool(inert),
    createHandoffTool(inert),
    createWorkflowTool(inert, []),
    createAskUserQuestionTool(inert),
    createAskModelTool(inert),
    createListModelsTool(inert),
    ...createWebSearchTools(inert),
    ...createSandboxHands({ client: inert }),
    createEgressWebFetchTool({ proxyUrl: "http://p:7401", upstream: "web-fetch", tokenFile: "/nonexistent" }, "https://example.org/"),
    createMemorizeTool(inert),
  ] as Tool[];
}

describe("every harness tool carries a hands class", () => {
  test("no factory returns an unclassified tool", () => {
    const unclassified = everyHarnessTool().filter((t) => t.hands === undefined).map((t) => t.name);
    expect(unclassified).toEqual([]);
  });

  test("the classes: the sandbox's and the egress proxy's tools are routed; the local file, shell, web and process tools are local", () => {
    const classes = Object.fromEntries(everyHarnessTool().map((t) => [`${t.name}${t.hands === "routed" ? "@routed" : ""}`, t.hands]));
    for (const n of ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "List", "BashOutput", "Kill"]) {
      expect(classes[n]).toBe("local");
      expect(classes[`${n}@routed`]).toBe("routed");
    }
    expect(classes.WebFetch).toBe("local");
    expect(classes["WebFetch@routed"]).toBe("routed");
    for (const n of ["Monitor", "Lsp", "Workflow", "HandoffTask", "ListPeers", "ListAgents", "SendMessage", "Skill", "Memorize"]) expect(classes[n]).toBe("local");
    for (const n of ["Agent", "AgentOutput", "TaskCreate", "TaskUpdate", "TaskList", "ToolSearch", "AskUserQuestion", "AskModel", "ListModels", "Digest", "ExitPlanMode"]) expect(classes[n]).toBe("pure");
  });

  test("WebSearch and Research are as their backend is: local unless the host says the backend is routed", () => {
    expect(createWebSearchTools(inert).map((t) => t.hands)).toEqual(["local", "local"]);
    expect(createWebSearchTools({ ...(inert as object), hands: "routed" } as never).map((t) => t.hands)).toEqual(["routed", "routed"]);
  });
});

describe("ToolRegistry.restrictHands", () => {
  test("admits only the named classes: a local or unclassified tool is dropped now and refused later, each reported once", () => {
    const reg = new ToolRegistry();
    reg.register(tool("Pure", "pure"));
    reg.register(tool("Local", "local"));
    reg.register(tool("Bare"));
    const refused: string[] = [];
    reg.restrictHands(["pure", "routed"], (t) => refused.push(t.name));
    expect(reg.list().map((t) => t.name)).toEqual(["Pure"]);
    reg.register(tool("Routed", "routed"));
    reg.register(tool("Later", "local"));
    reg.register(tool("Local", "local"));
    expect(reg.list().map((t) => t.name).sort()).toEqual(["Pure", "Routed"]);
    expect(reg.get("Later")).toBeUndefined();
    expect(refused).toEqual(["Local", "Bare", "Later"]);
    expect(reg.handsRestriction).toEqual(["pure", "routed"]);
  });

  test("a registry made from it by filter() keeps the restriction, its late resolution included", async () => {
    const reg = new ToolRegistry();
    reg.restrictHands(["pure", "routed"]);
    reg.register(tool("Pure", "pure"));
    const child = reg.filter(() => true);
    expect(child.handsRestriction).toEqual(["pure", "routed"]);
    child.register(tool("Bash", "local"));
    expect(child.get("Bash")).toBeUndefined();
    reg.setLateResolver(async () => undefined);
    expect(await child.resolve("Bash")).toBeUndefined();
  });

  test("a registry nobody restricted admits every tool (the off-platform default)", () => {
    const reg = new ToolRegistry();
    reg.register(tool("Bare"));
    reg.register(tool("Local", "local"));
    expect(reg.list()).toHaveLength(2);
    expect(reg.handsRestriction).toBeNull();
  });
});

/** A ProcessHost that spawns locally: the seam the sandbox's processes use, without a sandbox. */
function localHost(): ProcessHost {
  return {
    async spawn(spec) {
      const [cmd, ...args] = spec.argv;
      const child = Bun.spawn([cmd!, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      const h: ProcessHandle = {
        async write(data) {
          child.stdin.write(data);
        },
        async closeStdin() {
          child.stdin.end();
        },
        async kill() {
          child.kill(9);
        },
        onStdout(cb) {
          void (async () => {
            for await (const chunk of child.stdout) cb(chunk);
          })();
        },
        onExit(cb) {
          void child.exited.then((code) => cb({ code, reason: null }));
        },
      };
      return h;
    },
  };
}

describe("an MCP server's tools are classed by its transport", () => {
  test("a local stdio server's are local; one run through a ProcessHost (the sandbox) is routed", async () => {
    const mcp = new McpManager();
    try {
      const local = new ToolRegistry();
      expect(await mcp.connect("here", { command: "node", args: [SERVER] }, local)).toBeGreaterThan(0);
      expect(new Set(local.list().map((t) => t.hands))).toEqual(new Set(["local"]));
      const guest = new ToolRegistry();
      expect(await mcp.connect("guest", { command: "node", args: [SERVER], host: localHost() }, guest)).toBeGreaterThan(0);
      expect(new Set(guest.list().map((t) => t.hands))).toEqual(new Set(["routed"]));
    } finally {
      await mcp.close();
    }
  }, 20_000);
});
