/** Brave Search: its own index, not Google's or Bing's; it needs a key (docs/design/web.md §4.3).
 *
 * Adapted from pi-web-access 0.48.0, `brave.ts` (the request, the freshness codes, the site filter, `stripHtml`):
 * https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon. Its configuration and key handling are
 * Zirma's Settings and keychain here; its rate-limit coordinator is not borrowed: a limit sends the search on to the
 * next service in the user's list instead.
 */
import { SearchError, type SearchInput, type SearchProvider, type SearchResult } from "./types.ts";

const URL_ = "https://api.search.brave.com/res/v1/web/search";
const TIMEOUT_MS = 30_000;
const MAX_SNIPPET = 600;

const FRESHNESS: Record<NonNullable<SearchInput["freshness"]>, string> = { day: "pd", week: "pw", month: "pm", year: "py" };

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–",
  "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘", "&rdquo;": "”", "&ldquo;": "“", "&middot;": "·", "&bull;": "•", "&deg;": "°",
};

/** Brave marks the matched words with tags and escapes the rest. */
export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#(x?)([0-9a-f]+)|[a-z]+);/gi, (entity, hex: string | undefined, digits: string | undefined) => {
      if (!digits) return ENTITIES[entity.toLowerCase()] ?? entity;
      const code = Number.parseInt(digits, hex ? 16 : 10);
      return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Brave's answer: `{ web: { results: [{ title, url, description, page_age? }] } }`. */
export function parseBrave(value: unknown, site?: string): SearchResult[] {
  const results = (value as { web?: { results?: unknown } } | null)?.web?.results;
  if (results === undefined && value && typeof value === "object") return [];
  if (!Array.isArray(results)) throw new SearchError("failed", "Brave sent an answer Zirma cannot read");
  return results.flatMap((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const url = typeof entry.url === "string" ? entry.url : "";
    if (!/^https?:\/\//.test(url)) return [];
    if (site) {
      try { const host = new URL(url).hostname.toLowerCase(); if (host !== site && !host.endsWith(`.${site}`)) return []; } catch { return []; }
    }
    const published = typeof entry.page_age === "string" && entry.page_age ? entry.page_age : null;
    return [{
      title: stripHtml(typeof entry.title === "string" ? entry.title : "") || url, url,
      snippet: stripHtml(typeof entry.description === "string" ? entry.description : "").slice(0, MAX_SNIPPET),
      ...(published ? { published } : {}),
    }];
  });
}

export const brave: SearchProvider = {
  id: "brave",
  title: "Brave",
  needs: "key",
  about: { zh: "自己的索引，不靠 Google 或 Bing", en: "Its own index, not Google's or Bing's" },
  keyPage: "https://api-dashboard.search.brave.com/app/keys",
  async search(input, secret, signal): Promise<SearchResult[]> {
    if (!secret) throw new SearchError("refused", "Brave has no key yet");
    const site = input.site?.toLowerCase();
    const params = new URLSearchParams({ q: site ? `${input.query} site:${site}` : input.query, count: String(site ? 20 : input.count) });
    if (input.freshness) params.set("freshness", FRESHNESS[input.freshness]);
    let response: Response;
    try {
      response = await fetch(`${URL_}?${params}`, {
        headers: { "X-Subscription-Token": secret, Accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SearchError("failed", "Brave could not be reached");
    }
    // Brave answers a key it does not know with 422 as well as with 401.
    if (response.status === 401 || response.status === 403 || response.status === 422) throw new SearchError("refused", "Brave refused the key");
    if (response.status === 429) throw new SearchError("limit", "Brave's limit is reached for now");
    if (!response.ok) throw new SearchError("failed", `Brave answered ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new SearchError("failed", "Brave sent an answer Zirma cannot read"); }
    return parseBrave(body, site).slice(0, input.count);
  },
};
