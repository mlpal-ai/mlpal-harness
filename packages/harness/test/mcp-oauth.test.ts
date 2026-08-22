import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StoredOAuthProvider } from "../src/mcp/oauth";

let dir: string;
beforeEach(() => {
  dir = join(tmpdir(), `yodex-mcpauth-${crypto.randomUUID()}`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tokens = { access_token: "at_123", token_type: "Bearer", refresh_token: "rt_456", expires_in: 3600 };

describe("StoredOAuthProvider", () => {
  test("persists tokens and reads them back in a fresh instance", () => {
    const p = new StoredOAuthProvider({ dir, server: "acme" });
    expect(p.tokens()).toBeUndefined();
    p.saveTokens(tokens);
    expect(p.tokens()?.access_token).toBe("at_123");

    // a new process/instance loads the same persisted token
    const p2 = new StoredOAuthProvider({ dir, server: "acme" });
    expect(p2.tokens()?.refresh_token).toBe("rt_456");
  });

  test("token file is per-server and written 0600", () => {
    new StoredOAuthProvider({ dir, server: "acme" }).saveTokens(tokens);
    const file = join(dir, "acme.json");
    expect(existsSync(file)).toBe(true);
    // owner-only perms (mask to the permission bits)
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // a different server writes a different file
    new StoredOAuthProvider({ dir, server: "other" }).saveTokens(tokens);
    expect(existsSync(join(dir, "other.json"))).toBe(true);
  });

  test("clientMetadata carries redirect + scope; clientInformation honors a static id", () => {
    const p = new StoredOAuthProvider({
      dir,
      server: "acme",
      redirectUrl: "http://localhost:1234/callback",
      scope: "read write",
      clientId: "static-abc",
    });
    expect(p.clientMetadata.redirect_uris).toEqual(["http://localhost:1234/callback"]);
    expect(p.clientMetadata.scope).toBe("read write");
    expect(p.clientInformation()?.client_id).toBe("static-abc");
  });

  test("PKCE code_verifier round-trips through the store", () => {
    const p = new StoredOAuthProvider({ dir, server: "acme" });
    p.saveCodeVerifier("verifier-xyz");
    expect(p.codeVerifier()).toBe("verifier-xyz");
    expect(new StoredOAuthProvider({ dir, server: "acme" }).codeVerifier()).toBe("verifier-xyz");
  });

  test("non-interactive redirectToAuthorization guides the user to `mcp login`", async () => {
    const p = new StoredOAuthProvider({ dir, server: "acme" }); // no redirect callback
    await expect(p.redirectToAuthorization(new URL("https://auth.acme/authorize"))).rejects.toThrow(
      /yodex mcp login acme/,
    );
  });

  test("interactive redirectToAuthorization invokes the redirect callback", async () => {
    let opened = "";
    const p = new StoredOAuthProvider({ dir, server: "acme", redirect: (u) => void (opened = u.toString()) });
    await p.redirectToAuthorization(new URL("https://auth.acme/authorize?x=1"));
    expect(opened).toBe("https://auth.acme/authorize?x=1");
  });

  test("saveClientInformation persists dynamic registration", () => {
    const p = new StoredOAuthProvider({ dir, server: "acme" });
    p.saveClientInformation({ client_id: "dyn-1" });
    expect(new StoredOAuthProvider({ dir, server: "acme" }).clientInformation()?.client_id).toBe("dyn-1");
  });
});
