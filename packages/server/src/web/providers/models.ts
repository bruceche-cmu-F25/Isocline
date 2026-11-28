/** Searching with the API key of a model the user already added under Models (docs/design/web.md §4.6, §8 #7):
 * Claude's web search tool, OpenAI's web search tool, Gemini's Google Search grounding, and DeepSeek's search API.
 * Only a plain API key is used, never a subscription sign-in: the providers' terms do not allow that (§4.6).
 *
 * The OpenAI, Gemini and DeepSeek requests and the reading of their answers are adapted from pi-web-access 0.48.0
 * (`openai-search.ts`, `gemini-search.ts`, `deepseek.ts`): https://github.com/nicobailon/pi-web-access, MIT,
 * © 2025 Nico Bailon. Claude's goes through Anthropic's SDK.
 */
import Anthropic from "@anthropic-ai/sdk";
import { SearchError, type SearchInput, type SearchProvider, type SearchResult } from "./types.ts";

const TIMEOUT_MS = 60_000;
const MAX_SNIPPET = 600;
const FRESHNESS_WORDS: Record<NonNullable<SearchInput["freshness"]>, string> = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };

const tidy = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const isWeb = (url: unknown): url is string => typeof url === "string" && /^https?:\/\//.test(url);

/** What the model is asked when the search runs inside a model: search once, for this, with these limits. */
function ask(input: SearchInput): string {
  return [
    `Search the web for: ${input.query}`,
    "Search once and say briefly what the results are about. Do not search again.",
    input.freshness ? `Prefer results from the ${FRESHNESS_WORDS[input.freshness]}.` : "",
    input.site ? `Only results from ${input.site}.` : "",
  ].filter(Boolean).join("\n");
}

/** Results in the order first seen, each address once; a later excerpt fills an empty one. */
function collect(): { add(url: unknown, title: unknown, snippet?: unknown, published?: unknown): void; list(): SearchResult[] } {
  const byUrl = new Map<string, SearchResult>();
  return {
    add(url, title, snippet, published) {
      if (!isWeb(url)) return;
      const seen = byUrl.get(url);
      const text = tidy(snippet).slice(0, MAX_SNIPPET);
      if (seen) { if (!seen.snippet && text) seen.snippet = text; return; }
      const date = tidy(published);
      byUrl.set(url, { title: tidy(title) || url, url, snippet: text, ...(date ? { published: date } : {}) });
    },
    list: () => [...byUrl.values()],
  };
}

/** A status from a provider, as the reason it failed. */
function failure(name: string, status: number, said = ""): SearchError {
  if (status === 401 || status === 403 || /api.?key.*(invalid|not valid)|API_KEY_INVALID/i.test(said)) return new SearchError("refused", `${name} refused the key`);
  if (status === 429 || status === 402 || /quota|insufficient|balance|credit/i.test(said)) return new SearchError("limit", `${name}'s limit is reached for now`);
  return new SearchError("failed", `${name} answered ${status}`);
}

async function post(name: string, url: string, headers: Record<string, string>, body: object, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SearchError("failed", `${name} could not be reached`);
  }
  if (!response.ok) throw failure(name, response.status, await response.text().catch(() => ""));
  try { return await response.json(); } catch { throw new SearchError("failed", `${name} sent an answer Zirma cannot read`); }
}

// ── Claude ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The smallest current Claude: it only has to run one search and hand back what it found, and each search is a
 * request of its own on the user's bill. The basic search tool is called directly, without code running first. */
const CLAUDE_MODEL = "claude-haiku-5-5";

/** Claude's answer: `web_search_tool_result` blocks hold the results; the text's citations hold excerpts. */
export function parseClaude(content: readonly unknown[]): SearchResult[] {
  const found = collect();
  let error: string | null = null;
  for (const block of content) {
    const entry = (block ?? {}) as { type?: unknown; content?: unknown; citations?: unknown };
    if (entry.type === "web_search_tool_result") {
      // Success is a list of results; an error is one object.
      if (Array.isArray(entry.content)) for (const item of entry.content as Array<Record<string, unknown>>) found.add(item.url, item.title, "", item.page_age);
      else error = tidy((entry.content as { error_code?: unknown } | null)?.error_code) || "unavailable";
    }
    if (entry.type === "text" && Array.isArray(entry.citations)) {
      for (const cite of entry.citations as Array<Record<string, unknown>>) if (cite.type === "web_search_result_location") found.add(cite.url, cite.title, cite.cited_text);
    }
  }
  const results = found.list();
  if (!results.length && error) throw new SearchError(error === "too_many_requests" ? "limit" : "failed", `Claude's web search: ${error}`);
  return results;
}

export const claudeSearch: SearchProvider = {
  id: "anthropic",
  title: "Claude",
  needs: "model",
  modelProvider: "anthropic",
  about: { zh: "Claude 自带的搜索，按次收费", en: "Claude's own search, paid per search" },
  keyPage: "https://console.anthropic.com/settings/keys",
  async search(input, secret, signal) {
    if (!secret) throw new SearchError("refused", "There is no Anthropic API key under Models");
    const client = new Anthropic({ apiKey: secret, maxRetries: 0, timeout: TIMEOUT_MS });
    try {
      const response = await client.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        output_config: { effort: "low" },
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1, ...(input.site ? { allowed_domains: [input.site] } : {}) }],
        messages: [{ role: "user", content: ask(input) }],
      }, { signal });
      return parseClaude(response.content).slice(0, input.count);
    } catch (error) {
      if (error instanceof SearchError) throw error;
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new SearchError("refused", "Anthropic refused the key");
      if (error instanceof Anthropic.RateLimitError) throw new SearchError("limit", "Anthropic's limit is reached for now");
      if (error instanceof Anthropic.APIUserAbortError) throw error;
      if (error instanceof Anthropic.BadRequestError) throw new SearchError("failed", `Anthropic: ${error.message.slice(0, 200)}`);
      if (error instanceof Anthropic.APIError) throw new SearchError("failed", `Anthropic answered ${error.status ?? "nothing"}`);
      throw error;
    }
  },
};

// ── OpenAI ───────────────────────────────────────────────────────────────────────────────────────────────────────

const OPENAI_MODEL = "gpt-6-luna";

/** The Responses API's output: citations in the message's text, then the sources the web search call lists. */
export function parseOpenAI(value: unknown): SearchResult[] {
  const output = (value as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) throw new SearchError("failed", "OpenAI sent an answer Zirma cannot read");
  const found = collect();
  for (const item of output as Array<Record<string, unknown>>) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      const text = typeof part.text === "string" ? part.text : "";
      for (const note of Array.isArray(part.annotations) ? part.annotations as Array<Record<string, unknown>> : []) {
        if (note.type !== "url_citation") continue;
        const start = typeof note.start_index === "number" ? note.start_index : 0;
        found.add(note.url, note.title, text.slice(Math.max(0, start - 240), start));
      }
    }
  }
  for (const item of output as Array<Record<string, unknown>>) {
    if (item.type !== "web_search_call") continue;
    const sources = (item.action as { sources?: unknown } | undefined)?.sources;
    for (const source of Array.isArray(sources) ? sources as Array<Record<string, unknown>> : []) found.add(source.url, source.title);
  }
  return found.list();
}

export const openaiSearch: SearchProvider = {
  id: "openai",
  title: "OpenAI",
  needs: "model",
  modelProvider: "openai",
  about: { zh: "OpenAI 自带的搜索，按次收费", en: "OpenAI's own search, paid per search" },
  keyPage: "https://platform.openai.com/api-keys",
  async search(input, secret, signal) {
    if (!secret) throw new SearchError("refused", "There is no OpenAI API key under Models");
    const answer = await post("OpenAI", "https://api.openai.com/v1/responses", { Authorization: `Bearer ${secret}` }, {
      model: OPENAI_MODEL,
      input: ask(input),
      tools: [{ type: "web_search", ...(input.site ? { filters: { allowed_domains: [input.site] } } : {}) }],
      include: ["web_search_call.action.sources"],
      tool_choice: "required",
      store: false,
    }, signal);
    return parseOpenAI(answer).slice(0, input.count);
  },
};

// ── Gemini ───────────────────────────────────────────────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-3.6-flash";
const GOOGLE_REDIRECT = "vertexaisearch.cloud.google.com/grounding-api-redirect";

/** Gemini's grounding: the chunks are the sources (often Google's redirect addresses); a support's text is the
 * excerpt of the chunks it cites. */
export function parseGemini(value: unknown): SearchResult[] {
  const candidate = ((value as { candidates?: unknown } | null)?.candidates as Array<Record<string, unknown>> | undefined)?.[0];
  if (!candidate) throw new SearchError("failed", "Gemini sent an answer Zirma cannot read");
  const meta = (candidate.groundingMetadata ?? {}) as { groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }>; groundingSupports?: Array<{ segment?: { text?: unknown }; groundingChunkIndices?: number[] }> };
  const excerpt = new Map<number, string>();
  for (const support of meta.groundingSupports ?? []) for (const index of support.groundingChunkIndices ?? []) if (!excerpt.has(index)) excerpt.set(index, tidy(support.segment?.text));
  const found = collect();
  (meta.groundingChunks ?? []).forEach((chunk, index) => found.add(chunk.web?.uri, chunk.web?.title, excerpt.get(index)));
  return found.list();
}

/** Google's redirect address, followed one step to the page it stands for; itself when that fails. */
async function unwrap(url: string, signal: AbortSignal): Promise<string> {
  if (!url.includes(GOOGLE_REDIRECT)) return url;
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    const location = response.headers.get("location");
    return location && isWeb(location) ? location : url;
  } catch {
    return url;
  }
}

export const geminiSearch: SearchProvider = {
  id: "gemini",
  title: "Gemini",
  needs: "model",
  modelProvider: "google",
  about: { zh: "Gemini 用 Google 搜，按次收费", en: "Gemini searching Google, paid per search" },
  keyPage: "https://aistudio.google.com/apikey",
  async search(input, secret, signal) {
    if (!secret) throw new SearchError("refused", "There is no Google API key under Models");
    const answer = await post("Gemini", `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, { "x-goog-api-key": secret }, {
      contents: [{ role: "user", parts: [{ text: ask(input) }] }],
      tools: [{ google_search: {} }],
    }, signal);
    const results = parseGemini(answer).slice(0, input.count);
    return Promise.all(results.map(async (result) => ({ ...result, url: await unwrap(result.url, signal) })));
  },
};

// ── DeepSeek ─────────────────────────────────────────────────────────────────────────────────────────────────────

const DEEPSEEK_MAX_QUERY = 128;
const DAYS: Record<NonNullable<SearchInput["freshness"]>, number> = { day: 1, week: 7, month: 30, year: 365 };

/** DeepSeek takes a site and a date as operators in the query, and at most 128 characters in all. */
export function deepseekQuery(input: SearchInput, now = Date.now()): string {
  const extra = [
    input.site ? `site:${input.site}` : "",
    input.freshness ? `after:${new Date(now - DAYS[input.freshness] * 86_400_000).toISOString().slice(0, 10)}` : "",
  ].filter(Boolean).join(" ");
  const room = DEEPSEEK_MAX_QUERY - (extra ? [...extra].length + 1 : 0);
  return [[...input.query.trim()].slice(0, Math.max(1, room)).join(""), extra].filter(Boolean).join(" ");
}

/** DeepSeek's answer: `{ results: [{ title, url, summary, snippet }] }`. */
export function parseDeepSeek(value: unknown): SearchResult[] {
  const results = (value as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) throw new SearchError("failed", "DeepSeek sent an answer Zirma cannot read");
  const found = collect();
  for (const item of results as Array<Record<string, unknown>>) found.add(item.url, item.title, tidy(item.summary) || item.snippet);
  return found.list();
}

export const deepseekSearch: SearchProvider = {
  id: "deepseek",
  title: "DeepSeek",
  needs: "model",
  modelProvider: "deepseek",
  about: { zh: "DeepSeek 的搜索，中文好", en: "DeepSeek's search, good for Chinese" },
  keyPage: "https://platform.deepseek.com/api_keys",
  async search(input, secret, signal) {
    if (!secret) throw new SearchError("refused", "There is no DeepSeek API key under Models");
    const answer = await post("DeepSeek", "https://api.deepseek.com/v1/tools/search", { Authorization: `Bearer ${secret}` }, { query: deepseekQuery(input), count: input.count }, signal);
    return parseDeepSeek(answer).slice(0, input.count);
  },
};

export const MODEL_SEARCH: readonly SearchProvider[] = [claudeSearch, openaiSearch, geminiSearch, deepseekSearch];
