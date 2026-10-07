#!/usr/bin/env node
// A minimal language server for tests: LSP base-protocol framing over stdio. It answers the
// five questions the client asks with fixed shapes derived from the request, publishes one
// diagnostic per opened file, asks the client for configuration once, and exits when told.
let buf = Buffer.alloc(0);
const docs = new Map();
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const i = buf.indexOf("\r\n\r\n");
    if (i < 0) return;
    const len = Number(/Content-Length:\s*(\d+)/i.exec(buf.subarray(0, i).toString())[1]);
    if (buf.length < i + 4 + len) return;
    const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString());
    buf = buf.subarray(i + 4 + len);
    handle(msg);
  }
});
function send(obj) {
  const body = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
function handle(msg) {
  const p = msg.params ?? {};
  switch (msg.method) {
    case "initialize":
      reply(msg.id, { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true, documentSymbolProvider: true } });
      return;
    case "initialized":
      send({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: [{ section: "fake" }] } });
      return;
    case "textDocument/didOpen":
      docs.set(p.textDocument.uri, p.textDocument.text);
      setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: p.textDocument.uri, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 2, code: "FAKE1", source: "fake", message: `opened with ${p.textDocument.text.length} chars` }] } }), 20);
      return;
    case "textDocument/didChange":
      docs.set(p.textDocument.uri, p.contentChanges[0].text);
      setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: p.textDocument.uri, diagnostics: [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } }, severity: 1, message: `changed to version ${p.textDocument.version}` }] } }), 20);
      return;
    case "textDocument/definition":
      // the definition is always line 0, col 0 of the same file (a Location, not a LocationLink)
      reply(msg.id, { uri: p.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } });
      return;
    case "textDocument/references":
      reply(msg.id, [
        { uri: p.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
        { uri: p.textDocument.uri, range: { start: p.position, end: p.position } },
      ]);
      return;
    case "textDocument/hover":
      reply(msg.id, { contents: { kind: "markdown", value: `symbol at ${p.position.line}:${p.position.character}` } });
      return;
    case "textDocument/documentSymbol":
      reply(msg.id, [{ name: "Thing", kind: 5, range: { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, children: [{ name: "run", kind: 6, range: { start: { line: 1, character: 2 }, end: { line: 2, character: 3 } }, selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }] }]);
      return;
    case "shutdown":
      reply(msg.id, null);
      return;
    case "exit":
      process.exit(0);
    default:
      if (msg.id !== undefined && msg.method) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
  }
}
