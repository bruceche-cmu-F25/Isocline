/** Jina Reader: reads a page on Jina's side, scripts and all, and hands back Markdown. No key needed (a few reads a
 * minute); a key gives more (docs/design/web.md §4.3, §4.4). `web_fetch` uses it only when Zirma could not read a
 * page itself, and never for an address that carries data.
 *
 * The request follows pi-web-access 0.48.0, `extract.ts` (`extractWithJinaReader`: no cache, the too-little-text
 * checks): https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon. Zirma asks for JSON instead of
 * cutting the Markdown out of a text answer.
 */
import { SearchError, type ReaderProvider, type ReadPage } from "./types.ts";

const BASE = "https://r.jina.ai/";
const TIMEOUT_MS = 40_000;
const MAX_TEXT = 200_000;

/** Jina's answer: `{ code, data: { title, url, content } }`. A page that still shows only a loading line or asks for
 * scripts counts as not read. */
export function parseJina(value: unknown): ReadPage {
  const data = (value as { data?: { title?: unknown; content?: unknown } } | null)?.data;
  if (!data || typeof data.content !== "string") throw new SearchError("failed", "Jina sent an answer Zirma cannot read");
  const text = data.content.trim().slice(0, MAX_TEXT);
  if (/^(Loading\.\.\.|Please enable JavaScript)/i.test(text)) return { title: null, text: "" };
  return { title: typeof data.title === "string" && data.title.trim() ? data.title.trim() : null, text };
}

export const jina: ReaderProvider = {
  id: "jina",
  title: "Jina Reader",
  needs: "nothing",
  about: { zh: "能读要跑脚本的页面，不用 key", en: "Reads pages that need scripts, no key needed" },
  keyPage: "https://jina.ai/api-dashboard/",
  async read(url, secret, signal): Promise<ReadPage> {
    let response: Response;
    try {
      response = await fetch(BASE + url, {
        headers: {
          Accept: "application/json", "X-No-Cache": "true", "X-Retain-Images": "none",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SearchError("failed", "Jina could not be reached");
    }
    if (response.status === 401 || response.status === 403) throw new SearchError("refused", "Jina refused the key");
    if (response.status === 429 || response.status === 402) throw new SearchError("limit", "Jina's limit is reached for now");
    if (!response.ok) throw new SearchError("failed", `Jina answered ${response.status}`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new SearchError("failed", "Jina sent an answer Zirma cannot read"); }
    return parseJina(body);
  },
};
