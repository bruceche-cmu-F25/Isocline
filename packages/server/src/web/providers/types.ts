/** A search service behind `web_search` (docs/design/web.md §4.3). Adding one is a file beside this and a row in
 * `index.ts`; the tool, the model and the gate see no difference. */

export interface SearchInput {
  query: string;
  /** How many results, already bounded by the tool. */
  count: number;
  freshness?: "day" | "week" | "month" | "year";
  /** Only this site, as a host name. */
  site?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published?: string;
}

export interface SearchProvider {
  id: string;
  /** Its name, as the model and English Settings see it. */
  title: string;
  /** Its name on the Chinese page, when it has its own there. */
  zhTitle?: string;
  /** "model": it searches with the API key of a model provider the user added under Models (`modelProvider`). */
  needs: "nothing" | "key" | "address" | "model";
  /** For one that needs a model's key: Pi's id of that provider ("anthropic", "openai", "google", "deepseek"). */
  modelProvider?: string;
  about: { zh: string; en: string };
  /** Where the user gets a key (or, for one that needs an address, how to set one up). */
  keyPage?: string;
  /** `secret` is what the service needs: its key, the address of one the user runs, or the model provider's API key. */
  search(input: SearchInput, secret: string | null, signal: AbortSignal): Promise<SearchResult[]>;
}

/** A page as a reading service gives it back: Markdown. */
export interface ReadPage {
  title: string | null;
  text: string;
}

/** A service that reads a page Zirma could not read itself (one that needs scripts, or turns robots away), behind
 * `web_fetch` (docs/design/web.md §4.4). The page's address goes to the service. */
export interface ReaderProvider {
  id: string;
  title: string;
  /** "nothing": works without a key; a key, when the user adds one, is sent along. */
  needs: "nothing" | "key";
  /** A service that both searches and reads keeps one key, under its search side's id. */
  keyOf?: string;
  about: { zh: string; en: string };
  keyPage?: string;
  read(url: string, secret: string | null, signal: AbortSignal): Promise<ReadPage>;
}

/** A service refused for a reason the user can act on (a limit reached, a key refused), said in a sentence. */
export class SearchError extends Error {
  override name = "SearchError";
  readonly code: "limit" | "refused" | "failed";
  constructor(code: SearchError["code"], message: string) { super(message); this.code = code; }
}
