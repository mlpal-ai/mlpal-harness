import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { host } from "../host";

/**
 * OAuth 2.0 for hosted MCP servers. Tokens (and any dynamically-registered client info) are
 * persisted under ~/.yodex/mcp-auth/<server>.json so a login survives restarts and the SDK
 * can refresh silently. The interactive authorization-code + PKCE step is driven by an
 * injected `redirect` callback (a `yodex mcp login` opens the browser + runs a local
 * callback); in a headless run with no saved token, connect() surfaces a clear UnauthorizedError
 * and the server is simply skipped — never blocking startup.
 */

interface Persisted {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformation;
  codeVerifier?: string;
}

export interface StoredOAuthOptions {
  /** Directory for token files (e.g. ~/.yodex/mcp-auth). */
  dir: string;
  server: string;
  clientName?: string;
  scope?: string;
  redirectUrl?: string;
  clientId?: string;
  /** Interactive step: open this URL for the user to authorize. Omit for non-interactive. */
  redirect?: (url: URL) => void | Promise<void>;
}

export class StoredOAuthProvider implements OAuthClientProvider {
  private readonly file: string;
  private cache: Persisted;

  constructor(private readonly opts: StoredOAuthOptions) {
    this.file = join(opts.dir, `${sanitize(opts.server)}.json`);
    this.cache = this.read();
  }

  private read(): Persisted {
    try {
      if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
    } catch {
      // corrupt token file → treat as unauthenticated
    }
    return {};
  }

  private write(): void {
    if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cache, null, 2), { mode: 0o600 });
  }

  get redirectUrl(): string | undefined {
    return this.opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? host().name,
      redirect_uris: this.opts.redirectUrl ? [this.opts.redirectUrl] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  clientInformation(): OAuthClientInformation | undefined {
    if (this.opts.clientId) return { client_id: this.opts.clientId };
    return this.cache.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformation): void {
    this.cache.clientInformation = info;
    this.write();
  }

  tokens(): OAuthTokens | undefined {
    return this.cache.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.cache.tokens = tokens;
    this.write();
  }

  saveCodeVerifier(verifier: string): void {
    this.cache.codeVerifier = verifier;
    this.write();
  }

  codeVerifier(): string {
    if (!this.cache.codeVerifier) throw new Error("no PKCE code_verifier saved — start a login first");
    return this.cache.codeVerifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.opts.redirect) {
      // Non-interactive (headless): can't complete a browser flow. The SDK will throw
      // UnauthorizedError from connect(), which the manager treats as "skip this server".
      throw new Error(
        `MCP server "${this.opts.server}" needs OAuth login — run \`${host().name} mcp login ${this.opts.server}\``,
      );
    }
    await this.opts.redirect(url);
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
