/** What Settings → Web holds (docs/design/web.md §4, §6): whether the web tools are on, the search services in the
 * order they are tried, the sites that open without asking, the keys (in the secret store, never in a file), and a
 * short record of what was searched and opened (on this home node only).
 *
 * `<data>/web.json` holds the settings, `<data>/web-log.json` the record. Both are read on every use, so a change in
 * Settings applies to the very next search; there is nothing to reload.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretStore } from "@zirma/core";
import { CONNECTOR_ID, connectorProvider, type ConnectorSearch } from "./connectors.ts";
import { PROVIDERS, READERS, type ReaderProvider, type ReadPage, type SearchProvider, type SearchResult } from "./providers/index.ts";
import { searxngAddress } from "./providers/searxng.ts";

export interface WebConfig {
  on: boolean;
  /** Search services, by id, in the order they are tried. A connector's tool is `mcp:<server>:<tool>`. */
  search: string[];
  /** Reading services, by id, in the order they are tried when Zirma cannot read a page itself. */
  read: string[];
  /** The address of each service the user runs themself (SearXNG), by id. */
  addresses: Record<string, string>;
  /** Host names whose pages open without asking (a site covers its subdomains). */
  sites: string[];
}

export interface WebLogEntry {
  at: string;
  kind: "search" | "open";
  /** The query, or the address. */
  what: string;
  /** The service that answered a search, or read a page Zirma could not. */
  provider?: string;
}

const DEFAULTS: WebConfig = { on: true, search: ["exa"], read: ["jina"], sites: [], addresses: {} };
const MAX_LOG = 50;
const MAX_SITES = 200;
const MAX_KEY = 500;
/** The page a reading service's "Try it" reads: a plain public page that is there for exactly this. */
const TEST_PAGE = "https://example.com/";
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

export class WebSettingsError extends Error {
  override name = "WebSettingsError";
}

/** A site as it is kept: a host name, lower case, without `www.`; null when it is not one. */
export function siteOf(input: string): string | null {
  let host = input.trim().toLowerCase();
  try { if (/^[a-z]+:\/\//.test(host)) host = new URL(host).hostname; } catch { return null; }
  host = host.replace(/\/.*$/, "").replace(/^www\./, "");
  return HOST.test(host) ? host : null;
}

const localDay = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/** Where a model provider's API key comes from (engine-pi's ModelAccounts). */
export interface ModelKeys {
  apiKey(providerId: string): Promise<string | null>;
}

export class WebAccess {
  readonly #dir: string;
  readonly #secrets: Pick<SecretStore, "get" | "set" | "delete">;
  readonly #providers: readonly SearchProvider[];
  readonly #readers: readonly ReaderProvider[];
  /** Services that said their limit was reached, and on which day: they go last for the rest of that day. */
  readonly #limited = new Map<string, string>();
  /** The connectors' search tools, once the home node has its connectors (cli.ts sets this). */
  connectors: ConnectorSearch | null = null;
  /** The API keys of model providers the user added under Models, for the services that search with one (cli.ts
   * sets this). Only a plain API key comes back, never a subscription sign-in (docs/design/web.md §4.6). */
  modelKeys: ModelKeys | null = null;

  constructor(options: { dataDir: string; secrets: Pick<SecretStore, "get" | "set" | "delete">; providers?: readonly SearchProvider[]; readers?: readonly ReaderProvider[]; connectors?: ConnectorSearch; modelKeys?: ModelKeys }) {
    this.#dir = options.dataDir;
    this.#secrets = options.secrets;
    this.#providers = options.providers ?? PROVIDERS;
    this.#readers = options.readers ?? READERS;
    this.connectors = options.connectors ?? null;
    this.modelKeys = options.modelKeys ?? null;
  }

  /** What a service needs to search: its key, its address, or its model provider's API key. */
  async secretFor(provider: SearchProvider): Promise<string | null> {
    if (CONNECTOR_ID.test(provider.id)) return null;
    if (provider.needs === "address") return this.config().addresses[provider.id] ?? null;
    if (provider.needs === "model") return provider.modelProvider ? await this.modelKeys?.apiKey(provider.modelProvider).catch(() => null) ?? null : null;
    return this.key(provider.id).catch(() => null);
  }

  /** The search services Zirma itself knows. */
  get providers(): readonly SearchProvider[] { return this.#providers; }
  get readers(): readonly ReaderProvider[] { return this.#readers; }

  /** The connectors' search tools as services; none when there are no connectors or they cannot be listed. With
   * `wait` false, only what is known already (Settings does not wait for a server to answer). */
  async connectorProviders(wait = true): Promise<SearchProvider[]> {
    const source = this.connectors;
    if (!source) return [];
    const tools = await source.searchTools({ wait }).catch(() => []);
    return tools.map((tool) => connectorProvider(source, tool));
  }

  #read<T>(name: string, fallback: T): T {
    const path = join(this.#dir, name);
    if (!existsSync(path)) return fallback;
    try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return fallback; }
  }

  #write(name: string, value: unknown): void {
    const path = join(this.#dir, name);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }

  /** The settings as they are now; anything unknown or damaged in the file falls back to the defaults. */
  config(): WebConfig {
    const saved = this.#read<Partial<WebConfig>>("web.json", {});
    const known = new Set(this.#providers.map((provider) => provider.id));
    // A connector's tool stays in the list while its server is away; a search skips it until it is back.
    const search = (id: unknown): id is string => typeof id === "string" && (known.has(id) || CONNECTOR_ID.test(id));
    const readers = new Set(this.#readers.map((reader) => reader.id));
    const addresses: Record<string, string> = {};
    if (saved.addresses && typeof saved.addresses === "object") {
      for (const [id, value] of Object.entries(saved.addresses)) {
        const address = typeof value === "string" && this.#needsAddress(id) ? searxngAddress(value) : null;
        if (address) addresses[id] = address;
      }
    }
    return {
      on: typeof saved.on === "boolean" ? saved.on : DEFAULTS.on,
      search: Array.isArray(saved.search) ? [...new Set(saved.search.filter(search))] : DEFAULTS.search.filter((id) => known.has(id)),
      read: Array.isArray(saved.read) ? [...new Set(saved.read.filter((id): id is string => typeof id === "string" && readers.has(id)))] : DEFAULTS.read.filter((id) => readers.has(id)),
      sites: Array.isArray(saved.sites) ? [...new Set(saved.sites.flatMap((site) => (typeof site === "string" ? siteOf(site) ?? [] : [])))] : [],
      addresses,
    };
  }

  update(patch: Partial<WebConfig>): WebConfig {
    const next = this.config();
    if (patch.on !== undefined) {
      if (typeof patch.on !== "boolean") throw new WebSettingsError("on is true or false");
      next.on = patch.on;
    }
    if (patch.search !== undefined) {
      if (!Array.isArray(patch.search) || patch.search.some((id) => typeof id !== "string" || !(this.#providers.some((provider) => provider.id === id) || CONNECTOR_ID.test(id)))) throw new WebSettingsError("search lists known services");
      next.search = [...new Set(patch.search)];
    }
    if (patch.read !== undefined) {
      if (!Array.isArray(patch.read) || patch.read.some((id) => typeof id !== "string" || !this.#readers.some((reader) => reader.id === id))) throw new WebSettingsError("read lists known services");
      next.read = [...new Set(patch.read)];
    }
    if (patch.sites !== undefined) {
      if (!Array.isArray(patch.sites) || patch.sites.length > MAX_SITES) throw new WebSettingsError("sites is a list of host names");
      const sites = patch.sites.map((site) => (typeof site === "string" ? siteOf(site) : null));
      if (sites.some((site) => !site)) throw new WebSettingsError("Each site is a host name, like example.com");
      next.sites = [...new Set(sites as string[])];
    }
    this.#write("web.json", next);
    return next;
  }

  /** Whether an address's site opens without asking. */
  allowed(address: string): boolean {
    let host: string;
    try { host = new URL(address).hostname.toLowerCase().replace(/^www\./, ""); } catch { return false; }
    return this.config().sites.some((site) => host === site || host.endsWith(`.${site}`));
  }

  allowSite(address: string): void {
    const site = siteOf(address);
    if (!site) return;
    const { sites } = this.config();
    if (!sites.includes(site)) this.update({ sites: [...sites, site] });
  }

  #needsAddress(id: string): boolean {
    return this.#providers.some((provider) => provider.id === id && provider.needs === "address");
  }

  /** A service Zirma itself knows, for search or for reading. */
  #service(id: string): SearchProvider | ReaderProvider {
    const service = this.#providers.find((candidate) => candidate.id === id) ?? this.#readers.find((candidate) => candidate.id === id);
    if (!service) throw new WebSettingsError(`No web service ${id}`);
    return service;
  }

  /** Sets (or, with an empty value, removes) the address of a service the user runs themself. */
  setAddress(id: string, value: string): void {
    if (!this.#needsAddress(id)) throw new WebSettingsError(`${id} takes no address`);
    const next = this.config();
    if (!value.trim()) delete next.addresses[id];
    else {
      const address = searxngAddress(value);
      if (!address) throw new WebSettingsError("An address is http or https, like http://localhost:8080");
      next.addresses[id] = address;
    }
    this.#write("web.json", next);
  }

  /** Where a service's key is kept: its own id, or for the reading side of one that also searches, the search side's. */
  #keyName(id: string): string {
    const service = this.#service(id);
    return `web:${"keyOf" in service && service.keyOf ? service.keyOf : id}`;
  }

  async key(id: string): Promise<string | null> {
    return (await this.#secrets.get(this.#keyName(id))) ?? null;
  }

  async setKey(id: string, key: string): Promise<void> {
    const name = this.#keyName(id);
    const value = key.trim();
    if (!value || value.length > MAX_KEY || /\s/.test(value)) throw new WebSettingsError("A key is one word with no spaces");
    await this.#secrets.set(name, value);
  }

  async deleteKey(id: string): Promise<void> {
    await this.#secrets.delete(this.#keyName(id));
  }

  /** The services a search tries, in order, each with what it needs (its key, or its address). One that lacks what it
   * needs, or a connector's tool whose server is away, is left out. */
  async order(): Promise<Array<{ provider: SearchProvider; secret: string | null }>> {
    const { search } = this.config();
    const connected = search.some((id) => CONNECTOR_ID.test(id)) ? await this.connectorProviders() : [];
    const out: Array<{ provider: SearchProvider; secret: string | null }> = [];
    for (const id of search) {
      const provider = this.#providers.find((candidate) => candidate.id === id) ?? connected.find((candidate) => candidate.id === id);
      if (!provider) continue;
      const secret = await this.secretFor(provider);
      if (provider.needs !== "nothing" && !CONNECTOR_ID.test(id) && !secret) continue;
      out.push({ provider, secret });
    }
    // One whose limit ran out today is tried only after the others (and still tried, if they all fail).
    return [...out.filter(({ provider }) => !this.limitedToday(provider.id)), ...out.filter(({ provider }) => this.limitedToday(provider.id))];
  }

  markLimited(id: string, now = new Date()): void { this.#limited.set(id, localDay(now)); }
  limitedToday(id: string, now = new Date()): boolean { return this.#limited.get(id) === localDay(now); }

  /** The reading services, in order, each with its key if the user added one. */
  async readerOrder(): Promise<Array<{ reader: ReaderProvider; secret: string | null }>> {
    const out: Array<{ reader: ReaderProvider; secret: string | null }> = [];
    for (const id of this.config().read) {
      const reader = this.#readers.find((candidate) => candidate.id === id);
      if (!reader) continue;
      const secret = await this.key(id).catch(() => null);
      if (reader.needs === "key" && !secret) continue;
      out.push({ reader, secret });
    }
    return out;
  }

  /** The first service a search would try, by what the settings say (for the step's line, before it runs). */
  first(): { id: string; title: string } | null {
    const id = this.config().search[0];
    if (!id) return null;
    const known = this.#providers.find((provider) => provider.id === id);
    const connector = CONNECTOR_ID.exec(id);
    return known ? { id, title: known.title } : connector ? { id, title: `${connector[1]} · ${connector[2]}` } : null;
  }

  log(entry: Omit<WebLogEntry, "at">): void {
    const list = this.records();
    list.unshift({ at: new Date().toISOString(), ...entry, what: entry.what.slice(0, 300) });
    try { this.#write("web-log.json", list.slice(0, MAX_LOG)); } catch { /* a record is not worth failing a search */ }
  }

  records(): WebLogEntry[] {
    const list = this.#read<unknown>("web-log.json", []);
    return Array.isArray(list) ? (list as WebLogEntry[]).filter((entry) => entry && typeof entry.at === "string" && typeof entry.what === "string").slice(0, MAX_LOG) : [];
  }

  clearRecords(): void { this.#write("web-log.json", []); }

  /** How many searches each service answered today (local time), from the record. */
  today(now = new Date()): Record<string, number> {
    const day = localDay(now);
    const counts: Record<string, number> = {};
    for (const entry of this.records()) {
      if (entry.kind === "search" && entry.provider && localDay(new Date(entry.at)) === day) counts[entry.provider] = (counts[entry.provider] ?? 0) + 1;
    }
    return counts;
  }

  /** One search with one service, as Settings' "Try it" runs it; for a reading service, one page read. */
  async test(id: string, query: string): Promise<{ results: SearchResult[]; ms: number; page?: { title: string | null; chars: number } }> {
    const started = Date.now();
    const signal = AbortSignal.timeout(45_000);
    const reader = this.#readers.find((candidate) => candidate.id === id);
    if (reader) {
      const page: ReadPage = await reader.read(TEST_PAGE, await this.key(id), signal);
      return { results: [], ms: Date.now() - started, page: { title: page.title, chars: page.text.length } };
    }
    const provider = this.#providers.find((candidate) => candidate.id === id) ?? (CONNECTOR_ID.test(id) ? (await this.connectorProviders()).find((candidate) => candidate.id === id) : undefined);
    if (!provider) throw new WebSettingsError(`No web service ${id}`);
    const secret = await this.secretFor(provider);
    const results = await provider.search({ query, count: 3 }, secret, signal);
    return { results, ms: Date.now() - started };
  }
}
