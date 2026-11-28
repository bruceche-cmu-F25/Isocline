/** Serper: Google's results through an API; it needs a key, with free searches to start (docs/design/web.md §4.3).
 *
 * Adapted from pi-web-access 0.48.0, `serper.ts` (the request, the recency codes, the site filter, the result mapping):
 * https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon. Its configuration, key handling and activity
 * monitor are Zirma's Settings and keychain here.
 */
import { SearchError, type SearchInput, type SearchProvider, type SearchResult } from "./types.ts";

const URL_ = "https://google.serper.dev/search";
const TIMEOUT_MS = 30_000;
const MAX_SNIPPET = 600;
const RECENCY: Record<NonNullable<SearchInput["freshness"]>, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

/** Serper's answer: `{ organic: [{ title, link, snippet, date? }] }`. A site is checked again, as Google may stray. */
export function parseSerper(value: unknown, site?: string): SearchResult[] {
  const organic = (value as { organic?: unknown } | null)?.organic;
  if (!Array.isArray(organic)) throw new SearchError("failed", "Serper sent an answer Zirma cannot read");
  const matches = (url: string) => {
    if (!site) return true;
    try { const host = new URL(url).hostname.toLowerCase(); return host === site || host.endsWith(`.${site}`); } catch { return false; }
  };
  return organic.flatMap((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const url = typeof entry.link === "string" ? entry.link.trim() : "";
    if (!/^https?:\/\//.test(url) || !matches(url)) return [];
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : url;
    const snippet = typeof entry.snippet === "string" ? entry.snippet.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET) : "";
    const published = typeof entry.date === "string" && entry.date ? entry.date : null;
    return [{ title, url, snippet, ...(published ? { published } : {}) }];
  });
}

export const serper: SearchProvider = {
  id: "serper",
  title: "Serper",
  needs: "key",
  about: { zh: "Google 的结果", en: "Google's results" },
  keyPage: "https://serper.dev/api-keys",
  async search(input, secret, signal): Promise<SearchResult[]> {
    if (!secret) throw new SearchError("refused", "Serper has no key yet");
    const site = input.site?.toLowerCase();
    let response: Response;
    try {
      response = await fetch(URL_, {
        method: "POST",
        headers: { "X-API-KEY": secret, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          q: site ? `${input.query} site:${site}` : input.query,
          num: site ? Math.min(20, input.count + 5) : input.count,
          ...(input.freshness ? { tbs: RECENCY[input.freshness] } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SearchError("failed", "Serper could not be reached");
    }
    if (response.status === 401 || response.status === 403) throw new SearchError("refused", "Serper refused the key");
    // Serper says a used-up account with 400 "Not enough credits".
    if (response.status === 429 || response.status === 402) throw new SearchError("limit", "Serper's limit is reached for now");
    if (!response.ok) {
      const said = await response.text().catch(() => "");
      if (/credit/i.test(said)) throw new SearchError("limit", "Serper's credits are used up");
      throw new SearchError("failed", `Serper answered ${response.status}`);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new SearchError("failed", "Serper sent an answer Zirma cannot read"); }
    return parseSerper(body, site).slice(0, input.count);
  },
};
