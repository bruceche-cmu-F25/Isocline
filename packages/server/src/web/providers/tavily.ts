/** Tavily: a search service made for agents; it needs a key, with a monthly free allowance (docs/design/web.md §4.3).
 *
 * Adapted from pi-web-access 0.48.0, `tavily.ts` (the request body, the domain filter, the result mapping):
 * https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon. Its configuration, key pool and activity
 * monitor are Zirma's Settings and keychain here.
 */
import { SearchError, type SearchProvider, type SearchResult } from "./types.ts";

const URL_ = "https://api.tavily.com/search";
const TIMEOUT_MS = 30_000;
const MAX_SNIPPET = 600;

/** Tavily's answer: `{ results: [{ title, url, content, published_date? }] }`. */
export function parseTavily(value: unknown): SearchResult[] {
  const results = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new SearchError("failed", "Tavily sent an answer Zirma cannot read");
  return results.flatMap((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!/^https?:\/\//.test(url)) return [];
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : url;
    const snippet = typeof entry.content === "string" ? entry.content.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET) : "";
    const published = typeof entry.published_date === "string" && entry.published_date ? entry.published_date : null;
    return [{ title, url, snippet, ...(published ? { published } : {}) }];
  });
}

export const tavily: SearchProvider = {
  id: "tavily",
  title: "Tavily",
  needs: "key",
  about: { zh: "专门给 agent 用，每月有免费次数", en: "Made for agents, free searches each month" },
  keyPage: "https://app.tavily.com/home",
  async search(input, secret, signal): Promise<SearchResult[]> {
    if (!secret) throw new SearchError("refused", "Tavily has no key yet");
    let response: Response;
    try {
      response = await fetch(URL_, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: input.query, search_depth: "basic", max_results: input.count, include_answer: false, include_raw_content: false,
          ...(input.freshness ? { time_range: input.freshness } : {}),
          ...(input.site ? { include_domains: [input.site] } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SearchError("failed", "Tavily could not be reached");
    }
    if (response.status === 401 || response.status === 403) throw new SearchError("refused", "Tavily refused the key");
    // 432 and 433 are Tavily's own: the plan's or the pay-as-you-go limit is used up.
    if (response.status === 429 || response.status === 432 || response.status === 433) throw new SearchError("limit", "Tavily's limit is reached for now");
    if (!response.ok) throw new SearchError("failed", `Tavily answered ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new SearchError("failed", "Tavily sent an answer Zirma cannot read"); }
    return parseTavily(body).slice(0, input.count);
  },
};
