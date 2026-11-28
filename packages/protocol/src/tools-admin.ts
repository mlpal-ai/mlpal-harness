/**
 * Capability "tools_admin" (WAVE-2-OWN-TOOLS-AND-PLUGINS.md §2, slices T-1 and T-3): a person's own MCP servers and
 * plugins, managed from a web client. Offered only by a workspace's own serve to its owner (the token holder): never
 * under a principal, on the platform, on an assigned pod or by a child serve. A client gates the Tools screen on the
 * capability.
 *
 * Every change is written to the person's config files and applies to sessions started after it; `reload_tools`
 * reconnects this serve's servers from the files now ("Restart this session's tools").
 *
 * Credentials are written into the config only as references, `${MLPAL_SECRET_<NAME>}`, resolved by the engine at
 * connect (its environment, then the serve's local secret store, then MLPal secrets when configured). A header is
 * added either as a reference to a secret that exists (`secretRef`), or, where `tool_sources.secrets` is "local", with
 * its value in the same `add_mcp_server`: the serve stores the value under a generated name and writes the reference,
 * or does neither. A value sent any other way is refused `tool_literal_secret`; a value is never echoed, logged or
 * listed. Listings carry header names and whether the secret is present.
 */

/** Where a server or plugin came from, as the Tools screen groups them. */
export type ToolSourceOrigin =
  /** The HOP declares it (`requires.mcp`, `processes.mcp_stdio`). */
  | "hop"
  /** MLPal configured it: web search, the memory server, a HOP key's servers, a pack the image installed. */
  | "platform"
  /** The person added it to their user or project config. */
  | "person"
  /** A plugin's server: `plugin` names the plugin, whose own row says who installed it. */
  | "plugin";

/** The file (or the source) a server's definition lives in. Only `user` and `project` are the person's to edit. */
export type ToolServerScope = "user" | "project" | "plugin" | "hop" | "platform";

/** The scopes a person writes: `~/.yodex/config.json`, and `<the serve's directory>/.yodex/settings.json`. */
export type ToolWriteScope = "user" | "project";

export type ToolServerStatus =
  | "connected"
  /** OAuth is configured and no token is saved, or the server asked for a scope the token lacks: `mcp_login`. */
  | "needs_sign_in"
  | "failed"
  /** Turned off (`set_mcp_server enabled: false`): not connected by new sessions. */
  | "off"
  /** A project or plugin server whose exact config the person has not approved: `approve_mcp_server`. */
  | "needs_approval"
  /** Connects on its first call (web search). */
  | "on_first_use"
  | "connecting"
  /** In the config but not loaded by this serve (added or changed after it started): `reload_tools`. */
  | "not_loaded";

/** One header of a server, by name. A value is never sent: `secretRef` names the MLPal secret it references, and
 *  `literal` says the file holds a literal value (written by hand, before references existed). */
export interface ToolServerHeader {
  name: string;
  secretRef?: string;
  /** With `secretRef`: the secret is in this engine's environment or the local store (absent: not known here, e.g.
   *  held by MLPal secrets only). */
  present?: boolean;
  literal?: true;
}

/** Where a header's secret can be kept by this serve: "local" (the serve's own store, `~/.yodex/person-secrets.json`,
 *  0600: an add may carry a value), "mlpal" (MLPal secrets only: send `secretRef`), "none" (references only). A client
 *  hides "Key" unless it is "local". */
export type ToolSecretsMode = "local" | "mlpal" | "none";

export type ToolServerAuth =
  | { kind: "none" }
  | { kind: "headers"; headers: ToolServerHeader[] }
  /** `signedIn`: a token is saved for the server. */
  | { kind: "oauth"; signedIn: boolean };

export interface ToolServerSource {
  /** The config key; a plugin's is `plugin:<plugin>:<server>`. */
  name: string;
  origin: ToolSourceOrigin;
  scope: ToolServerScope;
  /** origin "plugin": the plugin that ships it. */
  plugin?: string;
  transport: "stdio" | "http" | "sse";
  /** http(s): the URL's origin and path (never userinfo, query or fragment); stdio: the program and its arguments. */
  endpoint: string;
  status: ToolServerStatus;
  /** failed / needs_sign_in: a short reason, never a header value. */
  error?: string;
  tools: number;
  /** Tools the server marks `readOnlyHint`: they run unasked in cruise. Every other tool goes through the mode. */
  readOnlyTools: number;
  /** The person may change and remove it (user and project scope). */
  theirs: boolean;
  /** false: "added by you, not reviewed by MLPal" (the person's servers and person-installed plugins' servers). */
  reviewed: boolean;
  auth: ToolServerAuth;
  /** needs_approval: the signature of the config as it is now, for `approve_mcp_server.sig`. */
  approvalSig?: string;
}

export interface PluginSource {
  name: string;
  version?: string;
  description?: string;
  /** Who installed it: the person (from this screen or `yodex plugin add`) or the image. */
  installedBy: "person" | "platform";
  skills: number;
  agents: number;
  /** Its servers' config keys (`plugin:<name>:<server>`), listed in `servers` too. */
  servers: string[];
  /** A `hooks.ts|js|mjs` at its root: code run in the engine's process on every step. Loaded only when the person
   *  consented to this exact file in a terminal (`yodex plugin approve <name> --hooks`); never from the web. */
  hooksModule: { file: string; enabled: boolean } | null;
  /** Every server's current config is approved (an update that changed one is not until approved again). */
  approved: boolean;
  /** false: turned off (`set_plugin`); new sessions load none of it. */
  enabled: boolean;
  /** Load problems (a bad manifest, an unreadable .mcp.json). */
  errors: string[];
}

/** What a plugin will be able to run, shown before it is installed. Its sha256 (`plugin_plan.planSha256`) covers this
 *  plan and every file of the plugin, so a plugin that changed after the plan was shown is refused at approval. */
export interface PluginPlan {
  name: string;
  version?: string;
  description?: string;
  /** The git URL it was fetched from, and the commit. */
  source: string;
  commit?: string;
  /** Namespaced `<plugin>:<skill>`. Skill text is prompt only; a script a skill names runs under the mode. */
  skills: string[];
  agents: string[];
  /** Stdio servers: programs run at every session start, with the person's workspace access. */
  programs: Array<{ server: string; command: string; args: string[] }>;
  /** HTTP servers the session will talk to. */
  remoteServers: Array<{ server: string; url: string; transport: "http" | "sse" }>;
  /** Code run in the engine's process on every step. Not loaded by this install: a terminal consent turns it on. */
  hooksModule: { file: string; sha256: string } | null;
  /** Directories the plugin ships that are not loaded (hooks/, commands/, outputStyles/). */
  ignored: string[];
  warnings: string[];
}

/** A header the person adds, by reference: written as `${MLPAL_SECRET_<secretRef>}`, `Bearer ` before it with
 *  scheme "bearer". `secretRef` is the secret's name in MLPal secrets: 1–64 of `[A-Za-z0-9_]`. */
export interface ToolHeaderRef {
  name: string;
  secretRef: string;
  scheme?: "bearer";
}

/** A header added with its value, where `tool_sources.secrets` is "local": the value (1–8192 characters, no line
 *  break) is stored under a generated name and the config gets only its reference. */
export interface ToolHeaderValue {
  name: string;
  value: string;
  scheme?: "bearer";
}

export type ToolServerAuthInput =
  | { kind: "none" }
  | { kind: "header"; header: ToolHeaderRef | ToolHeaderValue }
  | { kind: "oauth"; scope?: string; clientId?: string };

export type ToolsAdminClientMessage =
  | { type: "list_tool_sources"; requestId: string }
  /** Add an HTTP server at user or project scope. `name`: 1–48 of `[A-Za-z0-9_-]`, starting with a letter or digit,
   *  not already a server's (`-` and `_` count as one). `url`: https, or http on localhost; no credentials in it.
   *  A project server is approved for its exact config by this add; any later change to it asks again. */
  | { type: "add_mcp_server"; requestId: string; scope: ToolWriteScope; name: string; url: string; transport?: "http" | "sse"; auth: ToolServerAuthInput }
  /** Turn a server off or on for new sessions, whatever its origin (recorded in the user config). */
  | { type: "set_mcp_server"; requestId: string; name: string; enabled: boolean }
  /** Remove a user or project server; refused `tool_not_theirs` for any other. */
  | { type: "remove_mcp_server"; requestId: string; name: string; scope: ToolWriteScope }
  /** Approve a project server's config as it is now: `sig` is the listing's `approvalSig`; a config changed since is
   *  refused `tool_signature_stale`. */
  | { type: "approve_mcp_server"; requestId: string; name: string; sig: string }
  /** Start an OAuth sign-in. `redirectUri`: the client's own callback page (https, or http on localhost), which
   *  receives `code` and `state` and sends them back in `mcp_login_complete`. */
  | { type: "mcp_login"; requestId: string; name: string; redirectUri: string }
  | { type: "mcp_login_complete"; requestId: string; loginId: string; state: string; code?: string; error?: string }
  /** Replace the value of a secret in the local store (`name` = a header's `secretRef`); answered `secret_saved`.
   *  Applies at the server's next connect (`reload_tools`). */
  | { type: "set_secret"; requestId: string; name: string; value: string }
  /** Reconnect this serve's servers from the config files now; answered with `tool_sources`. */
  | { type: "reload_tools"; requestId: string }
  /** Fetch a plugin (an https git URL or GitHub `owner/repo`) into staging and answer its plan. Nothing is installed. */
  | { type: "add_plugin"; requestId: string; source: string }
  /** Install the staged plugin `planId`, if it still hashes to `planSha256`; else `plugin_plan_changed` and a new
   *  `plugin_plan`. Approves its servers' configs; its hooks module stays off. */
  | { type: "approve_plugin"; requestId: string; planId: string; planSha256: string }
  | { type: "discard_plugin_plan"; requestId: string; planId: string }
  | { type: "set_plugin"; requestId: string; name: string; enabled: boolean }
  /** Remove a person-installed plugin; refused `tool_not_theirs` for the image's. */
  | { type: "remove_plugin"; requestId: string; name: string };

export type ToolsAdminServerMessage =
  /** `reloadNeeded`: the files differ from what this serve loaded (`reload_tools`). */
  | { type: "tool_sources"; requestId: string; servers: ToolServerSource[]; plugins: PluginSource[]; reloadNeeded: boolean; secrets: ToolSecretsMode }
  /** `secretStored`: the add stored a header value under this name (the header's `secretRef` in `server.auth`). */
  | { type: "mcp_server_saved"; requestId: string; server: ToolServerSource; secretStored?: string }
  | { type: "secret_saved"; requestId: string; name: string }
  | { type: "mcp_server_removed"; requestId: string; name: string; scope: ToolWriteScope }
  /** Open `url` in a new tab; the authorization server redirects to the `redirectUri` given. */
  | { type: "mcp_login_url"; requestId: string; name: string; loginId: string; url: string }
  /** The end of a sign-in (also at once when a saved token already works). */
  | { type: "mcp_login_done"; requestId: string; name: string; ok: boolean; tools?: number; error?: string }
  /** `expiresAt`: the staged copy is discarded then. */
  | { type: "plugin_plan"; requestId: string; planId: string; planSha256: string; plan: PluginPlan; expiresAt: string }
  | { type: "plugin_installed"; requestId: string; plugin: PluginSource }
  | { type: "plugin_saved"; requestId: string; plugin: PluginSource }
  | { type: "plugin_removed"; requestId: string; name: string }
  | { type: "plugin_plan_discarded"; requestId: string; planId: string };

/** The `error.code`s of tools_admin messages. Nothing was changed by a refused message. */
export type ToolsAdminErrorCode =
  /** This serve does not offer tools_admin, or not to this connection. */
  | "tools_admin_unavailable"
  /** A field is missing, of the wrong type, or over its size limit (the message names the field). */
  | "tool_request_invalid"
  | "tool_name_invalid"
  | "tool_name_taken"
  | "tool_url_invalid"
  /** Not https, and not http on localhost. */
  | "tool_url_not_https"
  /** The URL carries userinfo or a credential-named query parameter: use a header reference. */
  | "tool_url_credentials"
  | "tool_header_invalid"
  /** A header value was sent instead of a reference. The value is not echoed or logged. */
  | "tool_literal_secret"
  | "tool_secret_ref_invalid"
  /** A header value over 8192 characters (or empty, or with a line break). */
  | "tool_secret_too_large"
  /** The local store holds its maximum number of secrets. */
  | "tool_secrets_full"
  | "tool_secret_not_found"
  /** A value was sent where this serve has no local store (`tool_sources.secrets` is not "local"). */
  | "tool_secrets_unavailable"
  | "tool_server_not_found"
  | "tool_not_theirs"
  /** A config file that exists does not parse: nothing is written over it. */
  | "tool_config_unreadable"
  | "tool_signature_stale"
  | "mcp_login_not_oauth"
  | "mcp_login_unknown"
  | "mcp_login_failed"
  | "mcp_login_state_mismatch"
  | "mcp_login_busy"
  | "plugin_source_invalid"
  | "plugin_fetch_failed"
  /** Its manifest or a name in it is malformed. */
  | "plugin_invalid"
  /** Its manifest names a path outside the plugin, or a link in it leads outside. */
  | "plugin_path_outside"
  | "plugin_exists"
  | "plugin_plan_unknown"
  | "plugin_plan_changed"
  | "plugin_not_found";

export const TOOLS_ADMIN_CLIENT_TYPES = [
  "list_tool_sources",
  "add_mcp_server",
  "set_mcp_server",
  "remove_mcp_server",
  "approve_mcp_server",
  "mcp_login",
  "mcp_login_complete",
  "set_secret",
  "reload_tools",
  "add_plugin",
  "approve_plugin",
  "discard_plugin_plan",
  "set_plugin",
  "remove_plugin",
] as const satisfies ReadonlyArray<ToolsAdminClientMessage["type"]>;

export function isToolsAdminMessage(msg: { type?: unknown }): msg is ToolsAdminClientMessage {
  return typeof msg.type === "string" && (TOOLS_ADMIN_CLIENT_TYPES as readonly string[]).includes(msg.type);
}

/** The reference a header value is written as, and the pattern the engine resolves at connect. */
export const MLPAL_SECRET_PREFIX = "MLPAL_SECRET_";
export const SECRET_REF_NAME = /^[A-Za-z0-9_]{1,64}$/;
