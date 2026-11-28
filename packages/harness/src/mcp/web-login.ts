import { timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformation } from "@modelcontextprotocol/sdk/shared/auth.js";
import { host } from "../host";
import type { HttpServerConfig } from "./manager";
import { StoredOAuthProvider, type StoredOAuthOptions } from "./oauth";

/**
 * OAuth sign-in for an MCP server driven from a web client (tools-admin, T-1). `loginToMcp` runs a callback server on
 * the engine's loopback, which a browser on another machine cannot reach; here the redirect goes to the client's own
 * page (`redirectUrl`), which hands `code` and `state` back over the socket. The flow is the SDK's authorization code
 * + PKCE, with a `state` this login chose: `finish` refuses a code that does not come back with it (a login started
 * elsewhere cannot be completed here). Tokens are saved under `authDir` exactly as `yodex mcp login` saves them.
 */
export type WebLoginStart =
  | { kind: "authorized"; tools: number }
  | { kind: "redirect"; url: string; finish: (code: string, state: string) => Promise<{ tools: number }>; close: () => void };

export class WebLoginStateError extends Error {
  override name = "WebLoginStateError";
  constructor() {
    super("the sign-in came back with another login's state");
  }
}

/** A provider that sends this login's `state`, and drops a saved dynamic registration made for another redirect (a
 *  terminal login's loopback callback): the authorization server would refuse this redirect for that client. */
class WebOAuthProvider extends StoredOAuthProvider {
  constructor(
    opts: StoredOAuthOptions,
    private readonly loginState: string,
  ) {
    super(opts);
  }

  state(): string {
    return this.loginState;
  }

  override clientInformation(): OAuthClientInformation | undefined {
    const info = super.clientInformation() as (OAuthClientInformation & { redirect_uris?: unknown }) | undefined;
    if (info && Array.isArray(info.redirect_uris) && !info.redirect_uris.includes(this.redirectUrl)) return undefined;
    return info;
  }
}

const sameState = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function startWebLogin(o: { server: string; config: HttpServerConfig; authDir: string; redirectUrl: string; state: string }): Promise<WebLoginStart> {
  let authorizeUrl: string | undefined;
  const provider = new WebOAuthProvider(
    {
      dir: o.authDir,
      server: o.server,
      ...(o.config.oauth?.scope ? { scope: o.config.oauth.scope } : {}),
      ...(o.config.oauth?.clientId ? { clientId: o.config.oauth.clientId } : {}),
      redirectUrl: o.redirectUrl,
      redirect: (url) => {
        authorizeUrl = url.toString();
      },
    },
    o.state,
  );
  const transport = () => {
    const url = new URL(o.config.url);
    return o.config.type === "sse" ? new SSEClientTransport(url, { authProvider: provider }) : new StreamableHTTPClientTransport(url, { authProvider: provider });
  };
  const toolCount = async (t: ReturnType<typeof transport>): Promise<number> => {
    const client = new Client({ name: host().name, version: "0.0.1" });
    await client.connect(t);
    try {
      return ((await client.listTools()) as { tools: unknown[] }).tools.length;
    } finally {
      await client.close().catch(() => undefined);
    }
  };
  const first = transport();
  try {
    return { kind: "authorized", tools: await toolCount(first) };
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !authorizeUrl) throw e;
  }
  let done = false;
  return {
    kind: "redirect",
    url: authorizeUrl,
    finish: async (code, state) => {
      if (done) throw new Error("this sign-in has already finished");
      if (!sameState(state, o.state)) throw new WebLoginStateError();
      done = true;
      await first.finishAuth(code);
      return { tools: await toolCount(transport()) };
    },
    close: () => {
      done = true;
      void first.close().catch(() => undefined);
    },
  };
}
