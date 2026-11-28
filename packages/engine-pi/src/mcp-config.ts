/** Zirma's MCP servers: `<config>/mcp.json`, in the format Pi, Claude Desktop
 * and other MCP clients use ({ "mcpServers": { name: { command, args, env } |
 * { url, headers } } }). `${VAR}` placeholders in headers and env are filled from
 * the environment when a server is connected. Invalid entries are skipped and
 * reported; they never stop the rest.
 *
 * Secrets are not in this file. A header or an environment variable the user
 * gave in Settings is kept in the keychain (mcp-store.ts), and the entry only
 * names it, under `alfred`, with what else Zirma itself knows about the entry
 * (its title, the catalog entry it came from). Other clients ignore that key,
 * and Pi is handed the entry without it.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface McpServerEntry {
  name: string;
  config: Record<string, unknown>;
  source: string;
  scope: "global";
}
export interface LoadedMcpConfig { servers: McpServerEntry[]; errors: string[] }

/** What Zirma keeps with an entry, beside what every MCP client reads. */
export interface ZirmaMeta {
  /** How the entry is named to the user; its key in the file otherwise. */
  title?: string;
  /** The catalog entry it was added from. */
  catalog?: string;
  /** Header names whose values are in the keychain. */
  secretHeaders?: string[];
  /** Environment variable names whose values are in the keychain. */
  secretEnv?: string[];
}

export const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const stringRecord = (value: unknown) => record(value) && Object.values(value).every((item) => typeof item === "string");

/** Why an entry cannot be used, or null. */
export function mcpEntryProblem(name: string, config: unknown): string | null {
  return !MCP_NAME.test(name) ? "names use letters, digits, - and _"
    : !record(config) ? "an entry is an object"
    : typeof config.command !== "string" && typeof config.url !== "string" ? "needs a command or a url"
    : typeof config.url === "string" && !/^https?:\/\//i.test(config.url) ? "a url starts with http:// or https://"
    : config.args !== undefined && !strings(config.args) ? "args is a list of strings"
    : config.env !== undefined && !stringRecord(config.env) ? "env values are strings"
    : config.headers !== undefined && !stringRecord(config.headers) ? "header values are strings"
    : config.type === "sse" ? "the SSE transport is not supported; use the server's streamable HTTP URL"
    : null;
}

export const mcpPath = (dir: string) => join(dir, "mcp.json");

/** What Zirma keeps with an entry. */
export function alfredMeta(config: Record<string, unknown>): ZirmaMeta {
  const meta = record(config.alfred) ? config.alfred : {};
  return {
    ...(typeof meta.title === "string" ? { title: meta.title } : {}),
    ...(typeof meta.catalog === "string" ? { catalog: meta.catalog } : {}),
    ...(strings(meta.secretHeaders) ? { secretHeaders: meta.secretHeaders } : {}),
    ...(strings(meta.secretEnv) ? { secretEnv: meta.secretEnv } : {}),
  };
}

/** The file's entries exactly as written (Zirma's own key included), or what is wrong with the file. */
export function readMcpFile(dir: string): { servers: Record<string, Record<string, unknown>>; error?: string } {
  const path = mcpPath(dir);
  if (!existsSync(path)) return { servers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { servers: {}, error: `${path}: ${error instanceof Error ? error.message : "invalid JSON"}` };
  }
  const servers = record(parsed) ? parsed.mcpServers : undefined;
  if (!record(servers)) return { servers: {}, error: `${path}: expected { "mcpServers": { ... } }` };
  return { servers: servers as Record<string, Record<string, unknown>> };
}

/** Writes the entries back, keeping whatever else the file holds, in one step (a temporary file, then a rename). */
export function writeMcpFile(dir: string, servers: Record<string, Record<string, unknown>>): void {
  const path = mcpPath(dir);
  let rest: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(readFileSync(path, "utf8")); if (record(parsed)) rest = parsed; } catch { /* a new file */ }
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...rest, mcpServers: servers }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** The servers as Pi takes them: valid entries only, without Zirma's own key. */
export function loadZirmaMcpConfig(dir: string): LoadedMcpConfig {
  const path = mcpPath(dir);
  const file = readMcpFile(dir);
  const result: LoadedMcpConfig = { servers: [], errors: file.error ? [file.error] : [] };
  for (const [name, config] of Object.entries(file.servers)) {
    const problem = mcpEntryProblem(name, config);
    if (problem) { result.errors.push(`${path}: server "${name}": ${problem}`); continue; }
    const { alfred: _ours, ...plain } = config;
    result.servers.push({ name, config: plain, source: path, scope: "global" });
  }
  return result;
}

/** Names that mean a credential, in a URL's query or a command's arguments (after pi-web's Settings › MCP, github.com/agegr/pi-web, MIT). */
const SECRET_WORD = /(key|token|secret|passw(or)?d|passphrase|credential|auth)/i;
const MASK = "•••";
/** A server's address as it is shown: without a password in it, and without the values of query parameters. */
export function shownUrl(text: string): string {
  try {
    const url = new URL(text);
    if (url.password) url.password = MASK;
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, MASK);
    return url.href.replaceAll(encodeURIComponent(MASK), MASK);
  } catch { return text; }
}
/** A command line as it is shown: a value given to an option that names a credential is masked. */
export function shownCommand(command: string, args: readonly string[]): string {
  const shown = args.map((arg, index) => {
    const pair = /^(--?[^=]+)=(.+)$/.exec(arg);
    if (pair && SECRET_WORD.test(pair[1])) return `${pair[1]}=${MASK}`;
    const before = args[index - 1];
    return before?.startsWith("-") && !before.includes("=") && SECRET_WORD.test(before) ? MASK : arg;
  });
  return [command, ...shown].join(" ").slice(0, 300);
}
