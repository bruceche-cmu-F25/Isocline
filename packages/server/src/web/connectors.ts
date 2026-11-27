/** A connector's search tool as a search service (docs/design/web.md §4.2 「用连接器里的」): the user picks one of the
 * tools a connected MCP server offers, and `web_search` calls it on the home node like any other service. Its id is
 * `mcp:<server>:<tool>`.
 *
 * Every server answers in its own shape, so the answer is read loosely: a list of results with addresses if it sends
 * one (as structured content or as JSON text), or else every address in its text, each with the lines around it.
 */
import { SearchError, type SearchProvider, type SearchResult } from "./providers/index.ts";

export interface ConnectorTool { server: string; tool: string; description: string; query: string; count?: string; also?: string[] }

/** What the connectors give Web: their search tools, and a way to call one. */
export interface ConnectorSearch {
  /** With `wait` false, only the servers already reached lately (the rest are reached in the background). */
  searchTools(options?: { wait?: boolean }): Promise<ConnectorTool[]>;
  callTool(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; structured?: unknown; isError: boolean }>;
}

export const CONNECTOR_ID = /^mcp:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_.\-/]{1,128})$/;
export const connectorId = (server: string, tool: string) => `mcp:${server}:${tool}`;

const MAX_SNIPPET = 600;
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/g;
const tidy = (value: string) => value.replace(/\s+/g, " ").trim();

function fromItems(items: unknown[]): SearchResult[] {
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const url = [entry.url, entry.link, entry.href].find((value): value is string => typeof value === "string" && /^https?:\/\//.test(value));
    if (!url) return [];
    const title = [entry.title, entry.name].find((value): value is string => typeof value === "string" && value.trim() !== "");
    const snippet = [entry.snippet, entry.content, entry.description, entry.text, entry.summary, entry.highlights]
      .map((value) => (Array.isArray(value) ? value.filter((part) => typeof part === "string").join(" ") : value))
      .find((value): value is string => typeof value === "string" && value.trim() !== "");
    const published = [entry.published, entry.publishedDate, entry.published_date, entry.date].find((value): value is string => typeof value === "string" && value !== "");
    return [{ title: title ? tidy(title) : url, url, snippet: snippet ? tidy(snippet).slice(0, MAX_SNIPPET) : "", ...(published ? { published } : {}) }];
  });
}

/** The list of results in a JSON value: the value itself, or the first list of objects with addresses under a key. */
function listIn(value: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(value)) return value.some((item) => item && typeof item === "object") ? value : null;
  if (!value || typeof value !== "object" || depth > 3) return null;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = listIn(child, depth + 1);
    if (found && fromItems(found).length) return found;
  }
  return null;
}

/** Results in a tool's plain text: each address once, titled by a `Title:` line or a Markdown link before it, with the
 * text around it as the snippet. */
function fromText(text: string): SearchResult[] {
  const blocks = text.split(/\n\s*\n|\n(?=Title:)/);
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const block of blocks) {
    for (const match of block.matchAll(URL_IN_TEXT)) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      if (seen.has(url)) continue;
      seen.add(url);
      const link = new RegExp(`\\[([^\\]]{1,300})\\]\\(${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(block)?.[1];
      const titled = /^Title:\s*(.+)$/m.exec(block)?.[1];
      const snippet = tidy(block.replace(/^(Title|URL|Published( Date)?|Author|Text|Highlights):\s*/gm, "").replace(URL_IN_TEXT, "").replace(/\[([^\]]*)\]\(\s*\)/g, "$1"));
      out.push({ title: tidy(link ?? titled ?? url), url, snippet: snippet.slice(0, MAX_SNIPPET) });
      break;
    }
  }
  return out;
}

export function parseConnectorAnswer(answer: { text: string; structured?: unknown }): SearchResult[] {
  const structured = answer.structured !== undefined ? listIn(answer.structured) : null;
  if (structured) { const found = fromItems(structured); if (found.length) return found; }
  const trimmed = answer.text.trim();
  if (/^[[{]/.test(trimmed)) {
    try { const list = listIn(JSON.parse(trimmed)); if (list) { const found = fromItems(list); if (found.length) return found; } } catch { /* text after all */ }
  }
  return fromText(answer.text);
}

/** One connector tool as a search service. */
/** A tool's description as one short line: its first sentence. */
export function firstSentence(text: string): string {
  const line = tidy(text);
  const end = line.search(/(?<=[.!?])\s|(?<=[。！？])/);
  const sentence = end > 0 ? line.slice(0, end) : line;
  return sentence.length > 90 ? `${sentence.slice(0, 89).trimEnd()}…` : sentence;
}

export function connectorProvider(source: ConnectorSearch, tool: ConnectorTool): SearchProvider {
  const title = `${tool.server} · ${tool.tool}`;
  const about = firstSentence(tool.description);
  return {
    id: connectorId(tool.server, tool.tool),
    title,
    needs: "nothing",
    about: { zh: about || "连接器里的搜索工具", en: about || "A connector's search tool" },
    async search(input, _secret, signal): Promise<SearchResult[]> {
      const query = [input.query, input.site ? `site:${input.site}` : ""].filter(Boolean).join(" ");
      let answer: Awaited<ReturnType<ConnectorSearch["callTool"]>>;
      try {
        answer = await source.callTool(tool.server, tool.tool, { ...Object.fromEntries((tool.also ?? []).map((name) => [name, query])), [tool.query]: query, ...(tool.count ? { [tool.count]: input.count } : {}) }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new SearchError("failed", `${title} could not be reached: ${(error as Error).message.slice(0, 200)}`);
      }
      if (answer.isError) throw new SearchError(/limit|quota|rate/i.test(answer.text) ? "limit" : "failed", `${title}: ${tidy(answer.text).slice(0, 200) || "the tool reported an error"}`);
      const results = parseConnectorAnswer(answer);
      if (!results.length && answer.text.trim()) throw new SearchError("failed", `${title} answered without addresses Zirma can read`);
      return results.slice(0, input.count);
    },
  };
}
