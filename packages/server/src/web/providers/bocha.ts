/** 博查 (Bocha): a search service with good coverage of Chinese pages; it needs a key (docs/design/web.md §4.3).
 *
 * Adapted from pi-web-access 0.48.0, `bocha.ts` (the request, `mapFreshness`, `parseSearchResponse`, the site filter):
 * https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon. Its configuration and key handling are
 * Zirma's Settings and keychain here.
 */
import { SearchError, type SearchInput, type SearchProvider, type SearchResult } from "./types.ts";

const URL_ = "https://api.bochaai.com/v1/web-search";
const TIMEOUT_MS = 30_000;
const MAX_SNIPPET = 600;

const FRESHNESS: Record<NonNullable<SearchInput["freshness"]>, string> = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" };

const text = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim() ?? null;

/** Bocha's answer: `{ code, msg, data: { webPages: { value: [{ name, url, summary, snippet, datePublished }] } } }`. */
export function parseBocha(value: unknown, site?: string): SearchResult[] {
  if (!value || typeof value !== "object") throw new SearchError("failed", "Bocha sent an answer Zirma cannot read");
  const envelope = value as { code?: unknown; msg?: unknown; data?: { webPages?: { value?: unknown } } };
  if (envelope.code !== undefined && Number(envelope.code) !== 200) throw new SearchError("failed", `Bocha: ${text(envelope.msg) ?? `code ${String(envelope.code)}`}`);
  const items = envelope.data?.webPages?.value;
  if (!Array.isArray(items)) throw new SearchError("failed", "Bocha sent an answer Zirma cannot read");
  const matches = (url: string) => {
    if (!site) return true;
    try { const host = new URL(url).hostname.toLowerCase(); return host === site || host.endsWith(`.${site}`); } catch { return false; }
  };
  return items.flatMap((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const url = text(entry.url, entry.link);
    if (!url || !/^https?:\/\//.test(url) || !matches(url)) return [];
    const published = text(entry.datePublished, entry.dateLastCrawled);
    return [{
      title: text(entry.name, entry.title) ?? url, url,
      snippet: (text(entry.summary, entry.snippet) ?? "").replace(/\s+/g, " ").slice(0, MAX_SNIPPET),
      ...(published ? { published } : {}),
    }];
  });
}

export const bocha: SearchProvider = {
  id: "bocha",
  title: "Bocha",
  zhTitle: "博查",
  needs: "key",
  about: { zh: "中文网页搜得全", en: "Strong on Chinese pages" },
  keyPage: "https://open.bochaai.com/",
  async search(input, secret, signal): Promise<SearchResult[]> {
    if (!secret) throw new SearchError("refused", "Bocha has no key yet");
    const site = input.site?.toLowerCase();
    let response: Response;
    try {
      response = await fetch(URL_, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
        // A site is filtered here, so more results are asked for than are kept.
        body: JSON.stringify({ query: input.query, count: site ? Math.min(50, input.count * 3) : input.count, freshness: input.freshness ? FRESHNESS[input.freshness] : "noLimit", summary: true }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SearchError("failed", "Bocha could not be reached");
    }
    if (response.status === 401 || response.status === 403) throw new SearchError("refused", "Bocha refused the key");
    if (response.status === 429) throw new SearchError("limit", "Bocha's limit is reached for now");
    if (!response.ok) throw new SearchError("failed", `Bocha answered ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new SearchError("failed", "Bocha sent an answer Zirma cannot read"); }
    return parseBocha(body, site).slice(0, input.count);
  },
};
