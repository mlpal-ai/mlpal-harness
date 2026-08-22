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

function handle(msg) {
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
          ],
        },
      });
      break;
    case "tools/call": {
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
