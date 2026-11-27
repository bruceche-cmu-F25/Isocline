/** Exa: its MCP endpoint, free and rate-limited without a key; with the user's own key (sent as `x-api-key`, as
 * Exa's docs say) the limit is the account's (docs/design/web.md §4.3).
 *
 * Adapted from pi-web-access 0.48.0, `exa.ts` (`callExaMcp`, `parseMcpResults`, `buildMcpQuery`):
 * https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon. Its configuration and key handling are left
 * Zirma's Settings and keychain here; filters fold into the query as its basic tool expects.
 */
import { SearchError, type SearchInput, type SearchProvider, type SearchResult } from "./types.ts";

const MCP_URL = "https://mcp.exa.ai/mcp";
const TOOL = "web_search_exa";
const TIMEOUT_MS = 20_000;
const MAX_SNIPPET = 600;

/** The basic tool reads only the query and the count, so a site and a time span are said in the query. */
export function exaQuery(input: SearchInput, now = new Date()): string {
  const parts = [input.query];
  if (input.site) parts.push(`site:${input.site}`);
  switch (input.freshness) {
    case "day": parts.push("past 24 hours"); break;
    case "week": parts.push("past week"); break;
    case "month": parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`); break;
    case "year": parts.push(String(now.getFullYear())); break;
  }
  return parts.join(" ");
}

interface RpcAnswer {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean; _meta?: Record<string, unknown> };
  error?: { code?: number; message?: string };
}

/** The JSON-RPC answer in a reply that is either plain JSON or a server-sent event stream. */
function answerIn(body: string): RpcAnswer | null {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const candidate = JSON.parse(line.slice(5).trim()) as RpcAnswer;
      if (candidate?.result || candidate?.error) return candidate;
    } catch { /* another line */ }
  }
  try {
    const candidate = JSON.parse(body) as RpcAnswer;
    return candidate?.result || candidate?.error ? candidate : null;
  } catch { return null; }
}

/** The tool's text: blocks that start `Title:`, with `URL:`, `Published:`, `Author:`, then `Text:` or `Highlights:`. */
export function parseExaText(text: string): SearchResult[] {
  return text.split(/(?=^Title: )/m).filter((block) => block.trim()).flatMap((block) => {
    const title = /^Title: (.+)/m.exec(block)?.[1]?.trim() ?? "";
    const url = /^URL: (.+)/m.exec(block)?.[1]?.trim() ?? "";
    if (!/^https?:\/\//.test(url)) return [];
    let start = block.length;
    let content = "";
    const textAt = block.indexOf("\nText: ");
    const highlights = /\nHighlights:\s*\n/.exec(block);
    if (textAt >= 0) { content = block.slice(textAt + 7); start = textAt; } else if (highlights) { content = block.slice(highlights.index + highlights[0].length); start = highlights.index; }
    // Metadata is read from the header only: a quoted "Published:" in the page text is not the source's.
    const published = /^Published: (.+)/m.exec(block.slice(0, start))?.[1]?.trim();
    const snippet = content.replace(/\n---\s*$/, "").replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET);
    return [{ title: title || url, url, snippet, ...(published && published !== "N/A" ? { published } : {}) }];
  });
}

export const exa: SearchProvider = {
  id: "exa",
  title: "Exa",
  needs: "nothing",
  about: { zh: "不用 key 就能搜，有免费额度；填 key 额度更多", en: "Works with no key on a free quota; a key raises it" },
  keyPage: "https://dashboard.exa.ai/api-keys",
  async search(input, secret, signal): Promise<SearchResult[]> {
    let response: Response;
    try {
      response = await fetch(`${MCP_URL}?tools=${TOOL}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-exa-source": "zirma", ...(secret ? { "x-api-key": secret } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: TOOL, arguments: { query: exaQuery(input), numResults: input.count } } }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SearchError("failed", "Exa could not be reached");
    }
    if (response.status === 429) throw new SearchError("limit", secret ? "Exa's limit for this key is reached for now" : "Exa's free search limit is reached for now");
    if (response.status === 401 || response.status === 403) throw new SearchError("refused", "Exa refused the key");
    if (!response.ok) throw new SearchError("failed", `Exa answered ${response.status}`);
    const answer = answerIn(await response.text());
    if (!answer) throw new SearchError("failed", "Exa sent an empty answer");
    if (answer.error) throw new SearchError("failed", `Exa: ${answer.error.message ?? "an error"}`);
    // The free endpoint answers a rate limit with 200 and this flag, not a 429.
    if (answer.result?._meta?.["ai.exa/rateLimited"] === true) throw new SearchError("limit", "Exa's free search limit is reached for now");
    const text = answer.result?.content?.find((item) => item.type === "text" && item.text?.trim())?.text ?? "";
    if (answer.result?.isError) throw new SearchError("failed", `Exa: ${text.trim().slice(0, 200) || "an error"}`);
    return parseExaText(text).slice(0, input.count);
  },
};
