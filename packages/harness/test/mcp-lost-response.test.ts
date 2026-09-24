import { describe, expect, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { LOST_RESPONSE_CODE, isLostResponse, lostResponseFetch } from "../src/mcp/lost-response";
import { McpManager } from "../src/mcp/manager";
import { runTool, ToolRegistry } from "../src/tools/registry";

const sse = (events: string[]) => events.map((e) => `${e}\n\n`).join("");

function fakeFetch(body: string | Error, contentType = "text/event-stream") {
  return async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        if (body instanceof Error) {
          c.enqueue(new TextEncoder().encode("event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n"));
          c.error(body);
        } else {
          c.enqueue(new TextEncoder().encode(body));
          c.close();
        }
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": contentType } });
  };
}

const callBody = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search" } });

async function drain(res: Response): Promise<string> {
  return await res.text();
}

describe("lostResponseFetch", () => {
  test("a stream that ends without the response reports the id and passes bytes through untouched", async () => {
    const lost: JSONRPCMessage[] = [];
    const body = sse(['event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}']);
    const f = lostResponseFetch((m) => lost.push(m), fakeFetch(body));
    const res = await f("http://x/mcp", { method: "POST", body: callBody });
    expect(await drain(res)).toBe(body);
    expect(lost).toHaveLength(1);
    const err = lost[0] as { id: number; error: { code: number; message: string } };
    expect(err.id).toBe(7);
    expect(err.error.code).toBe(LOST_RESPONSE_CODE);
    expect(err.error.message).toContain("tools/call");
    expect(err.error.message).toContain("stream ended");
  });

  test("a stream that carries the response reports nothing", async () => {
    const lost: JSONRPCMessage[] = [];
    const body = sse(['event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"content":[]}}']);
    const res = await lostResponseFetch((m) => lost.push(m), fakeFetch(body))("http://x/mcp", { method: "POST", body: callBody });
    await drain(res);
    expect(lost).toHaveLength(0);
  });

  test("a resumable stream (SSE id) is left to the SDK's own reconnect", async () => {
    const lost: JSONRPCMessage[] = [];
    const body = sse(["id: 42\ndata: "]);
    const res = await lostResponseFetch((m) => lost.push(m), fakeFetch(body))("http://x/mcp", { method: "POST", body: callBody });
    await drain(res);
    expect(lost).toHaveLength(0);
  });

  test("an upstream error before the response reports the cause and propagates the error", async () => {
    const lost: JSONRPCMessage[] = [];
    const res = await lostResponseFetch((m) => lost.push(m), fakeFetch(new Error("peer closed connection")))(
      "http://x/mcp",
      { method: "POST", body: callBody },
    );
    await expect(drain(res)).rejects.toThrow("peer closed connection");
    expect(lost).toHaveLength(1);
    expect((lost[0] as { error: { message: string } }).error.message).toContain("peer closed connection");
  });

  test("notifications, JSON responses and GET streams are not watched", async () => {
    const lost: JSONRPCMessage[] = [];
    const notify = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const f = lostResponseFetch((m) => lost.push(m), fakeFetch(sse(["data: x"])));
    await drain(await f("http://x/mcp", { method: "POST", body: notify }));
    await drain(await f("http://x/mcp", { method: "GET" }));
    const json = lostResponseFetch((m) => lost.push(m), fakeFetch("{}", "application/json"));
    await drain(await json("http://x/mcp", { method: "POST", body: callBody }));
    expect(lost).toHaveLength(0);
  });

  test("isLostResponse matches the code, not the message", () => {
    expect(isLostResponse({ code: LOST_RESPONSE_CODE })).toBe(true);
    expect(isLostResponse(new Error("MCP response lost"))).toBe(false);
    expect(isLostResponse(null)).toBe(false);
  });
});

/** Minimal Streamable-HTTP MCP server whose first tools/call closes the stream unanswered. */
function flakyServer() {
  let calls = 0;
  const json = (msg: unknown) => Response.json(msg, { headers: { "mcp-session-id": "s1" } });
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const msg = (await req.json()) as { id?: number; method: string; params?: { name?: string } };
      switch (msg.method) {
        case "initialize":
          return json({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "flaky", version: "0" } },
          });
        case "tools/list":
          return json({
            jsonrpc: "2.0",
            id: msg.id,
            result: { tools: [{ name: "echo", inputSchema: { type: "object", properties: {} } }] },
          });
        case "tools/call": {
          calls += 1;
          const answered = calls > 1;
          const events = answered
            ? [`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `answered on call ${calls}` }] } })}`]
            : ['event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"waking"}}'];
          return new Response(sse(events), { headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" } });
        }
        default:
          return new Response(null, { status: 202 });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, stop: () => server.stop(true), calls: () => calls };
}

describe("McpManager over streamable HTTP", () => {
  test("a call whose stream closes unanswered is retried once and returns the second answer promptly", async () => {
    const srv = flakyServer();
    const reg = new ToolRegistry();
    const mcp = new McpManager();
    try {
      const { connected } = await mcp.connectAll({ flaky: { url: srv.url } }, reg);
      expect(connected).toBe(1);
      const started = Date.now();
      const res = await runTool(reg, "mcp__flaky__echo", {}, { cwd: process.cwd() });
      expect(res.isError).toBe(false);
      expect(res.content).toContain("answered on call 2");
      expect(srv.calls()).toBe(2);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await mcp.close();
      srv.stop();
    }
  }, 15_000);
});
