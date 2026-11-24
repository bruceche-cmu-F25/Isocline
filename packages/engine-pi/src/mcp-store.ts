/** What Zirma keeps for its MCP servers outside `mcp.json`, in its own secret store (the keychain), and how a
 * server is reached with it (docs/design/settings-and-connections.md §3.3). Shared by the home node, where the user
 * signs in and where a server's state is checked, and by the engine workers, which make the calls.
 *
 * Two entries per server: `mcp-oauth:<name>` holds the OAuth state of a sign-in (the registered client, the tokens);
 * `mcp-secret:<name>` holds the headers and environment variables the user gave as secrets. Nothing of either is
 * written to `mcp.json` or to a log.
 *
 * Tokens are refreshed by whoever needs them next, a worker or the home node, and many servers rotate the refresh
 * token, so two refreshes at once would lose the grant: a lock directory beside the data keeps processes apart.
 */
import { mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import {
  createMcpAuthProvider, McpRefreshLockBusyError, type McpOAuthServerStore, type McpOAuthSettings, type McpOAuthState, type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
import type { SecretStore } from "@zirma/core";
import { alfredMeta } from "./mcp-config.ts";

/** The name Zirma registers under with an authorization server; the user sees it on the consent page. */
export const MCP_CLIENT_NAME = "Zirma";

export interface McpSecrets { headers?: Record<string, string>; env?: Record<string, string> }

export interface McpVault {
  /** The OAuth state of one server, for pi-mcp's sign-in and its auth provider. */
  oauth(name: string, serverUrl: string): McpOAuthServerStore;
  /** Whether a sign-in to this server at this address is kept. */
  signedIn(name: string, serverUrl: string): Promise<boolean>;
  /** Forgets the sign-in (the registered client too). */
  signOut(name: string): Promise<void>;
  secrets(name: string): Promise<McpSecrets>;
  setSecrets(name: string, secrets: McpSecrets): Promise<void>;
  /** Everything kept for a server that is being removed. */
  forget(name: string): Promise<void>;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const CACHE_MS = 2000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function createMcpVault(options: { secrets: Pick<SecretStore, "get" | "set" | "delete">; lockDir: string }): McpVault {
  const cache = new Map<string, { at: number; value: string | undefined }>();
  const read = async (entry: string, fresh = false): Promise<string | undefined> => {
    const cached = cache.get(entry);
    if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
    const value = await options.secrets.get(entry);
    cache.set(entry, { at: Date.now(), value });
    return value;
  };
  const write = async (entry: string, value: string | undefined): Promise<void> => {
    if (value === undefined) await options.secrets.delete(entry);
    else await options.secrets.set(entry, value);
    cache.set(entry, { at: Date.now(), value });
  };
  const json = <T>(text: string | undefined): T | undefined => {
    if (!text) return undefined;
    try { return JSON.parse(text) as T; } catch { return undefined; }
  };
  const oauthEntry = (name: string) => `mcp-oauth:${name}`;
  const secretEntry = (name: string) => `mcp-secret:${name}`;

  /** One at a time in this process, then one process at a time. */
  const queues = new Map<string, Promise<unknown>>();
  async function acquire(lockPath: string): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { mkdirSync(lockPath); return; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try { if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) { rmSync(lockPath, { recursive: true, force: true }); continue; } } catch { continue; }
        if (Date.now() > deadline) throw new McpRefreshLockBusyError();
        await sleep(40);
      }
    }
  }
  function locked<T>(name: string, action: () => Promise<T>): Promise<T> {
    const lockPath = join(options.lockDir, `mcp-${name}.lock`);
    const run = (queues.get(name) ?? Promise.resolve()).then(async () => {
      await acquire(lockPath);
      try { return await action(); } finally { rmSync(lockPath, { recursive: true, force: true }); }
    });
    queues.set(name, run.catch(() => undefined));
    return run;
  }

  return {
    oauth(name, serverUrl) {
      return {
        // A state kept for another address is not this server's: a renamed or re-pointed entry signs in again.
        async load() {
          const state = json<McpOAuthState>(await read(oauthEntry(name), true));
          return state && state.serverUrl === serverUrl ? state : undefined;
        },
        async save(state) { await write(oauthEntry(name), JSON.stringify(state)); },
        withRefreshLock: (fn) => locked(name, fn),
      };
    },
    async signedIn(name, serverUrl) {
      const state = json<McpOAuthState>(await read(oauthEntry(name)));
      return !!state?.tokens && state.serverUrl === serverUrl;
    },
    signOut: (name) => write(oauthEntry(name), undefined),
    // Read anew each time: another process (the home node, for a worker) may have just changed them.
    async secrets(name) { return json<McpSecrets>(await read(secretEntry(name), true)) ?? {}; },
    async setSecrets(name, secrets) {
      const headers = secrets.headers ?? {}, env = secrets.env ?? {};
      const empty = !Object.keys(headers).length && !Object.keys(env).length;
      await write(secretEntry(name), empty ? undefined : JSON.stringify({ headers, env }));
    },
    async forget(name) {
      await write(oauthEntry(name), undefined);
      await write(secretEntry(name), undefined);
    },
  };
}

/** `${VAR}` in a header or an environment value, from this process's environment; a missing one is an error, so a
 * server is never called with half a credential. */
function fill(value: string, what: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_whole, variable: string) => {
    const found = process.env[variable];
    if (found === undefined) throw new Error(`${what}: the environment variable ${variable} is not set`);
    return found;
  });
}
const expandHome = (value: string) => (value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);

/** The OAuth client settings an entry may carry (`oauth`), as pi-mcp takes them. */
export function oauthSettings(config: Record<string, unknown>): McpOAuthSettings {
  const oauth = config.oauth && typeof config.oauth === "object" ? config.oauth as Record<string, unknown> : {};
  const text = (key: string) => (typeof oauth[key] === "string" ? oauth[key] as string : undefined);
  const mode = text("clientRegistration");
  return {
    ...(text("clientId") ? { clientId: text("clientId") } : {}),
    ...(text("clientSecret") ? { clientSecret: fill(text("clientSecret")!, "oauth.clientSecret") } : {}),
    ...(typeof oauth.callbackPort === "number" ? { callbackPort: oauth.callbackPort } : {}),
    ...(text("callbackUrl") ? { callbackUrl: text("callbackUrl") } : {}),
    ...(text("scope") ? { scope: text("scope") } : {}),
    ...(text("clientName") ? { clientName: text("clientName") } : {}),
    ...(mode === "auto" || mode === "dcr" || mode === "cimd" ? { clientRegistration: mode } : {}),
    ...(text("authServerMetadataUrl") ? { authServerMetadataUrl: new URL(text("authServerMetadataUrl")!) } : {}),
  };
}

/** How one server is authorised: its own header (a token the user gave), or OAuth, or nothing. */
export function usesHeaderAuth(config: Record<string, unknown>): boolean {
  const named = [...Object.keys((config.headers as Record<string, string> | undefined) ?? {}), ...(alfredMeta(config).secretHeaders ?? [])];
  return named.some((header) => header.toLowerCase() === "authorization");
}

/** The connection to one server: its address or command from `mcp.json`, its secrets from the keychain, and, for a
 * remote server without a header of its own, the tokens of the user's sign-in (sent, and refreshed when they run
 * out; never a browser: a server that needs a sign-in fails with pi-mcp's `McpOAuthAuthorizationRequiredError`). */
export function createMcpTransport(
  entry: { name: string; config: Record<string, unknown> },
  options: { cwd: string; vault: McpVault; secrets: McpSecrets; onChallenge?: (challenge: OAuthChallenge) => void },
): McpTransport {
  const { name, config } = entry;
  if (typeof config.url === "string") {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((config.headers as Record<string, string> | undefined) ?? {})) headers[key] = fill(value, `MCP server "${name}" header "${key}"`);
    Object.assign(headers, options.secrets.headers ?? {});
    const own = Object.keys(headers).some((header) => header.toLowerCase() === "authorization");
    const authProvider = own ? undefined : createMcpAuthProvider({
      serverUrl: config.url,
      store: options.vault.oauth(name, config.url),
      settings: () => oauthSettings(config),
      clientName: MCP_CLIENT_NAME,
      onChallenge: (challenge) => options.onChallenge?.(challenge),
    });
    return new StreamableHttpTransport({ url: config.url, headers, ...(authProvider ? { authProvider } : {}) });
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries((config.env as Record<string, string> | undefined) ?? {})) env[key] = fill(value, `MCP server "${name}" env "${key}"`);
  Object.assign(env, options.secrets.env ?? {});
  return new StdioTransport({
    command: expandHome(String(config.command)),
    args: ((config.args as string[] | undefined) ?? []).map(expandHome),
    cwd: resolve(options.cwd, expandHome(typeof config.cwd === "string" ? config.cwd : ".")),
    env,
    stderr: "pipe",
  });
}
