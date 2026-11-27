/** The search and reading services Zirma knows how to reach (docs/design/web.md §4.3), in the order Settings offers
 * them. The user picks and orders the ones to use (web/access.ts). */
import { bocha } from "./bocha.ts";
import { brave } from "./brave.ts";
import { exa } from "./exa.ts";
import { jina } from "./jina.ts";
import { searxng } from "./searxng.ts";
import { tavily } from "./tavily.ts";
import type { ReaderProvider, SearchProvider } from "./types.ts";

export const PROVIDERS: readonly SearchProvider[] = [exa, bocha, tavily, brave, searxng];
export const READERS: readonly ReaderProvider[] = [jina];

export type { ReaderProvider, ReadPage, SearchInput, SearchProvider, SearchResult } from "./types.ts";
export { SearchError } from "./types.ts";
