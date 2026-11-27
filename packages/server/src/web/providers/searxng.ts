/** SearXNG: a search engine the user runs themself; queries go to no third party but the engines it asks
 * (docs/design/web.md §4.3). It needs an address, and its JSON answer switched on in `settings.yml`.
 *
 * Adapted from pi-web-access 0.48.0, `searxng.ts` (the address clean-up, the request, the site filter):
 * https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon. Its configuration is Zirma's Settings here.
 * The address is the user's own and may be on this Mac or the home network, so it is reached as given; only the
 * user sets it, in Settings on this Mac.
 */
import { SearchError, type SearchProvider, type SearchResult } from "./types.ts";

const TIMEOUT_MS = 30_000;
const MAX_SNIPPET = 600;

/** An address as it is kept: http or https, no password, no query, without a trailing `/search`; null when it is
 * not one. */
export function searxngAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/search$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** SearXNG's answer: `{ results: [{ title, url, content, publishedDate? }] }`. */
export function parseSearxng(value: unknown, site?: string): SearchResult[] {
  const results = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new SearchError("failed", "SearXNG sent an answer Zirma cannot read");
  return results.flatMap((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const url = typeof entry.url === "string" ? entry.url : "";
    if (!/^https?:\/\//.test(url)) return [];
    if (site) {
      try { const host = new URL(url).hostname.toLowerCase(); if (host !== site && !host.endsWith(`.${site}`)) return []; } catch { return []; }
    }
    const published = typeof entry.publishedDate === "string" && entry.publishedDate ? entry.publishedDate : null;
    return [{
      title: typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : url, url,
      snippet: typeof entry.content === "string" ? entry.content.replace(/\s+/g, " ").trim().slice(0, MAX_SNIPPET) : "",
      ...(published ? { published } : {}),
    }];
  });
}

export const searxng: SearchProvider = {
  id: "searxng",
  title: "SearXNG",
  needs: "address",
  about: { zh: "你自己架的，免费，查询不经过第三方", en: "Your own, free, no third party sees the queries" },
  keyPage: "https://docs.searxng.org/admin/installation.html",
  async search(input, address, signal): Promise<SearchResult[]> {
    const base = address ? searxngAddress(address) : null;
    if (!base) throw new SearchError("refused", "SearXNG has no address yet");
    const site = input.site?.toLowerCase();
    const url = new URL(`${base}/search`);
    url.searchParams.set("q", site ? `${input.query} site:${site}` : input.query);
    url.searchParams.set("format", "json");
    if (input.freshness) url.searchParams.set("time_range", input.freshness);
    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SearchError("failed", `SearXNG could not be reached at ${base}`);
    }
    // SearXNG answers 403 to format=json until json is added to search.formats in settings.yml.
    if (response.status === 403) throw new SearchError("refused", "SearXNG does not answer in JSON yet: add json under search: formats: in its settings.yml, then restart it");
    if (response.status === 429) throw new SearchError("limit", "SearXNG's limiter is holding searches back for now");
    if (!response.ok) throw new SearchError("failed", `SearXNG answered ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new SearchError("refused", "SearXNG answered with a page, not JSON: add json under search: formats: in its settings.yml, then restart it"); }
    return parseSearxng(body, site).slice(0, input.count);
  },
};
