import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { HttpServerConfig } from "./manager";
import { StoredOAuthProvider } from "./oauth";
import { host } from "../host";

/**
 * Interactive OAuth login for an MCP server: authorization-code + PKCE. Spins up a
 * throwaway localhost callback server, opens the browser to the server's authorize URL,
 * captures the redirected `code`, exchanges it, and persists the tokens under authDir so
 * subsequent runs connect silently. Returns a human-readable result line.
 */
export async function loginToMcp(
  server: string,
  config: HttpServerConfig,
  authDir: string,
  open: (url: string) => void = openBrowser,
): Promise<string> {
  const { port, waitForCode, close } = await startCallbackServer();
  const redirectUrl = `http://localhost:${port}/callback`;
  try {
    const provider = new StoredOAuthProvider({
      dir: authDir,
      server,
      scope: config.oauth?.scope,
      clientId: config.oauth?.clientId,
      redirectUrl,
      redirect: (url) => open(url.toString()),
    });
    const makeTransport = () => {
      const url = new URL(config.url);
      return config.type === "sse"
        ? new SSEClientTransport(url, { authProvider: provider })
        : new StreamableHTTPClientTransport(url, { authProvider: provider });
    };

    // 1st connect kicks off the browser redirect, then throws UnauthorizedError.
    const transport = makeTransport();
    try {
      await new Client({ name: host().name, version: "0.0.1" }).connect(transport);
      return `already authorized with ${server}`; // a valid token was already present
    } catch (e) {
      if (!(e instanceof UnauthorizedError)) throw e;
    }

    const code = await waitForCode(120_000);
    await transport.finishAuth(code);

    // Reconnect with the freshly-minted token to confirm + persist.
    const confirm = makeTransport();
    const client = new Client({ name: host().name, version: "0.0.1" });
    await client.connect(confirm);
    const tools = (await client.listTools()) as { tools: unknown[] };
    await client.close();
    return `authorized with ${server} — ${tools.tools.length} tool(s) available. Token saved.`;
  } finally {
    close();
  }
}

interface CallbackServer {
  port: number;
  waitForCode: (timeoutMs: number) => Promise<string>;
  close: () => void;
}

async function startCallbackServer(): Promise<CallbackServer> {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const srv = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    const code = u.searchParams.get("code");
    const err = u.searchParams.get("error");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<html><body style="font:16px system-ui;padding:3rem;text-align:center">${
        code ? `✓ Authorized. You can close this tab and return to ${host().name}.` : `Authorization failed: ${err ?? "no code"}`
      }</body></html>`,
    );
    if (code) resolveCode(code);
    else rejectCode(new Error(err ?? "authorization returned no code"));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    port,
    waitForCode: (timeoutMs) =>
      Promise.race([
        codePromise,
        new Promise<string>((_, rej) =>
          setTimeout(() => rej(new Error("login timed out — no browser redirect received")), timeoutMs),
        ),
      ]),
    close: () => srv.close(),
  };
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
}
