#!/usr/bin/env node
// Minimal MCP stdio server for tests: newline-delimited JSON-RPC.
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const pending = new Map();
let nextId = 1000;
function handle(msg) {
  // A response to one of OUR requests (an elicitation answer from the client).
  if (msg.method === undefined && msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  switch (msg.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "mock", version: "1.0" },
        },
      });
      break;
    case "notifications/initialized":
      break; // notification, no response
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            {
              name: "greet",
              description: "Greet someone",
              inputSchema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
                additionalProperties: false,
              },
            },
            ...(process.env.MOCK_MCP_EXTRAS
              ? [
                  { name: "picture", description: "Returns a tiny image and a caption", inputSchema: { type: "object", properties: {} } },
                  { name: "ask", description: "Asks the person a question through elicitation", inputSchema: { type: "object", properties: {} } },
                  { name: "scoped", description: "Needs a scope the token lacks", inputSchema: { type: "object", properties: {} } },
                  { name: "long", description: "L".repeat(5000), inputSchema: { type: "object", properties: {} } },
                ]
              : []),
          ],
        },
      });
      break;
    case "tools/call": {
      const tool = msg.params?.name;
      if (tool === "picture") {
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "a red dot" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], isError: false } });
        break;
      }
      if (tool === "scoped") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: 'HTTP 403: insufficient_scope, scope="files:write"' } });
        break;
      }
      if (tool === "ask") {
        const id = nextId++;
        pending.set(id, (resp) => {
          const r = resp.result ?? {};
          send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `elicited: ${r.action}${r.content ? ` ${JSON.stringify(r.content)}` : ""}` }], isError: false } });
        });
        send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message: "Which region?", requestedSchema: { type: "object", properties: { region: { type: "string" } }, required: ["region"] } } });
        break;
      }
      const who = msg.params?.arguments?.name ?? "world";
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `Hello, ${who}!` }], isError: false },
      });
      break;
    }
    default:
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
}
