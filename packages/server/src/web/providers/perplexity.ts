/** Perplexity's Search API: ranked results with dates; it needs a key (docs/design/web.md §4.3).
 *
 * Adapted from pi-web-access 0.48.0, `perplexity.ts` (the Search API request, the recency and domain filters, the
 * result mapping): https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon. Its configuration, rate
 * limiter and activity monitor are Zirma's Settings, keychain and fallback here; its chat-completions path is not used.
 */
import { SearchError, type SearchProvider, type SearchResult } from "./types.ts";

const URL_ = "https://api.perplexity.ai/search";
const TIMEOUT_MS = 30_000;
const MAX_SNIPPET = 600;

/** Perplexity's answer: `{ results: [{ title, url, snippet, date?, last_updated? }] }`. */
export function parsePerplexity(value: unknown): SearchResult[] {
  const results = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new SearchError("failed", "Perplexity sent an answer Zirma cannot read");
  return results.flatMap((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    if (!/^https?:\/\//.test(url)) return [];
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : url;
    const snippet = typeof entry.snippet === "string" ? entry.snippet.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET) : "";
    const published = [entry.date, entry.last_updated].find((date): date is string => typeof date === "string" && date !== "") ?? null;
    return [{ title, url, snippet, ...(published ? { published } : {}) }];
  });
}

export const perplexity: SearchProvider = {
  id: "perplexity",
  title: "Perplexity",
  needs: "key",
  about: { zh: "排好序的结果，带日期", en: "Ranked results with dates" },
  keyPage: "https://www.perplexity.ai/account/api/keys",
  async search(input, secret, signal): Promise<SearchResult[]> {
    if (!secret) throw new SearchError("refused", "Perplexity has no key yet");
    let response: Response;
    try {
      response = await fetch(URL_, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: input.query, max_results: input.count,
          ...(input.freshness ? { search_recency_filter: input.freshness } : {}),
          ...(input.site ? { search_domain_filter: [input.site] } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SearchError("failed", "Perplexity could not be reached");
    }
    if (response.status === 401 || response.status === 403) throw new SearchError("refused", "Perplexity refused the key");
    if (response.status === 429 || response.status === 402) throw new SearchError("limit", "Perplexity's limit is reached for now");
    if (!response.ok) throw new SearchError("failed", `Perplexity answered ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new SearchError("failed", "Perplexity sent an answer Zirma cannot read"); }
    return parsePerplexity(body).slice(0, input.count);
  },
};
