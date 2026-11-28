/** Finding connectors to add, the way Settings › Skills finds skills: the MCP servers other agents on this Mac already
 * have (read from their own config files, copied in on request), and the official MCP Registry
 * (registry.modelcontextprotocol.io), searched by name.
 *
 * Nothing here writes or runs anything. What is found is turned into what `McpConnectors.add` takes; a value another
 * agent keeps in its file (an environment variable, a header) is only read when that server is added, and then goes
 * to the keychain like any other secret.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FoundMcpServer, McpInput, McpSearchResult } from "@zirma/protocol";
import { MCP_NAME, mcpEntryProblem, shownCommand, shownUrl } from "./mcp-config.ts";

/** What a found server or a registry entry becomes: an address with headers, or a command with its environment.
 * `fixed` values are written to `mcp.json` as they are; `secret` ones go to the keychain. */
export interface McpPlan {
  name: string;
  title: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** What the user still has to give (a token, a folder): its name, and for a header the template it fills. */
  inputs: Array<McpInput & { template?: string }>;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const texts = (value: unknown): Record<string, string> | undefined => {
  if (!record(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) if (typeof item === "string") out[key] = item;
  return Object.keys(out).length ? out : undefined;
};
const strings = (value: unknown): string[] | undefined => (Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined);

/** A key in `mcp.json` from a name someone else gave (letters, digits, - and _). */
export function mcpKey(name: string): string {
  const key = name.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return MCP_NAME.test(key) ? key : "server";
}

// ---------------------------------------------------------------------------------------------------------------
// On this Mac

/** Where other agents keep their MCP servers, from the home folder; earlier wins when two have one name. */
const PLACES: ReadonlyArray<{ label: string; path: string; key?: string; toml?: true }> = [
  { label: "Claude Code", path: ".claude.json" },
  { label: "Claude", path: "Library/Application Support/Claude/claude_desktop_config.json" },
  { label: "Cursor", path: ".cursor/mcp.json" },
  { label: "Codex", path: ".codex/config.toml", toml: true },
  { label: "VS Code", path: "Library/Application Support/Code/User/mcp.json", key: "servers" },
  { label: "Windsurf", path: ".codeium/windsurf/mcp_config.json" },
  { label: "Gemini CLI", path: ".gemini/settings.json" },
  { label: "Pi", path: ".pi/agent/mcp.json" },
];

/** The value of one TOML line's right side, for the few shapes an MCP entry uses: strings, lists of strings,
 * inline tables of strings, booleans and numbers. Anything else is undefined, and the key is skipped. */
function tomlValue(text: string): unknown {
  const value = text.trim();
  if (value.startsWith('"')) { try { return JSON.parse(value) as unknown; } catch { return undefined; } }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1);
  if (value === "true" || value === "false") return value === "true";
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    const items = splitTop(inner).map(tomlValue);
    return items.every((item) => typeof item === "string") ? items : undefined;
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const table: Record<string, unknown> = {};
    for (const pair of splitTop(value.slice(1, -1))) {
      const at = pair.indexOf("=");
      if (at < 0) return undefined;
      table[tomlKey(pair.slice(0, at))] = tomlValue(pair.slice(at + 1));
    }
    return table;
  }
  return undefined;
}
const tomlKey = (text: string) => text.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2");
/** Splits at the commas that are not inside a string, a list or a table. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0, quote = "", start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === "\\" && quote === '"') i += 1; else if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}
/** Brackets still open at the end of a line, outside strings (a list that goes on to the next line). */
function open(text: string): number {
  let depth = 0, quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === "\\" && quote === '"') i += 1; else if (c === quote) quote = ""; continue; }
    if (c === "#") break;
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
  }
  return depth;
}
const uncomment = (line: string) => { let quote = ""; for (let i = 0; i < line.length; i += 1) { const c = line[i]; if (quote) { if (c === "\\" && quote === '"') i += 1; else if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c; else if (c === "#") return line.slice(0, i); } return line; };

/** Codex's `[mcp_servers.<name>]` tables (and their `.env` and `.http_headers`), read without a TOML library. */
export function codexServers(text: string): Record<string, Record<string, unknown>> {
  const servers: Record<string, Record<string, unknown>> = {};
  let table: Record<string, unknown> | null = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    let line = uncomment(lines[i]).trim();
    if (!line) continue;
    const header = /^\[([^\[\]]+)\]$/.exec(line);
    if (header) {
      const path = header[1].split(".").map(tomlKey);
      table = null;
      if (path[0] !== "mcp_servers" || path.length < 2 || path.length > 3) continue;
      const server = servers[path[1]] ??= {};
      if (path.length === 2) table = server;
      else if (path[2] === "env" || path[2] === "http_headers") table = (server[path[2]] ??= {}) as Record<string, unknown>;
      continue;
    }
    while (open(line) > 0 && i + 1 < lines.length) line += ` ${uncomment(lines[++i]).trim()}`;
    const at = line.indexOf("=");
    if (!table || at < 0) continue;
    const value = tomlValue(line.slice(at + 1).replace(/,\s*\]$/, "]"));
    if (value !== undefined) table[tomlKey(line.slice(0, at))] = value;
  }
  return servers;
}

/** One entry of another agent's file, as Zirma would keep it, or null when it is not one Zirma can use. */
function plainEntry(name: string, entry: unknown): { url?: string; headers?: Record<string, string>; command?: string; args?: string[]; env?: Record<string, string> } | null {
  if (!record(entry) || entry.disabled === true || entry.enabled === false) return null;
  if (entry.type === "sse" || entry.transport === "sse") return null;
  const url = [entry.url, entry.serverUrl, entry.httpUrl].find((item): item is string => typeof item === "string");
  const plain = url
    ? { url, ...(texts(entry.headers ?? entry.http_headers) ? { headers: texts(entry.headers ?? entry.http_headers) } : {}) }
    : typeof entry.command === "string"
      ? { command: entry.command, ...(strings(entry.args)?.length ? { args: strings(entry.args) } : {}), ...(texts(entry.env) ? { env: texts(entry.env) } : {}) }
      : null;
  if (!plain || mcpEntryProblem(mcpKey(name), plain)) return null;
  // VS Code asks for these when it starts the server; there is nothing here to copy.
  if (JSON.stringify(plain).includes("${input:")) return null;
  return plain;
}

export interface FoundOnMac { found: FoundMcpServer; plan: McpPlan }

/** MCP servers other agents on this Mac have and Zirma does not (by name, address or command). */
export function findMcpOnMac(home: string, mine: Record<string, Record<string, unknown>>): FoundOnMac[] {
  const names = new Set(Object.keys(mine));
  const wheres = new Set(Object.values(mine).map((config) => (typeof config.url === "string" ? config.url : [config.command, ...(strings(config.args) ?? [])].join(" "))));
  const out: FoundOnMac[] = [];
  for (const place of PLACES) {
    const path = join(home, place.path);
    if (!existsSync(path)) continue;
    let servers: Record<string, unknown> = {};
    try {
      const text = readFileSync(path, "utf8");
      if (place.toml) servers = codexServers(text);
      else { const parsed: unknown = JSON.parse(text); const list = record(parsed) ? parsed[place.key ?? "mcpServers"] : undefined; if (record(list)) servers = list; }
    } catch { continue; }
    for (const [name, entry] of Object.entries(servers)) {
      const plain = plainEntry(name, entry);
      if (!plain) continue;
      const key = mcpKey(name);
      const where = plain.url ?? [plain.command, ...(plain.args ?? [])].join(" ");
      if (names.has(key) || wheres.has(where)) continue;
      names.add(key);
      wheres.add(where);
      out.push({
        found: {
          id: `${place.label}:${name}`, name, kind: plain.url ? "http" : "stdio", place: place.label,
          where: plain.url ? shownUrl(plain.url) : shownCommand(plain.command!, plain.args ?? []),
        },
        plan: { name: key, title: name, ...plain, inputs: [] },
      });
    }
  }
  return out.sort((a, b) => a.found.name.localeCompare(b.found.name));
}

// ---------------------------------------------------------------------------------------------------------------
// The MCP Registry

export const MCP_REGISTRY = "https://registry.modelcontextprotocol.io";

interface RegistryInput { name?: unknown; description?: unknown; isRequired?: unknown; isSecret?: unknown; value?: unknown; default?: unknown }
interface RegistryArgument extends RegistryInput { type?: unknown; valueHint?: unknown }
interface RegistryServer {
  name?: unknown; title?: unknown; description?: unknown; version?: unknown; websiteUrl?: unknown;
  repository?: { url?: unknown };
  remotes?: Array<{ type?: unknown; url?: unknown; headers?: RegistryInput[] }>;
  packages?: Array<{ registryType?: unknown; identifier?: unknown; version?: unknown; transport?: { type?: unknown }; environmentVariables?: RegistryInput[]; packageArguments?: RegistryArgument[] }>;
}
export interface RegistryEntry { server?: RegistryServer; _meta?: Record<string, { status?: unknown } | undefined> }

const text = (value: unknown, max = 300) => (typeof value === "string" ? value.trim().slice(0, max) : "");
/** A `{name}` in a header template the user fills. */
const SLOT = /\{[A-Za-z0-9_.-]+\}/;

/** What a registry entry becomes: its streamable HTTP address if it has one (nothing to install), or else an npm or
 * PyPI package run with npx or uvx. Null when it has neither, or needs arguments Zirma cannot fill. */
export function registryPlan(server: RegistryServer): McpPlan | null {
  const name = text(server.name, 200);
  if (!name) return null;
  // `com.notion/mcp`: when its own part says nothing, the publisher's name does.
  const [publisher, own = ""] = name.split("/");
  const short = /^(mcp|server|mcp-server|remote|api)$/i.test(own) ? publisher.split(".").pop()! : own;
  const title = text(server.title, 80) || short;
  const base = { name: mcpKey(short), title };
  const remote = server.remotes?.find((item) => item.type === "streamable-http" && typeof item.url === "string" && /^https:\/\//i.test(item.url) && !SLOT.test(item.url));
  if (remote) {
    const headers: Record<string, string> = {};
    const inputs: McpPlan["inputs"] = [];
    for (const header of remote.headers ?? []) {
      const key = text(header.name, 64);
      if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) continue;
      const value = text(header.value, 500);
      if (value && !SLOT.test(value) && header.isSecret !== true) { headers[key] = value; continue; }
      if (header.isRequired !== true) continue;
      inputs.push({ name: key, kind: "header", secret: header.isSecret !== false, ...(text(header.description) ? { description: text(header.description) } : {}), ...(value ? { template: value } : {}) });
    }
    return { ...base, url: String(remote.url), ...(Object.keys(headers).length ? { headers } : {}), inputs };
  }
  for (const pkg of server.packages ?? []) {
    const id = text(pkg.identifier, 200), version = text(pkg.version, 60);
    if (!id || (pkg.transport?.type && pkg.transport.type !== "stdio")) continue;
    const runner = pkg.registryType === "npm" ? { command: "npx", args: ["-y", version ? `${id}@${version}` : id] }
      : pkg.registryType === "pypi" ? { command: "uvx", args: [version ? `${id}==${version}` : id] }
        : null;
    if (!runner) continue;
    let usable = true;
    for (const argument of pkg.packageArguments ?? []) {
      const value = text(argument.value, 500) || text(argument.default, 500);
      if (!value) { if (argument.isRequired === true) usable = false; continue; }
      if (argument.type === "named" && text(argument.name, 80)) runner.args.push(text(argument.name, 80), value);
      else runner.args.push(value);
    }
    if (!usable) continue;
    const env: Record<string, string> = {};
    const inputs: McpPlan["inputs"] = [];
    for (const variable of pkg.environmentVariables ?? []) {
      const key = text(variable.name, 64);
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;
      const value = text(variable.value, 500);
      if (value && !SLOT.test(value) && variable.isSecret !== true) { env[key] = value; continue; }
      if (variable.isRequired !== true) continue;
      inputs.push({ name: key, kind: "env", secret: variable.isSecret === true, ...(text(variable.description) ? { description: text(variable.description) } : {}) });
    }
    return { ...base, ...runner, ...(Object.keys(env).length ? { env } : {}), inputs };
  }
  return null;
}

/** A registry entry as a search result, or null when it cannot be added. */
export function registryResult(entry: RegistryEntry, added: (plan: McpPlan) => boolean): McpSearchResult | null {
  const server = entry.server;
  if (!server || Object.values(entry._meta ?? {}).some((meta) => meta?.status === "deleted")) return null;
  const plan = registryPlan(server);
  if (!plan) return null;
  const page = [server.websiteUrl, server.repository?.url].find((url): url is string => typeof url === "string" && /^https:\/\//i.test(url));
  return {
    id: text(server.name, 200), title: plan.title, description: text(server.description),
    kind: plan.url ? "http" : "stdio", where: plan.url ? shownUrl(plan.url) : shownCommand(plan.command!, plan.args ?? []),
    ...(page ? { page } : {}),
    inputs: plan.inputs.map(({ template: _t, ...input }) => input),
    added: added(plan),
  };
}

/** How well a result matches what was typed: its own name first, then its title, its full name, its description.
 * A publisher named the word (`io.github.github`, `com.notion`) is most likely the service's own server. One with an
 * address comes before one to install. */
export function registryScore(result: McpSearchResult, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const slug = result.id.toLowerCase().split("/").pop() ?? "";
  const title = result.title.toLowerCase();
  const full = result.id.toLowerCase();
  const about = result.description.toLowerCase();
  const publisher = full.split("/")[0].split(".").pop() ?? "";
  let score = 0;
  for (const word of words) {
    if (publisher === word) score += 100;
    score += slug === word || title === word ? 100
      : slug.startsWith(word) || title.startsWith(word) ? 60
        : slug.includes(word) || title.includes(word) ? 40
          : full.includes(word) ? 20
            : about.includes(word) ? 10 : 0;
  }
  return score + (result.kind === "http" ? 5 : 0) + (result.inputs.length === 0 ? 3 : 0) + (result.description ? 2 : 0);
}
