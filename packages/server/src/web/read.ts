/** Reading one web page as text, for `web_fetch` (docs/design/web.md §4.4).
 *
 * The connection is the careful one Links uses (`@zirma/core/net`): public addresses only, checked again on every
 * redirect, limits on time and size, no cookies, and it says it is Zirma. A web page is turned into Markdown the way
 * pi-web-access does it (linkedom parses, Readability finds the article, Turndown writes Markdown). Plain text,
 * Markdown and JSON are read as they are. A PDF's text is taken out page by page with unpdf, after pi-web-access's
 * `pdf-extract.ts` (0.48.0, https://github.com/nicobailon/pi-web-access, MIT, © 2025 Nico Bailon). Anything else is
 * refused with a reason the model can pass on.
 */
import { isIP } from "node:net";
import { decodeText, getPublic, isPublicAddress, type Lookup, PageFetchError, publicLookup, readBody } from "@zirma/core/net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

export interface ReadPage {
  /** Where the address ended up after redirects. */
  url: string;
  title?: string;
  author?: string;
  published?: string;
  /** The page's text: Markdown for a web page, as served for text. Empty when the page has none to read. */
  text: string;
}

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 3 * 1024 * 1024;
/** A PDF is larger for the same text. */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
/** Pages read from a PDF; the rest is named, not read. */
const MAX_PDF_PAGES = 100;
const MAX_REDIRECTS = 5;
const AGENT = "Mozilla/5.0 (compatible; Zirma web reader)";
const ACCEPT = "text/html,application/xhtml+xml,text/markdown;q=0.9,text/plain;q=0.8,application/json;q=0.7,application/pdf;q=0.6,*/*;q=0.3";
/** A path that is a site's sign-in, not a page of its own. */
const SIGN_IN = /(^|\/)(login|signin|sign-in|sign_in|passport|sso|auth)(\/|$)/i;
/** Less than this is a page's furniture, not its text: most likely a page that needs scripts to show anything. */
export const MIN_TEXT = 200;

let turndown: TurndownService | null = null;
const markdown = (html: string) => {
  turndown ??= new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  return turndown.turndown(html);
};

/** A web page's article as Markdown, and what the page says of itself. */
export function htmlToText(html: string, url: string): Omit<ReadPage, "url"> {
  const { document } = parseHTML(html);
  const pageTitle = document.title?.trim() || undefined;
  const meta = (name: string) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.getAttribute("content")?.trim() || undefined;
  for (const element of document.querySelectorAll("script, style, noscript, template, iframe")) element.remove();
  // Docs sites wrap names in code in hover buttons; Readability drops buttons, and the code would lose its words.
  for (const button of document.querySelectorAll("pre button, code button")) button.replaceWith(document.createTextNode(button.textContent ?? ""));
  let article: { title?: string | null; content?: string | null; byline?: string | null; publishedTime?: string | null } | null = null;
  try {
    // Readability resolves relative links against the page's own address.
    Object.defineProperty(document, "baseURI", { value: url, configurable: true });
    article = new Readability(document as unknown as Document, { charThreshold: MIN_TEXT }).parse();
  } catch { article = null; }
  const body = article?.content ?? document.body?.innerHTML ?? "";
  const text = markdown(body).replace(/\n{3,}/g, "\n\n").trim();
  const title = article?.title?.trim() || meta("og:title") || pageTitle;
  const author = article?.byline?.trim() || meta("author") || meta("article:author");
  const published = article?.publishedTime?.trim() || meta("article:published_time");
  return { text, ...(title ? { title } : {}), ...(author ? { author } : {}), ...(published ? { published } : {}) };
}

/** A file on GitHub shows its text only through scripts; the same file is served raw beside it. */
export function rawGitHub(address: string): string | null {
  const url = new URL(address);
  if (url.hostname !== "github.com") return null;
  const match = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  return match ? `https://raw.githubusercontent.com/${match[1]}/${match[2]}/${match[3]}` : null;
}

/** Reads one page. `lookup` is the DNS the connection uses; tests pass their own to reach a local server. */
export async function readPage(input: string, options: { signal?: AbortSignal; lookup?: Lookup; language?: string } = {}): Promise<ReadPage> {
  const raw = rawGitHub(input);
  if (raw) return { ...(await readPage(raw, options)), url: input };
  const lookup = options.lookup ?? publicLookup;
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const first = new URL(input);
  let target = first;
  for (let hop = 0; ; hop++) {
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new PageFetchError("unsupported", "Only http and https pages are read");
    // A redirect from a page to a sign-in is the site's wall, not where the page went.
    if (hop > 0 && SIGN_IN.test(target.pathname) && !SIGN_IN.test(first.pathname)) throw new PageFetchError("login", "The page is behind a sign-in");
    // An address written as a number is checked here; a name is checked when it is resolved.
    const literal = target.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && lookup === publicLookup && !isPublicAddress(literal, isIP(literal))) throw new PageFetchError("private", "Refusing a private address");
    const response = await getPublic(target, { signal, lookup, agent: AGENT, accept: ACCEPT, language: options.language ?? "en-US,en;q=0.9", timeoutMs: TIMEOUT_MS });
    const status = response.statusCode ?? 0;
    const location = status >= 300 && status < 400 ? response.headers.location : undefined;
    if (location) {
      response.destroy();
      if (hop >= MAX_REDIRECTS) throw new PageFetchError("redirects", "Too many redirects");
      target = new URL(location, target);
      continue;
    }
    if (status === 401 || status === 403) { response.destroy(); throw new PageFetchError("login", `The site answered ${status}`); }
    if (status < 200 || status >= 300) { response.destroy(); throw new PageFetchError("status", `The site answered ${status}`); }
    const type = String(response.headers["content-type"] ?? "").toLowerCase();
    // Some servers send a PDF as a plain download; its address still says what it is.
    if (type.includes("application/pdf") || (/octet-stream/.test(type) && /\.pdf$/i.test(target.pathname))) {
      return { url: target.href, ...(await pdfToText(await readBody(response, MAX_PDF_BYTES), target)) };
    }
    const html = !type || /html|xml/.test(type);
    if (!html && !/^text\/|json/.test(type)) { response.destroy(); throw new PageFetchError("not_html", `Not a page Zirma reads (${type.split(";")[0]})`); }
    const raw = decodeText(await readBody(response, MAX_BYTES), type);
    if (!html) return { url: target.href, text: raw.trim() };
    return { url: target.href, ...htmlToText(raw, target.href) };
  }
}

/** A PDF's text, page by page, with its title from its own details or else its file name. */
export async function pdfToText(bytes: Buffer, url: URL): Promise<Omit<ReadPage, "url">> {
  const { getDocumentProxy } = await import("unpdf");
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes));
  } catch {
    throw new PageFetchError("not_html", "The PDF could not be opened");
  }
  try {
    const info = ((await pdf.getMetadata().catch(() => null))?.info ?? {}) as Record<string, unknown>;
    const named = typeof info.Title === "string" ? info.Title.trim() : "";
    const file = decodeURIComponent(url.pathname.split("/").pop() ?? "").replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
    const author = typeof info.Author === "string" && info.Author.trim() ? info.Author.trim() : undefined;
    const reading = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const pages: string[] = [];
    for (let number = 1; number <= reading; number++) {
      const page = await pdf.getPage(number);
      const items = (await page.getTextContent()).items as Array<{ str?: string }>;
      const line = items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ").trim();
      if (line) pages.push(`<!-- Page ${number} -->\n${line}`);
    }
    const rest = pdf.numPages > reading ? `\n\n[Only the first ${reading} of ${pdf.numPages} pages were read]` : "";
    return { ...(named || file ? { title: named || file } : {}), ...(author ? { author } : {}), text: pages.join("\n\n") + rest };
  } finally {
    await pdf.cleanup().catch(() => undefined);
  }
}
