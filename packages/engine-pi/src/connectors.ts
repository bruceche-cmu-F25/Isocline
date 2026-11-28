/** Connectors: the MCP servers Zirma's runs can use, managed from Settings on the home node's machine
 * (docs/design/settings-and-connections.md §3.3).
 *
 * The list is `<data>/mcp.json`, the file Pi and other MCP clients read; this class is the only thing that writes it
 * for the user. Secrets never go there: a token or header the user gives, and the tokens of an OAuth sign-in, are in
 * Zirma's secret store (mcp-store.ts). Signing in is pi-mcp's: the client registers itself with the service, the
 * user agrees in the system browser, and the browser comes back to a one-time listener on 127.0.0.1.
 *
 * A server's state is found by reaching it the way a run would (initialize, list its tools) and is kept for a few
 * minutes. Connecting a server only makes its tools available: a tool its server does not mark read-only still asks
 * the user before every call (the engine's gate).
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpAuthRequiredError, McpClient } from "@earendil-works/pi-mcp";
import {
  completeMcpSignIn, listenForLoopbackSignIn, McpOAuthAuthorizationRequiredError, parseWwwAuthenticate, startMcpSignIn, waitForLoopbackSignIn,
  type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
import type { SecretStore } from "@zirma/core";
import type { McpCatalogItem, McpConnector, McpConnectorsResponse, McpSearchResult, McpSignIn, NewMcpConnector } from "@zirma/protocol";
import { MCP_CATALOG } from "./mcp-catalog.ts";
import { findMcpOnMac, MCP_REGISTRY, registryPlan, registryResult, registryScore, type McpPlan, type RegistryEntry } from "./mcp-find.ts";
import { alfredMeta, MCP_NAME, mcpEntryProblem, readMcpFile, shownCommand, shownUrl, writeMcpFile, type ZirmaMeta } from "./mcp-config.ts";
import { createMcpTransport, createMcpVault, MCP_CLIENT_NAME, oauthSettings, usesHeaderAuth, type McpVault } from "./mcp-store.ts";

export class McpConnectorError extends Error {
  override name = "McpConnectorError";
  readonly code: "missing" | "invalid" | "exists" | "busy" | "state" | "unreachable";
  constructor(code: McpConnectorError["code"], message: string) { super(message); this.code = code; }
}

export interface McpConnectorsOptions {
  /** Where `mcp.json` lives (the data directory). */
  dataDir: string;
  secrets: Pick<SecretStore, "get" | "set" | "delete">;
  log?: (message: string) => void;
  /** A connector was added, removed, switched or signed in to or out of. */
  onChange?: (kind: "added" | "removed" | "enabled" | "disabled" | "signed_in" | "signed_out", name: string) => void;
  /** How a server is reached, for tests; the real one otherwise. */
  probe?: (entry: { name: string; config: Record<string, unknown> }) => Promise<Probe>;
  /** The user's home folder, where other agents keep their MCP servers. */
  home?: string;
  /** The MCP Registry, or a stand-in for it. */
  registry?: string;
  fetcher?: typeof fetch;
}

interface Probe { state: "connected" | "needs_login" | "error"; tools?: number; readOnly?: number; error?: string; challenge?: OAuthChallenge; search?: McpSearchTool[] }

/** A connector's tool that searches, as Settings → Web can offer it as a search service (docs/design/web.md §4.2):
 * its name says search and it takes the query as one text field. */
export interface McpSearchTool {
  server: string;
  tool: string;
  description: string;
  /** The field the query goes in, and the one the number of results goes in, if it has one. */
  query: string;
  count?: string;
  /** Other text fields the tool insists on (an "objective", say): the query goes in them too. */
  also?: string[];
}

const QUERY_FIELDS = ["query", "q", "search", "search_query", "searchQuery", "keywords", "term"];
const COUNT_FIELDS = ["numResults", "num_results", "count", "limit", "max_results", "maxResults"];

/** The search tools among a server's tools. */
export function searchToolsOf(server: string, tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>): McpSearchTool[] {
  return tools.flatMap((tool) => {
    if (!/search/i.test(tool.name)) return [];
    const properties = (tool.inputSchema?.properties ?? {}) as Record<string, { type?: unknown }>;
    const required = Array.isArray(tool.inputSchema?.required) ? (tool.inputSchema.required as unknown[]).filter((name): name is string => typeof name === "string") : [];
    const text = (name: string) => properties[name]?.type === "string";
    const query = QUERY_FIELDS.find((name) => text(name)) ?? (required.filter(text).length === 1 ? required.find(text) : undefined);
    if (!query) return [];
    // Another text field it insists on gets the query too; one of another kind Zirma would not know how to fill.
    const also = required.filter((name) => name !== query);
    if (also.some((name) => !text(name))) return [];
    const count = COUNT_FIELDS.find((name) => properties[name]?.type === "number" || properties[name]?.type === "integer");
    return [{ server, tool: tool.name, description: (tool.description ?? "").replace(/\s+/g, " ").trim().slice(0, 200), query, ...(count ? { count } : {}), ...(also.length ? { also } : {}) }];
  });
}
interface Flow { state: McpSignIn; abort: AbortController; timer: NodeJS.Timeout }

const PROBE_TTL_MS = 5 * 60_000;
const REGISTRY_TIMEOUT_MS = 20_000;
/** The `{name}` a registry header template has for the user's value. */
const SLOT = /\{[A-Za-z0-9_.-]+\}/;
const PROBE_TIMEOUT_MS = 20_000;
const SIGN_IN_MS = 5 * 60_000;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

export class McpConnectors {
  readonly #options: McpConnectorsOptions;
  readonly #vault: McpVault;
  readonly #probes = new Map<string, { at: number; probe: Probe }>();
  readonly #probing = new Map<string, Promise<Probe>>();
  readonly #flows = new Map<string, Flow>();

  constructor(options: McpConnectorsOptions) {
    this.#options = options;
    this.#vault = createMcpVault({ secrets: options.secrets, lockDir: options.dataDir });
  }

  #servers(): Record<string, Record<string, unknown>> {
    const file = readMcpFile(this.#options.dataDir);
    if (file.error) throw new McpConnectorError("invalid", file.error);
    return file.servers;
  }

  /** The servers changed: the file is written, and every engine session opens anew on its next turn (a worker
   * compares this stamp with the one it opened with). */
  #save(servers: Record<string, Record<string, unknown>>): void {
    writeMcpFile(this.#options.dataDir, servers);
    this.#stamp();
  }
  #stamp(): void {
    try { writeFileSync(join(this.#options.dataDir, "mcp.rev"), `${Date.now()}-${randomBytes(4).toString("hex")}`); } catch { /* sessions pick it up when they next open */ }
  }

  async #probe(name: string, config: Record<string, unknown>, fresh = false): Promise<Probe> {
    const cached = this.#probes.get(name);
    if (!fresh && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.probe;
    const running = this.#probing.get(name);
    if (running) return running;
    const work = (this.#options.probe ? this.#options.probe({ name, config }) : this.#reach(name, config))
      .catch((error): Probe => ({ state: "error", error: message(error) }))
      .then((probe) => { this.#probes.set(name, { at: Date.now(), probe }); return probe; })
      .finally(() => this.#probing.delete(name));
    this.#probing.set(name, work);
    return work;
  }

  /** Reaches the server as a run would and counts its tools. */
  async #reach(name: string, config: Record<string, unknown>): Promise<Probe> {
    let challenge: OAuthChallenge | undefined;
    const { alfred: _ours, ...plain } = config;
    const secrets = await this.#vault.secrets(name);
    const client = new McpClient({ name: MCP_CLIENT_NAME, version: "1", requestTimeoutMs: PROBE_TIMEOUT_MS });
    try {
      const transport = createMcpTransport({ name, config: plain }, { cwd: this.#options.dataDir, vault: this.#vault, secrets, onChallenge: (found) => { challenge = found; } });
      await client.connect(transport);
      const tools = await client.listTools();
      return {
        state: "connected", tools: tools.length,
        readOnly: tools.filter((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true).length,
        search: searchToolsOf(name, tools),
      };
    } catch (error) {
      if (error instanceof McpOAuthAuthorizationRequiredError) return { state: "needs_login", ...(challenge ? { challenge } : {}) };
      if (error instanceof McpAuthRequiredError) {
        // A header of the user's own was refused: that is an error to fix, not a sign-in to offer.
        if (usesHeaderAuth(config)) return { state: "error", error: "The server refused the token" };
        return { state: "needs_login", challenge: parseWwwAuthenticate(error.wwwAuthenticate) };
      }
      return { state: "error", error: message(error) };
    } finally {
      await client.close().catch(() => {});
    }
  }

  #describe(name: string, config: Record<string, unknown>, meta: ZirmaMeta, probe: Probe | undefined, signedIn: boolean): McpConnector {
    const problem = mcpEntryProblem(name, config);
    const http = typeof config.url === "string";
    const enabled = config.enabled !== false;
    const secret = usesHeaderAuth(config) || !!meta.secretHeaders?.length || !!meta.secretEnv?.length;
    return {
      name,
      title: meta.title ?? name,
      kind: http ? "http" : "stdio",
      where: http ? shownUrl(String(config.url)) : shownCommand(String(config.command ?? ""), Array.isArray(config.args) ? config.args.map(String) : []),
      ...(meta.catalog ? { catalog: meta.catalog } : {}),
      enabled,
      auth: secret ? "secret" : signedIn || probe?.state === "needs_login" ? "oauth" : "none",
      signedIn,
      state: problem ? "error" : !enabled ? "off" : probe?.state ?? "checking",
      ...(problem ? { error: problem } : probe?.error ? { error: probe.error } : {}),
      ...(probe?.tools !== undefined ? { tools: probe.tools, readOnly: probe.readOnly ?? 0 } : {}),
    };
  }

  /** The connectors and the catalog. A server not looked at lately is listed as `checking` and looked at in the
   * background: ask again in a moment (or `check` one and wait). */
  async describe(): Promise<McpConnectorsResponse> {
    const file = readMcpFile(this.#options.dataDir);
    const servers: McpConnector[] = [];
    for (const [name, config] of Object.entries(file.servers)) {
      const meta = alfredMeta(config);
      const usable = !mcpEntryProblem(name, config) && config.enabled !== false;
      const cached = this.#probes.get(name);
      const probe = cached && Date.now() - cached.at < PROBE_TTL_MS ? cached.probe : undefined;
      if (usable && !probe) void this.#probe(name, config);
      const signedIn = typeof config.url === "string" && MCP_NAME.test(name) ? await this.#vault.signedIn(name, config.url).catch(() => false) : false;
      servers.push(this.#describe(name, config, meta, usable ? probe : undefined, signedIn));
    }
    const added = new Set(Object.values(file.servers).map((config) => alfredMeta(config).catalog).filter(Boolean));
    const urls = new Set(Object.values(file.servers).map((config) => config.url).filter((url) => typeof url === "string"));
    const catalog: McpCatalogItem[] = MCP_CATALOG.map((entry) => ({
      id: entry.id, title: entry.title, url: entry.url, auth: entry.auth, about: entry.about,
      ...(entry.token ? { tokenPage: entry.token.page } : {}),
      added: added.has(entry.id) || urls.has(entry.url),
    }));
    const found = findMcpOnMac(this.#home, file.servers).map((item) => item.found);
    return { servers, catalog, found, ...(file.error ? { error: file.error } : {}) };
  }

  get #home(): string { return this.#options.home ?? homedir(); }
  get #registry(): string { return (this.#options.registry ?? MCP_REGISTRY).replace(/\/+$/, ""); }

  async #ask(path: string): Promise<unknown> {
    let response: Response;
    try { response = await (this.#options.fetcher ?? fetch)(`${this.#registry}${path}`, { cache: "no-store", signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) }); }
    catch (error) { throw new McpConnectorError("unreachable", `The MCP Registry could not be reached: ${message(error)}`); }
    if (response.status === 404) throw new McpConnectorError("missing", "The MCP Registry has no such server");
    if (!response.ok) throw new McpConnectorError("unreachable", `The MCP Registry answered ${response.status}`);
    return response.json();
  }

  /** Servers in the MCP Registry whose name has what was typed (its longest word: the registry matches names, not
   * words), best match first. It is asked twice, for names that have the word and for names whose own part starts
   * with it, since a word like "github" is in every `io.github.*` name. Only the ones Zirma can add: an address, or an
   * npm or PyPI package. */
  async search(query: string): Promise<McpSearchResult[]> {
    const typed = query.trim().slice(0, 200);
    if (!typed) throw new McpConnectorError("invalid", "Say what to look for");
    const word = typed.split(/\s+/).sort((a, b) => b.length - a.length)[0];
    const asked = await Promise.allSettled([`/${word}`, word].map((search) => this.#ask(`/v0/servers?search=${encodeURIComponent(search)}&version=latest&limit=100`) as Promise<{ servers?: RegistryEntry[] }>));
    if (asked.every((one) => one.status === "rejected")) throw (asked[0] as PromiseRejectedResult).reason;
    const entries = asked.flatMap((one) => (one.status === "fulfilled" && Array.isArray(one.value.servers) ? one.value.servers : []));
    const servers = readMcpFile(this.#options.dataDir).servers;
    const urls = new Set(Object.values(servers).map((config) => config.url));
    const added = (plan: McpPlan) => (plan.url ? urls.has(plan.url) : Object.values(servers).some((config) => config.command === plan.command && JSON.stringify(config.args ?? []) === JSON.stringify(plan.args ?? [])));
    const seen = new Set<string>();
    const results: McpSearchResult[] = [];
    for (const entry of entries) {
      const result = registryResult(entry, added);
      if (!result || seen.has(result.id)) continue;
      seen.add(result.id);
      results.push(result);
    }
    return results
      .map((result) => ({ result, score: registryScore(result, typed) }))
      .sort((a, b) => b.score - a.score || a.result.id.localeCompare(b.result.id))
      .slice(0, 30)
      .map(({ result }) => result);
  }

  /** A key for a new entry: the plan's own, or with -2, -3… after it when that one is taken. */
  static #free(name: string, servers: Record<string, unknown>): string {
    if (!servers[name]) return name;
    for (let n = 2; n < 100; n += 1) { const next = `${name.slice(0, 60)}-${n}`; if (!servers[next]) return next; }
    throw new McpConnectorError("exists", `There is already a connector named ${name}`);
  }

  async #one(name: string, fresh: boolean): Promise<McpConnector> {
    const config = this.#servers()[name];
    if (!config) throw new McpConnectorError("missing", "No such connector");
    const usable = !mcpEntryProblem(name, config) && config.enabled !== false;
    const probe = usable ? await this.#probe(name, config, fresh) : undefined;
    const signedIn = typeof config.url === "string" ? await this.#vault.signedIn(name, config.url).catch(() => false) : false;
    return this.#describe(name, config, alfredMeta(config), probe, signedIn);
  }

  /** The search tools of the connectors that are on and connected, from what was found when each was last reached
   * (one not reached lately is reached now; with `wait` false, in the background, and it is left out this time). */
  async searchTools(options: { wait?: boolean } = {}): Promise<McpSearchTool[]> {
    const file = readMcpFile(this.#options.dataDir);
    const found = await Promise.all(Object.entries(file.servers).map(async ([name, config]) => {
      if (mcpEntryProblem(name, config) || config.enabled === false) return [];
      if (options.wait === false) {
        const cached = this.#probes.get(name);
        if (!cached || Date.now() - cached.at >= PROBE_TTL_MS) { void this.#probe(name, config); if (!cached) return []; }
        return cached.probe.state === "connected" ? cached.probe.search ?? [] : [];
      }
      const probe = await this.#probe(name, config);
      return probe.state === "connected" ? probe.search ?? [] : [];
    }));
    return found.flat();
  }

  /** Calls one tool of one connector and gives back its text: what a search through a connector runs. The user chose
   * this tool in Settings as a search service; that choice is the permission. */
  async callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; structured?: unknown; isError: boolean }> {
    const config = this.#servers()[server];
    if (!config || mcpEntryProblem(server, config) || config.enabled === false) throw new McpConnectorError("missing", "No such connector");
    const { alfred: _ours, ...plain } = config;
    const secrets = await this.#vault.secrets(server);
    const client = new McpClient({ name: MCP_CLIENT_NAME, version: "1", requestTimeoutMs: PROBE_TIMEOUT_MS });
    try {
      await client.connect(createMcpTransport({ name: server, config: plain }, { cwd: this.#options.dataDir, vault: this.#vault, secrets }));
      const result = await client.callTool(tool, args, { ...(signal ? { signal } : {}), timeoutMs: 30_000 });
      const text = result.content.flatMap((block) => (block.type === "text" ? [block.text] : block.type === "resource" && "text" in block.resource ? [block.resource.text] : [])).join("\n\n");
      return { text, ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}), isError: result.isError === true };
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** Reaches one server now and says how it went. */
  check(name: string): Promise<McpConnector> { return this.#one(name, true); }

  /** Adds a server: one from the catalog (by `catalog`, with its `token` if it takes one), one another agent on this
   * Mac has (`found`), one from the MCP Registry (`registry`, with `values` for what it needs), or the user's own, by
   * address or by command. A secret header or variable goes to the keychain; the file only names it. */
  async add(input: NewMcpConnector): Promise<McpConnector> {
    const servers = this.#servers();
    let name: string;
    let config: Record<string, unknown>;
    const meta: ZirmaMeta = {};
    const secretHeaders: Record<string, string> = {};
    const secretEnv: Record<string, string> = {};
    if (input.found !== undefined || input.registry !== undefined) {
      let plan: McpPlan;
      /** A value from another agent's file is a secret unless it only names an environment variable. */
      let keepPlain = (_value: string) => false;
      if (input.found !== undefined) {
        const hit = findMcpOnMac(this.#home, servers).find((item) => item.found.id === input.found);
        if (!hit) throw new McpConnectorError("missing", "No such server on this Mac, or Zirma already has it");
        plan = hit.plan;
        keepPlain = (value) => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
      } else {
        const id = String(input.registry).trim();
        if (!/^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(id)) throw new McpConnectorError("invalid", "A registry server is named like io.github.owner/server");
        const entry = await this.#ask(`/v0/servers/${encodeURIComponent(id)}/versions/latest`) as RegistryEntry;
        const found = entry.server ? registryPlan(entry.server) : null;
        if (!found) throw new McpConnectorError("invalid", "Zirma cannot add this server: it has no address and no npm or PyPI package");
        // A package runs on this Mac with the user's rights, and nobody checks what is in it: it is added only with a
        // yes to the very command it runs, and not if the registry says something else now.
        if (found.command) {
          const runs = shownCommand(found.command, found.args ?? []);
          if (!input.runs) throw new McpConnectorError("invalid", `This server runs on this Mac (${runs}): say yes to that command first`);
          if (input.runs !== runs) throw new McpConnectorError("state", `This server changed since the search: it now runs ${runs}. Look at it again`);
        }
        plan = found;
        keepPlain = () => true;
      }
      name = McpConnectors.#free(plan.name, servers);
      meta.title = plan.title;
      const plain = (values: Record<string, string> | undefined, secret: Record<string, string>) => {
        const kept: Record<string, string> = {};
        for (const [key, value] of Object.entries(values ?? {})) (keepPlain(value) ? kept : secret)[key] = value;
        return Object.keys(kept).length ? kept : undefined;
      };
      const headers = plain(plan.headers, secretHeaders), env = plain(plan.env, secretEnv);
      config = plan.url
        ? { url: plan.url, ...(headers ? { headers } : {}) }
        : { command: plan.command, ...(plan.args?.length ? { args: plan.args } : {}), ...(env ? { env } : {}) };
      for (const want of plan.inputs) {
        const value = (input.values?.[want.name] ?? "").trim();
        if (!value || /[\r\n]/.test(value)) throw new McpConnectorError("invalid", `Give ${want.name}`);
        if (want.kind === "header") secretHeaders[want.name] = want.template && SLOT.test(want.template) ? want.template.replace(SLOT, value) : value;
        else secretEnv[want.name] = value;
      }
    } else if (input.catalog !== undefined) {
      const entry = MCP_CATALOG.find((candidate) => candidate.id === input.catalog);
      if (!entry) throw new McpConnectorError("invalid", "No such connector in the catalog");
      name = entry.id;
      config = { url: entry.url };
      meta.title = entry.title;
      meta.catalog = entry.id;
      if (entry.auth === "token") {
        const token = (input.token ?? "").trim();
        if (!token || /\s/.test(token)) throw new McpConnectorError("invalid", "Paste the token");
        secretHeaders[entry.token!.header] = entry.token!.value.replace("{token}", token);
      }
    } else {
      name = (input.name ?? "").trim();
      const url = input.url?.trim(), command = input.command?.trim();
      if (!!url === !!command) throw new McpConnectorError("invalid", "Give an address or a command, not both");
      config = url ? { url } : { command, ...(input.args?.length ? { args: input.args } : {}) };
      for (const [key, value] of Object.entries(input.headers ?? {})) {
        if (!HEADER.test(key) || !value || /[\r\n]/.test(value)) throw new McpConnectorError("invalid", `Not a header: ${key}`);
        if (!url) throw new McpConnectorError("invalid", "Headers go with an address");
        secretHeaders[key] = value;
      }
      for (const [key, value] of Object.entries(input.env ?? {})) {
        if (!ENV.test(key) || !value) throw new McpConnectorError("invalid", `Not an environment variable: ${key}`);
        if (!command) throw new McpConnectorError("invalid", "Environment variables go with a command");
        secretEnv[key] = value;
      }
    }
    if (servers[name]) throw new McpConnectorError("exists", `There is already a connector named ${name}`);
    const problem = mcpEntryProblem(name, config);
    if (problem) throw new McpConnectorError("invalid", `Not added: ${problem}`);
    if (Object.keys(secretHeaders).length) meta.secretHeaders = Object.keys(secretHeaders);
    if (Object.keys(secretEnv).length) meta.secretEnv = Object.keys(secretEnv);
    // The secret first: an entry is never written that names a secret the keychain does not hold.
    await this.#vault.setSecrets(name, { headers: secretHeaders, env: secretEnv });
    this.#save({ ...servers, [name]: { ...config, ...(Object.keys(meta).length ? { alfred: meta } : {}) } });
    this.#probes.delete(name);
    this.#options.log?.(`connector added: ${name}`);
    this.#options.onChange?.("added", name);
    return this.#one(name, true);
  }

  async remove(name: string): Promise<void> {
    const servers = this.#servers();
    if (!servers[name]) throw new McpConnectorError("missing", "No such connector");
    for (const [id, flow] of this.#flows) if (flow.state.server === name) this.cancel(id);
    const { [name]: _gone, ...rest } = servers;
    this.#save(rest);
    this.#probes.delete(name);
    if (MCP_NAME.test(name)) await this.#vault.forget(name);
    this.#options.log?.(`connector removed: ${name}`);
    this.#options.onChange?.("removed", name);
  }

  async setEnabled(name: string, enabled: boolean): Promise<McpConnector> {
    const servers = this.#servers();
    const config = servers[name];
    if (!config) throw new McpConnectorError("missing", "No such connector");
    if ((config.enabled !== false) !== enabled) {
      const { enabled: _was, ...rest } = config;
      this.#save({ ...servers, [name]: enabled ? rest : { ...rest, enabled: false } });
      this.#probes.delete(name);
      this.#options.onChange?.(enabled ? "enabled" : "disabled", name);
    }
    return this.#one(name, false);
  }

  /** Starts a sign-in: the page to open in the system browser, and a listener on 127.0.0.1 it comes back to.
   * `done` at once when the kept tokens could simply be refreshed. */
  async login(name: string): Promise<McpSignIn> {
    const config = this.#servers()[name];
    if (!config) throw new McpConnectorError("missing", "No such connector");
    if (typeof config.url !== "string" || mcpEntryProblem(name, config)) throw new McpConnectorError("state", "Only a remote connector is signed in to");
    if (usesHeaderAuth(config)) throw new McpConnectorError("state", "This connector uses a token, not a sign-in");
    for (const [id, flow] of this.#flows) if (flow.state.server === name && flow.state.status === "waiting") this.cancel(id);

    const serverUrl = config.url;
    const store = this.#vault.oauth(name, serverUrl);
    const settings = oauthSettings(config);
    const challenge = this.#probes.get(name)?.probe.challenge;
    const abort = new AbortController();
    const id = randomBytes(9).toString("base64url");
    const loopback = await listenForLoopbackSignIn({ serverUrl, store, settings });
    const options = { serverUrl, store, settings, clientName: MCP_CLIENT_NAME, redirectUrl: loopback.redirectUrl, ...(challenge ? { challenge } : {}), signal: abort.signal };
    const finish = (state: McpSignIn) => {
      const flow = this.#flows.get(id);
      if (flow && flow.state.status !== "waiting") return;
      if (flow) { clearTimeout(flow.timer); flow.state = state; }
      void loopback.callback.close().catch(() => {});
      // Kept a while, so the device that started it can read how it ended.
      setTimeout(() => this.#flows.delete(id), 10 * 60_000).unref();
    };
    const signedIn = () => {
      this.#probes.delete(name);
      this.#stamp();
      this.#options.log?.(`connector signed in: ${name}`);
      this.#options.onChange?.("signed_in", name);
    };
    let start: Awaited<ReturnType<typeof startMcpSignIn>>;
    try {
      start = await startMcpSignIn(options);
    } catch (error) {
      await loopback.callback.close().catch(() => {});
      throw new McpConnectorError("state", `Sign-in could not start: ${message(error)}`);
    }
    if (start.kind === "authorized") {
      await loopback.callback.close().catch(() => {});
      signedIn();
      return { id, server: name, status: "done" };
    }
    const authorization = start;
    const timer = setTimeout(() => abort.abort(), SIGN_IN_MS);
    timer.unref();
    this.#flows.set(id, { state: { id, server: name, status: "waiting", url: authorization.authorizationUrl }, abort, timer });
    void waitForLoopbackSignIn({ callback: loopback.callback, authorization, signal: abort.signal })
      .then((response) => completeMcpSignIn({ ...options, authorization, response }))
      .then(
        () => { signedIn(); finish({ id, server: name, status: "done" }); },
        (error) => finish(abort.signal.aborted ? { id, server: name, status: "cancelled" } : { id, server: name, status: "failed", error: message(error) }),
      );
    return this.#flows.get(id)!.state;
  }

  flow(id: string): McpSignIn | null { return this.#flows.get(id)?.state ?? null; }

  cancel(id: string): McpSignIn | null {
    const flow = this.#flows.get(id);
    if (!flow) return null;
    if (flow.state.status === "waiting") {
      flow.abort.abort();
      clearTimeout(flow.timer);
      flow.state = { id, server: flow.state.server, status: "cancelled" };
    }
    return flow.state;
  }

  /** Forgets the sign-in here (the tokens and the registered client). The grant at the service is the user's to
   * remove there; MCP has no way to revoke it from here. */
  async logout(name: string): Promise<McpConnector> {
    if (!this.#servers()[name]) throw new McpConnectorError("missing", "No such connector");
    await this.#vault.signOut(name);
    this.#probes.delete(name);
    this.#stamp();
    this.#options.onChange?.("signed_out", name);
    return this.#one(name, true);
  }

  close(): void {
    for (const [id] of this.#flows) this.cancel(id);
  }
}
