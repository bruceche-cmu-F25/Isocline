/** Google accounts, connected with one click (docs/design/settings-and-connections.md §3.1).
 *
 * Isocline has its own OAuth client of the "Desktop app" type: its id (and the
 * secret, which Google does not treat as confidential for installed apps) come
 * from `google-oauth-client.json` in the data directory, as Google Cloud
 * downloads it, or from ISOCLINE_GOOGLE_CLIENT_ID / ISOCLINE_GOOGLE_CLIENT_SECRET.
 *
 * Connecting: the home node starts a one-shot callback server on a random
 * 127.0.0.1 port and returns Google's consent URL; a device opens it in the
 * system browser; Google redirects back with a code, exchanged here with PKCE.
 * The refresh token goes to the secret store; the list of accounts and what
 * each may do (no secrets) is `connections.json` in the data directory, and
 * every change is a `connection.*` event in the world.
 *
 * Each capability asks for its own scope, only when it is turned on; Google
 * lets the user untick scopes, so a capability counts as on only when its
 * scope was actually granted.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { recordDomainEvent, type World } from "@isocline/core";
import type { ConnectFlow, ConnectionsResponse, GoogleAccount, GoogleCapability, GoogleCheck } from "@isocline/protocol";
import type { SecretStore } from "./secrets.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SCOPE = "https://www.googleapis.com/auth/";
const IDENTITY = ["openid", "email"];
const FLOW_TIMEOUT_MS = 10 * 60_000;

export const GOOGLE_CAPABILITIES = {
  calRead: { scope: `${SCOPE}calendar.readonly` },
  calWrite: { scope: `${SCOPE}calendar.events` },
  mailRead: { scope: `${SCOPE}gmail.readonly` },
  mailModify: { scope: `${SCOPE}gmail.modify` },
  mailSend: { scope: `${SCOPE}gmail.send` },
} as const satisfies Record<GoogleCapability, { scope: string }>;
export const isGoogleCapability = (value: unknown): value is GoogleCapability => typeof value === "string" && Object.hasOwn(GOOGLE_CAPABILITIES, value);
export type GoogleStatus = ConnectionsResponse["google"];
type FlowStatus = ConnectFlow;

interface Client { id: string; secret: string; source: string }
interface Token { refresh: string; access?: string; expires?: number; scopes: string[] }
interface Flow { status: FlowStatus; server: Server; timer: NodeJS.Timeout }

export class GoogleError extends Error {
  override name = "GoogleError";
  readonly code: "no_client" | "unknown_account" | "broken" | "busy" | "google";
  constructor(code: GoogleError["code"], message: string) { super(message); this.code = code; }
}

export function loadGoogleClient(dirs: readonly string[]): Client | null {
  const id = process.env.ISOCLINE_GOOGLE_CLIENT_ID, secret = process.env.ISOCLINE_GOOGLE_CLIENT_SECRET;
  if (id && secret) return { id, secret, source: "environment" };
  for (const dir of dirs) {
    const path = join(dir, "google-oauth-client.json");
    if (!existsSync(path)) continue;
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, { client_id?: string; client_secret?: string }>;
      const entry = file.installed ?? file.web;
      if (entry?.client_id && entry.client_secret) return { id: entry.client_id, secret: entry.client_secret, source: path };
    } catch { /* unreadable: try the next */ }
  }
  return null;
}

const base64url = (buffer: Buffer) => buffer.toString("base64url");

/** The email in an ID token straight from Google's token endpoint over TLS (OpenID Connect allows trusting it unverified there). */
function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><style>body{font:16px/1.6 -apple-system,"PingFang SC",sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f3ee;color:#222}
@media(prefers-color-scheme:dark){body{background:#1b1a19;color:#eee}}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}</style>
<main><h1>${title}</h1><p>${text}</p></main>`;

export interface GoogleConnectionsOptions {
  dataDir: string;
  secrets: SecretStore;
  /** Where every change is recorded as an event; optional for tests. */
  world?: World;
  /** Where to look for google-oauth-client.json; defaults to the data directory. */
  clientDirs?: string[];
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export class GoogleConnections {
  private readonly options: GoogleConnectionsOptions;
  private readonly fetch: typeof fetch;
  private readonly flows = new Map<string, Flow>();
  private readonly indexPath: string;

  constructor(options: GoogleConnectionsOptions) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.indexPath = join(options.dataDir, "connections.json");
  }

  private client(): Client | null {
    return loadGoogleClient(this.options.clientDirs ?? [this.options.dataDir]);
  }

  private accounts(): GoogleAccount[] {
    if (!existsSync(this.indexPath)) return [];
    try { return ((JSON.parse(readFileSync(this.indexPath, "utf8")) as { google?: GoogleAccount[] }).google ?? []); } catch { return []; }
  }

  private saveAccounts(accounts: GoogleAccount[]): void {
    const temp = `${this.indexPath}.tmp`;
    writeFileSync(temp, JSON.stringify({ google: accounts }, null, 2));
    renameSync(temp, this.indexPath);
  }

  private record(kind: string, email: string, payload: Record<string, unknown>): void {
    const world = this.options.world;
    if (!world) return;
    world.tx(() => recordDomainEvent(world, { kind, subject: `google:${email}`, actor: "user", payload: { provider: "google", account: email, ...payload } }));
  }

  /** Saves the OAuth client the user made in Google Cloud and downloaded (a "Desktop app" client's JSON), so a
   * newcomer never has to find the data directory. Checked before it is written; read again on every use. */
  saveClient(file: unknown): GoogleStatus {
    const entry = (file && typeof file === "object" ? (file as Record<string, unknown>).installed : undefined) as { client_id?: unknown; client_secret?: unknown } | undefined;
    if ((file as Record<string, unknown> | null)?.web) throw new GoogleError("google", "This is a web client. Make one of type “Desktop app”.");
    if (!entry || typeof entry.client_id !== "string" || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(entry.client_id) || typeof entry.client_secret !== "string" || !entry.client_secret) {
      throw new GoogleError("google", "This is not a Google OAuth client file.");
    }
    const path = join(this.options.dataDir, "google-oauth-client.json"), temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify({ installed: { client_id: entry.client_id, client_secret: entry.client_secret } }, null, 2), { mode: 0o600 });
    renameSync(temp, path);
    return this.status();
  }

  status(): GoogleStatus {
    const client = this.client();
    return { client: { configured: !!client, source: client ? (client.source === "environment" ? "environment" : "file") : null }, accounts: this.accounts() };
  }

  /** Starts a sign-in: a new account (no `account`), or more capabilities for one already connected. */
  async start(input: { capabilities: GoogleCapability[]; account?: string }): Promise<{ id: string; url: string }> {
    const client = this.client();
    if (!client) throw new GoogleError("no_client", "Isocline has no Google client yet: put google-oauth-client.json in the data directory");
    if (this.flows.size >= 3) throw new GoogleError("busy", "Too many sign-ins in progress; finish or cancel one first");
    const existing = input.account ? this.accounts().find((account) => account.email === input.account) : undefined;
    if (input.account && !existing) throw new GoogleError("unknown_account", `Not connected: ${input.account}`);
    const wanted = [...new Set([...(existing?.capabilities ?? []), ...input.capabilities])];
    const scopes = [...IDENTITY, ...wanted.map((capability) => GOOGLE_CAPABILITIES[capability].scope)];

    const id = base64url(randomBytes(9));
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());

    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const url = `${AUTH_URL}?${new URLSearchParams({
      client_id: client.id, redirect_uri: redirectUri, response_type: "code", scope: scopes.join(" "),
      code_challenge: challenge, code_challenge_method: "S256", state,
      // A refresh token every time, and earlier grants kept (incremental authorization).
      access_type: "offline", prompt: "consent", include_granted_scopes: "true",
      ...(existing ? { login_hint: existing.email } : {}),
    })}`;

    const finish = (status: FlowStatus) => {
      const flow = this.flows.get(id);
      if (!flow || flow.status.status !== "waiting") return;
      flow.status = status;
      clearTimeout(flow.timer);
      // Closed after the browser has its page; the status stays readable a while.
      setTimeout(() => { server.close(); server.closeAllConnections(); }, 1000).unref();
      setTimeout(() => this.flows.delete(id), 5 * 60_000).unref();
    };

    server.on("request", (req, res) => {
      const callback = new URL(req.url ?? "/", "http://127.0.0.1");
      if (callback.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const reply = (status: number, title: string, text: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(page(title, text));
      };
      if (callback.searchParams.get("state") !== state) { reply(400, "链接不对", "这不是 Isocline 发起的登录，或者已经过期了。回到 Isocline 重新点一次「连接」。"); return; }
      const error = callback.searchParams.get("error");
      if (error) {
        finish(error === "access_denied" ? { id, status: "cancelled" } : { id, status: "failed", error });
        reply(200, error === "access_denied" ? "没有连接" : "没连上", error === "access_denied" ? "你在 Google 那边取消了。可以关掉这个页面。" : `Google 返回了错误：${error}`);
        return;
      }
      const code = callback.searchParams.get("code") ?? "";
      this.exchange(client, code, verifier, redirectUri, wanted, existing).then(
        (done) => { finish({ id, status: "done", ...done }); reply(200, "Isocline 连上了 Google", "可以关掉这个页面，回到 Isocline。"); },
        (failure: unknown) => {
          const message = failure instanceof Error ? failure.message : String(failure);
          this.options.log?.(`google sign-in failed: ${message}`);
          finish({ id, status: "failed", error: message });
          reply(500, "没连上", "换 token 的时候出错了。回到 Isocline 再试一次。");
        },
      );
    });

    const timer = setTimeout(() => finish({ id, status: "failed", error: "Sign-in timed out" }), FLOW_TIMEOUT_MS);
    timer.unref();
    this.flows.set(id, { status: { id, status: "waiting", url }, server, timer });
    return { id, url };
  }

  flow(id: string): FlowStatus | null {
    return this.flows.get(id)?.status ?? null;
  }

  cancel(id: string): FlowStatus | null {
    const flow = this.flows.get(id);
    if (!flow) return null;
    if (flow.status.status === "waiting") {
      flow.status = { id, status: "cancelled" };
      clearTimeout(flow.timer);
      flow.server.close();
      flow.server.closeAllConnections();
    }
    return flow.status;
  }

  private async exchange(client: Client, code: string, verifier: string, redirectUri: string, wanted: GoogleCapability[], existing?: GoogleAccount) {
    const response = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new GoogleError("google", `Token exchange failed: ${String(body.error ?? response.status)}`);
    const email = emailOf(body.id_token);
    if (!email) throw new GoogleError("google", "Google did not say which account this is");
    if (existing && existing.email !== email) throw new GoogleError("google", `You signed in as ${email}, not ${existing.email}`);
    const granted = String(body.scope ?? "").split(/\s+/).filter(Boolean);
    const previous = await this.readToken(email);
    const refresh = typeof body.refresh_token === "string" ? body.refresh_token : previous?.refresh;
    if (!refresh) throw new GoogleError("google", "Google did not return a refresh token");
    const token: Token = {
      refresh, scopes: granted,
      ...(typeof body.access_token === "string" ? { access: body.access_token, expires: Date.now() + Number(body.expires_in ?? 0) * 1000 } : {}),
    };
    await this.options.secrets.set(`google:${email}`, JSON.stringify(token));

    // Gmail may grant the broader modify scope alone. It covers reading when the user also requested it.
    const capabilities = wanted.filter((capability) => granted.includes(GOOGLE_CAPABILITIES[capability].scope)
      || (capability === "mailRead" && granted.includes(GOOGLE_CAPABILITIES.mailModify.scope)));
    const missing = wanted.filter((capability) => !capabilities.includes(capability));
    const accounts = this.accounts().filter((account) => account.email !== email);
    const before = this.accounts().find((account) => account.email === email);
    accounts.push({ email, capabilities, connectedAt: before?.connectedAt ?? new Date().toISOString() });
    this.saveAccounts(accounts);
    this.record(before ? "connection.updated" : "connection.connected", email, { capabilities, ...(missing.length ? { notGranted: missing } : {}) });
    this.options.log?.(`google: ${before ? "updated" : "connected"} ${email} (${capabilities.join(", ") || "identity only"})`);
    return { account: email, capabilities, missing };
  }

  /** Turning a capability off needs no Google round trip: Isocline stops using it. Turning one on is `start`. */
  disable(email: string, capability: GoogleCapability): GoogleAccount {
    const accounts = this.accounts();
    const account = accounts.find((item) => item.email === email);
    if (!account) throw new GoogleError("unknown_account", `Not connected: ${email}`);
    if (account.capabilities.includes(capability)) {
      account.capabilities = account.capabilities.filter((item) => item !== capability);
      this.saveAccounts(accounts);
      this.record("connection.updated", email, { capabilities: account.capabilities, turnedOff: capability });
    }
    return account;
  }

  /** Revokes the grant at Google, then forgets the token and the account. */
  async disconnect(email: string): Promise<{ revoked: boolean }> {
    const accounts = this.accounts();
    if (!accounts.some((account) => account.email === email)) throw new GoogleError("unknown_account", `Not connected: ${email}`);
    const token = await this.readToken(email);
    let revoked = false;
    if (token) {
      const response = await this.fetch(REVOKE_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: token.refresh }),
      }).catch(() => null);
      // 400 invalid_token: already revoked on Google's side.
      revoked = !!response && (response.ok || response.status === 400);
    }
    await this.options.secrets.delete(`google:${email}`);
    this.saveAccounts(accounts.filter((account) => account.email !== email));
    this.record("connection.disconnected", email, { revokedAtGoogle: revoked });
    this.options.log?.(`google: disconnected ${email}${revoked ? "" : " (could not reach Google to revoke; remove Isocline at myaccount.google.com/permissions)"}`);
    return { revoked };
  }

  private async readToken(email: string): Promise<Token | undefined> {
    const raw = await this.options.secrets.get(`google:${email}`);
    if (!raw) return undefined;
    try { return JSON.parse(raw) as Token; } catch { return undefined; }
  }

  /** A current access token for an account, refreshed when it is about to expire. For modules that call Google. */
  async accessToken(email: string): Promise<string> {
    const client = this.client();
    if (!client) throw new GoogleError("no_client", "Isocline has no Google client");
    const token = await this.readToken(email);
    if (!token) throw new GoogleError("unknown_account", `Not connected: ${email}`);
    if (token.access && token.expires && token.expires - 60_000 > Date.now()) return token.access;
    const response = await this.fetch(TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: token.refresh, grant_type: "refresh_token" }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof body.access_token !== "string") {
      if (body.error === "invalid_grant") this.markBroken(email);
      throw new GoogleError(body.error === "invalid_grant" ? "broken" : "google", `Refreshing the Google token failed: ${String(body.error ?? response.status)}`);
    }
    const next: Token = { ...token, access: body.access_token, expires: Date.now() + Number(body.expires_in ?? 0) * 1000 };
    await this.options.secrets.set(`google:${email}`, JSON.stringify(next));
    return next.access!;
  }

  private markBroken(email: string): void {
    const accounts = this.accounts();
    const account = accounts.find((item) => item.email === email);
    if (!account || account.broken) return;
    account.broken = true;
    this.saveAccounts(accounts);
    this.record("connection.broken", email, {});
  }

  /** Reads one small count per capability, to show the connection really works. Read-only; the device words it. */
  async check(email: string): Promise<GoogleCheck> {
    const account = this.accounts().find((item) => item.email === email);
    if (!account) throw new GoogleError("unknown_account", `Not connected: ${email}`);
    const access = await this.accessToken(email);
    const get = async (url: string) => {
      const response = await this.fetch(url, { headers: { Authorization: `Bearer ${access}` } });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) throw new GoogleError("google", `${url.split("?")[0]}: ${response.status} ${JSON.stringify(body.error ?? "")}`);
      return body;
    };
    const result: GoogleCheck = {};
    if (account.capabilities.includes("calRead") || account.capabilities.includes("calWrite")) {
      const now = new Date();
      const end = new Date(now.getTime() + 7 * 86_400_000);
      const events = await get(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${new URLSearchParams({ timeMin: now.toISOString(), timeMax: end.toISOString(), singleEvents: "true", maxResults: "50" })}`);
      result.calendar = (events.items as unknown[] | undefined)?.length ?? 0;
    }
    if (account.capabilities.includes("mailRead")) {
      const profile = await get("https://gmail.googleapis.com/gmail/v1/users/me/profile");
      result.gmail = Number(profile.messagesTotal ?? 0);
    }
    return result;
  }

  close(): void {
    for (const id of this.flows.keys()) this.cancel(id);
  }
}
