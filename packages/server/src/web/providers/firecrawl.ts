/** Firecrawl: a search service that also reads hard pages (ones that need scripts or turn robots away); one key
 * serves both (docs/design/web.md §4.3).
 *
 * Adapted from pi-web-access 0.48.0, `firecrawl.ts` (the v2 search and scrape requests, the recency codes, the
 * result and page mapping): https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon. Its configuration,
 * self-hosted base address and redirect checks are left out; Zirma's Settings and keychain hold the key.
 */
import { SearchError, type ReaderProvider, type ReadPage, type SearchInput, type SearchProvider, type SearchResult } from "./types.ts";

const BASE = "https://api.firecrawl.dev/v2";
const SEARCH_TIMEOUT_MS = 45_000;
const SCRAPE_TIMEOUT_MS = 60_000;
const MAX_SNIPPET = 600;
const RECENCY: Record<NonNullable<SearchInput["freshness"]>, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };
const ABOUT = { zh: "能搜，也能读难读的页面", en: "Searches, and reads hard pages" };
const KEY_PAGE = "https://www.firecrawl.dev/app/api-keys";

const text = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim() ?? null;

/** The `data` of a Firecrawl answer, or why there is none. */
function envelope(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SearchError("failed", "Firecrawl sent an answer Zirma cannot read");
  const body = value as { success?: unknown; error?: unknown; data?: unknown };
  if (body.success === false) throw new SearchError("failed", `Firecrawl: ${text(body.error) ?? "it could not do it"}`);
  return body.data;
}

/** Firecrawl's search answer: `{ success, data: { web: [{ url, title, description }] } }` (an older one gave the list as `data`). */
export function parseFirecrawlSearch(value: unknown): SearchResult[] {
  const data = envelope(value);
  const web = Array.isArray(data) ? data : (data as { web?: unknown } | null)?.web;
  if (!Array.isArray(web)) throw new SearchError("failed", "Firecrawl sent an answer Zirma cannot read");
  const seen = new Set<string>();
  return web.flatMap((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const meta = (entry.metadata ?? {}) as Record<string, unknown>;
    const url = text(entry.url, meta.sourceURL, meta.url);
    if (!url || !/^https?:\/\//.test(url) || seen.has(url)) return [];
    seen.add(url);
    return [{ title: text(entry.title, meta.title) ?? url, url, snippet: (text(entry.description, entry.snippet, meta.description) ?? "").replace(/\s+/g, " ").slice(0, MAX_SNIPPET) }];
  });
}

/** Firecrawl's scrape answer: `{ success, data: { markdown, metadata: { title } } }`. */
export function parseFirecrawlPage(value: unknown): ReadPage {
  const data = envelope(value) as { markdown?: unknown; metadata?: { title?: unknown } } | null;
  if (!data || typeof data !== "object") throw new SearchError("failed", "Firecrawl sent an answer Zirma cannot read");
  return { title: text(data.metadata?.title), text: typeof data.markdown === "string" ? data.markdown.trim() : "" };
}

async function post(path: "search" | "scrape", body: object, secret: string, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SearchError("failed", "Firecrawl could not be reached");
  }
  if (response.status === 401 || response.status === 403) throw new SearchError("refused", "Firecrawl refused the key");
  if (response.status === 402 || response.status === 429) throw new SearchError("limit", "Firecrawl's limit is reached for now");
  if (!response.ok) throw new SearchError("failed", `Firecrawl answered ${response.status}`);
  try { return await response.json(); } catch { throw new SearchError("failed", "Firecrawl sent an answer Zirma cannot read"); }
}

export const firecrawl: SearchProvider = {
  id: "firecrawl",
  title: "Firecrawl",
  needs: "key",
  about: ABOUT,
  keyPage: KEY_PAGE,
  async search(input, secret, signal) {
    if (!secret) throw new SearchError("refused", "Firecrawl has no key yet");
    const answer = await post("search", {
      query: input.query, limit: input.count, sources: ["web"],
      ...(input.site ? { includeDomains: [input.site] } : {}),
      ...(input.freshness ? { tbs: RECENCY[input.freshness] } : {}),
    }, secret, signal, SEARCH_TIMEOUT_MS);
    return parseFirecrawlSearch(answer).slice(0, input.count);
  },
};

/** The same service reading a page; it uses the key given for Firecrawl's search. */
export const firecrawlReader: ReaderProvider = {
  id: "firecrawl-read",
  keyOf: "firecrawl",
  title: "Firecrawl",
  needs: "key",
  about: ABOUT,
  keyPage: KEY_PAGE,
  async read(url, secret, signal) {
    if (!secret) throw new SearchError("refused", "Firecrawl has no key yet");
    return parseFirecrawlPage(await post("scrape", { url, formats: ["markdown"], onlyMainContent: true }, secret, signal, SCRAPE_TIMEOUT_MS));
  },
};
