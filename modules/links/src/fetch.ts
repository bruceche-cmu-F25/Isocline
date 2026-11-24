/** Looking a saved page up on the public web: its title, what it calls itself, who wrote it, and its own description.
 *
 * The address comes from a person, a model or a share sheet, so this is careful (docs/design/links.md 4.9):
 * - http and https only, and never to this machine or a private network. The check is made on the very address
 *   the connection is opened to (the request's own DNS lookup), and again on every redirect, so a name that
 *   resolves to something private a moment later is refused too.
 * - a limit on time, on redirects and on bytes; only HTML is read; nothing of the user is sent (no cookies).
 * A failure is never fatal: the caller keeps the name made from the address.
 */
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Transform } from "node:stream";
import { createBrotliDecompress, createUnzip } from "node:zlib";
import sharp from "sharp";

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96]] as const) blocked.addSubnet(network, prefix, "ipv6");

/** An address on the public internet: not this machine, a private or link-local network, or a reserved range. */
export function isPublicAddress(address: string, family: number): boolean {
  if (family !== 4 && family !== 6) return false;
  // An IPv4 address written as IPv6 is judged as the IPv4 address it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return !blocked.check(mapped[1], "ipv4");
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

export class PageFetchError extends Error {
  override name = "PageFetchError";
  /** `login`: the site sent a sign-in page instead of the page. */
  readonly code: "private" | "unsupported" | "status" | "not_html" | "timeout" | "network" | "redirects" | "login";
  constructor(code: PageFetchError["code"], message: string) { super(message); this.code = code; }
}

export interface PageInfo {
  /** Where the address ended up after redirects. */
  url: string;
  title?: string;
  site?: string;
  author?: string;
  description?: string;
  /** The thumbnail the page publishes for sharing; fetched separately for saved videos. */
  cover?: string;
  durationSeconds?: number;
  /** The page says it is a video (`og:type` video…, or it names an `og:video`). */
  video?: true;
  /** The icons the page names for itself, as addresses, the best for a tile first. */
  icons?: string[];
}
/** `language`: the Accept-Language to ask with, the user's (core acceptLanguage), so a site answers in it. */
export type PageFetcher = (url: string, signal?: AbortSignal, language?: string) => Promise<PageInfo>;

/** A site's own icon, as it was served. */
export interface SiteIcon { type: string; bytes: Uint8Array }
/** Finds a site's icon: the ones a page of it named (`candidates`), else its /favicon.ico. Null when it has none. */
export type IconFetcher = (pageUrl: string, candidates: readonly string[], signal?: AbortSignal) => Promise<SiteIcon | null>;

const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 5;
/** Says what it is. A site that refuses it is simply not read; the link keeps the name made from its address. */
const USER_AGENT = "Mozilla/5.0 (compatible; Zirma link reader)";
/** Xiaohongshu sends every reader that is not a phone to its sign-in. Its phone page carries the note's title,
 * text and cover in the head, so it is asked for as a phone, still saying it is Zirma. */
const PHONE_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X; compatible; Zirma link reader)";
const XIAOHONGSHU = /(^|\.)(xiaohongshu|rednote)\.com$|^xhslink\.com$/;
const agentFor = (url: URL) => (XIAOHONGSHU.test(url.hostname) ? PHONE_AGENT : USER_AGENT);

type Lookup = (hostname: string, options: object, callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => void;
/** DNS for the connection itself: every address the name resolves to must be public, or none is used. */
const publicLookup: Lookup = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
      return callback(new PageFetchError("private", `Refusing a private address for ${hostname}`), []);
    }
    callback(null, addresses);
  });
};

/** Asked for as a browser in English would be, unless the caller says the user's language. */
const ENGLISH = "en-US,en;q=0.9";

function get(url: URL, signal: AbortSignal | undefined, lookup: Lookup, language: string = ENGLISH): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", lookup: lookup as never, signal, timeout: TIMEOUT_MS,
      headers: { "User-Agent": agentFor(url), Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "Accept-Language": language, "Accept-Encoding": "identity" },
    }, resolve);
    request.on("timeout", () => request.destroy(new PageFetchError("timeout", "The page took too long")));
    request.on("error", (error) => reject(error instanceof PageFetchError ? error : new PageFetchError((error as NodeJS.ErrnoException).name === "AbortError" ? "timeout" : "network", error.message)));
    request.end();
  });
}

async function body(response: IncomingMessage): Promise<Buffer> {
  // Some public pages return a compressed body even when the request explicitly asks for identity.
  // Limit both the transfer and the expanded HTML, and stop reading once the head has been collected.
  const encoding = String(response.headers["content-encoding"] ?? "identity").toLowerCase().trim();
  const decoder = /^(gzip|x-gzip|deflate)$/.test(encoding) ? createUnzip() : encoding === "br" ? createBrotliDecompress() : undefined;
  if (!decoder && encoding && encoding !== "identity") {
    response.destroy();
    throw new PageFetchError("not_html", "Unsupported page encoding");
  }
  let stream: NodeJS.ReadableStream = response;
  if (decoder) {
    let received = 0;
    const wireLimit = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        done(received > MAX_BYTES + 64 * 1024 ? new PageFetchError("status", "The encoded page is too large") : null, chunk);
      },
    });
    stream = response.compose(wireLimit).compose(decoder);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const part = (chunk as Buffer).subarray(0, MAX_BYTES - size);
      chunks.push(part);
      size += part.length;
      if (size === MAX_BYTES) break;
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof PageFetchError) throw error;
    throw new PageFetchError("network", "The page could not be read");
  } finally { response.destroy(); }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Titles that describe the wall in front of a page (a login, a bot check, an error) rather than the page.
 * Saving one as a link's name is worse than saving none. After Robin's fetch-title. */
const WALL = [
  /\bstale request\b/i, /\bjust a moment\b/i, /\battention required\b/i, /\bchecking your browser\b/i, /\bare you (a )?human\b/i, /\baccess denied\b/i,
  /\b(40[0-9]|50[0-9])\b/, /\bpage not found\b/i, /^\s*(web\s+)?log[- ]?in\b/i, /^\s*sign[- ]?(in|on)\b/i, /^\s*redirecting\b/i, /^\s*loading\b/i,
  /^\s*(home|index|untitled|document|page|error)\s*$/i, /验证码|安全验证|访问受限|页面不见了|页面不存在|出错了|请先?登录|^\s*登录\s*([-–|·]|$)|^出错啦[!！\s]*(?:[-–|·]|$)/,
  // Xiaohongshu's front page, which a note address without its share token lands on.
  /^\s*rednote\s*\(小红书\)\s*[-–|]/i, /^\s*小红书\s*[-–|]\s*你的生活(?:指南|兴趣社区)\s*$/,
];
export const looksLikeWall = (title: string) => WALL.some((pattern) => pattern.test(title));

const tidy = (value: string | undefined, max: number) => {
  const text = value ? decodeEntities(value).replace(/\s+/g, " ").trim() : "";
  return text ? text.slice(0, max) : undefined;
};

/** Open Graph reports seconds. Schema.org duration uses an ISO time such as PT1H04M37S. */
function videoSeconds(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const iso = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(raw);
  const seconds = iso ? Number(iso[1] ?? 0) * 3600 + Number(iso[2] ?? 0) * 60 + Number(iso[3] ?? 0)
    : /^\d+$/.test(raw) ? Number(raw) : 0;
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 604800 ? seconds : undefined;
}

/** What a page says about itself in its head. Regular expressions, not a parser: the head is small and this only
 * reads a few well-known tags; anything odd is simply not found. */
export function readHead(html: string): Omit<PageInfo, "url"> {
  const head = html.slice(0, 200_000);
  const metas = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = /\b(?:property|name|itemprop)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (name && content && !metas.has(name)) metas.set(name, content[1] ?? content[2] ?? content[3] ?? "");
  }
  const title = tidy(metas.get("og:title") ?? metas.get("twitter:title"), 300) ?? tidy(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1], 300);
  // The page's icons: the touch icon first (it is drawn for a tile), then the others as written.
  const touch: string[] = [], plain: string[] = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const kind = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? "").toLowerCase();
    const address = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim();
    if (!address || address.startsWith("data:") || !/(^|\s)(icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(kind) || /mask-icon/.test(kind)) continue;
    (kind.includes("apple-touch-icon") ? touch : plain).push(address);
  }
  const icons = [...touch, ...plain].slice(0, 4);
  const durationSeconds = videoSeconds(metas.get("video:duration") ?? metas.get("og:video:duration") ?? metas.get("duration"));
  const cover = tidy(metas.get("og:image:secure_url"), 2048) ?? tidy(metas.get("og:image") ?? metas.get("twitter:image") ?? metas.get("thumbnailurl"), 2048);
  const video = /^video\b/i.test(metas.get("og:type") ?? "") || metas.has("og:video") || metas.has("og:video:url") || metas.has("og:video:secure_url");
  return {
    ...(icons.length ? { icons } : {}),
    ...(cover ? { cover } : {}),
    ...(video ? { video: true as const } : {}),
    ...(durationSeconds ? { durationSeconds } : {}),
    ...(title && !looksLikeWall(title) ? { title } : {}),
    ...(tidy(metas.get("og:site_name") ?? metas.get("application-name"), 80) ? { site: tidy(metas.get("og:site_name") ?? metas.get("application-name"), 80) } : {}),
    ...(tidy(metas.get("author") ?? metas.get("article:author") ?? metas.get("og:video:director"), 120) ? { author: tidy(metas.get("author") ?? metas.get("article:author") ?? metas.get("og:video:director"), 120) } : {}),
    ...(tidy(metas.get("og:description") ?? metas.get("description") ?? metas.get("twitter:description"), 600) ? { description: tidy(metas.get("og:description") ?? metas.get("description") ?? metas.get("twitter:description"), 600) } : {}),
  };
}

/** The page's text in the encoding it says it is in (its header, else its own meta tag), else UTF-8. */
function decode(bytes: Buffer, contentType: string): string {
  const named = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString("latin1"))?.[1];
  try { return new TextDecoder(named ?? "utf-8").decode(bytes); } catch { return bytes.toString("utf8"); }
}

/** A path that is a site's sign-in, not a page of its own. */
const SIGN_IN = /(^|\/)(login|signin|sign-in|sign_in|passport|sso|auth)(\/|$)/i;

/** YouTube says what a video is called and whose it is through oEmbed, which is made for exactly this; its watch
 * page buries the same under megabytes of script. Nothing found (a private or removed video) falls back to the page. */
async function youtube(target: URL, signal: AbortSignal | undefined, lookup: Lookup): Promise<Omit<PageInfo, "url"> | null> {
  if (!/(^|\.)youtube\.com$/.test(target.hostname) || target.pathname !== "/watch") return null;
  try {
    const response = await get(new URL(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(target.href)}`), signal, lookup);
    if (response.statusCode !== 200) { response.destroy(); return null; }
    const said = JSON.parse((await body(response)).toString("utf8")) as { title?: unknown; author_name?: unknown; thumbnail_url?: unknown };
    const title = typeof said.title === "string" ? tidy(said.title, 300) : undefined;
    const author = typeof said.author_name === "string" ? tidy(said.author_name, 120) : undefined;
    const cover = typeof said.thumbnail_url === "string" ? tidy(said.thumbnail_url, 2048) : undefined;
    return title ? { title, site: "YouTube", ...(author ? { author } : {}), ...(cover ? { cover } : {}) } : null;
  } catch { return null; }
}

/** Looks one page up. `lookup` is the DNS the connection uses; tests pass their own to reach a local server. */
export async function fetchPage(input: string, signal?: AbortSignal, lookup: Lookup = publicLookup, language: string = ENGLISH): Promise<PageInfo> {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let target = new URL(input);
  for (let hop = 0; ; hop++) {
    // A redirect from a page to a sign-in is the site's wall, not where the page went.
    if (hop > 0 && SIGN_IN.test(target.pathname) && !SIGN_IN.test(new URL(input).pathname)) throw new PageFetchError("login", "The page is behind a sign-in");
    const known = lookup === publicLookup ? await youtube(target, signal, lookup) : null;
    if (known) return { url: target.href, ...known };
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new PageFetchError("unsupported", "Only http and https pages are read");
    // An address written as a number is checked here; a name is checked when it is resolved.
    const literal = target.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && lookup === publicLookup && !isPublicAddress(literal, isIP(literal))) throw new PageFetchError("private", "Refusing a private address");
    const response = await get(target, signal, lookup, language);
    const status = response.statusCode ?? 0;
    const location = status >= 300 && status < 400 ? response.headers.location : undefined;
    if (location) {
      response.destroy();
      if (hop >= MAX_REDIRECTS) throw new PageFetchError("redirects", "Too many redirects");
      target = new URL(location, target);
      continue;
    }
    if (status === 401) { response.destroy(); throw new PageFetchError("login", `The site answered ${status}`); }
    if (status < 200 || status >= 300) { response.destroy(); throw new PageFetchError("status", `The site answered ${status}`); }
    const type = String(response.headers["content-type"] ?? "");
    if (type && !/html|xml/i.test(type)) { response.destroy(); throw new PageFetchError("not_html", "Not a web page"); }
    const said = readHead(decode(await body(response), type));
    if (said.title && /(^|\.)bilibili\.com$/.test(target.hostname) && /^\/video\//.test(target.pathname)) {
      said.title = said.title.replace(/_哔哩哔哩_bilibili$/i, "").trim() || undefined;
    }
    if (XIAOHONGSHU.test(target.hostname)) {
      if (said.title) said.title = said.title.replace(/\s*[-–|]\s*(?:rednote|小红书)$/i, "").trim() || undefined;
      // "rednote" or "小红书" only repeats the platform the card already names.
      delete said.site;
    }
    // Icon addresses are written relative to the page.
    const icons = (said.icons ?? []).flatMap((href) => { try { return [new URL(href, target).href]; } catch { return []; } });
    if (said.cover) {
      try { said.cover = new URL(said.cover, target).href; } catch { delete said.cover; }
    }
    return { url: target.href, ...said, ...(icons.length ? { icons } : {}) };
  }
}

const MAX_ICON_BYTES = 300 * 1024;

/** What kind of image these bytes are, from the bytes themselves (never from what the site calls them): PNG, JPEG,
 * GIF, WebP, ICO or SVG. Anything else is not kept. */
export function imageType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  const start = Buffer.from(b.subarray(0, 1024)).toString("utf8").trimStart().toLowerCase();
  return (start.startsWith("<svg") || start.startsWith("<?xml")) && start.includes("<svg") ? "image/svg+xml" : null;
}

/** Downloads one image with the same care as a page: public addresses only, every redirect checked, a size limit. */
async function image(address: string, signal: AbortSignal | undefined, lookup: Lookup, maxBytes = MAX_ICON_BYTES): Promise<SiteIcon | null> {
  let target = new URL(address);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password) return null;
    const literal = target.hostname.replace(/^\[|\]$/g, "");
    if (isIP(literal) && lookup === publicLookup && !isPublicAddress(literal, isIP(literal))) return null;
    const response = await get(target, signal, lookup);
    const status = response.statusCode ?? 0;
    const location = status >= 300 && status < 400 ? response.headers.location : undefined;
    if (location) { response.destroy(); target = new URL(location, target); continue; }
    if (status !== 200 || Number(response.headers["content-length"] ?? 0) > maxBytes) { response.destroy(); return null; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) { response.destroy(); return null; }
      chunks.push(chunk as Buffer);
    }
    const bytes = Buffer.concat(chunks);
    const type = imageType(bytes);
    return type ? { type, bytes } : null;
  }
  return null;
}

/** A site's own icon: the first of the page's candidates that is an image, else the site's /favicon.ico. */
export async function fetchIcon(pageUrl: string, candidates: readonly string[], signal?: AbortSignal, lookup: Lookup = publicLookup): Promise<SiteIcon | null> {
  const fallback = new URL("/favicon.ico", pageUrl).href;
  for (const address of [...new Set([...candidates.slice(0, 3), fallback])]) {
    try {
      const found = await image(address, signal, lookup);
      if (found) return found;
    } catch { /* the next one */ }
    if (signal?.aborted) return null;
  }
  return null;
}

/** A cover is drawn a few hundred pixels across at most, twice that on a sharp screen. */
const COVER_BOX = 640;
/** What a stored cover may weigh (the table's own limit). */
const MAX_COVER_BYTES = 512 * 1024;
const RASTER = ["image/jpeg", "image/png", "image/webp"];

/** A cover at the size it is drawn: fitted inside 640×640 as WebP, which is tens of kilobytes where the site's
 * original is often hundreds. Kept as it came when that is already smaller. Null when it is not a picture that can
 * be read (or would be too large to decode: a bound on pixels, against images made to explode). */
export async function shrinkCover(cover: SiteIcon): Promise<SiteIcon | null> {
  if (!RASTER.includes(cover.type)) return null;
  try {
    const small = await sharp(cover.bytes, { limitInputPixels: 40_000_000, failOn: "error" })
      .rotate().resize(COVER_BOX, COVER_BOX, { fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
    const best = small.length < cover.bytes.length ? { type: "image/webp", bytes: new Uint8Array(small) } : cover;
    return best.bytes.length <= MAX_COVER_BYTES ? best : null;
  } catch { return null; }
}

/** A thumbnail can be published by a different host. Only raster images become a saved cover, shrunk to the size
 * they are drawn at. */
export async function fetchCover(address: string, signal?: AbortSignal, lookup: Lookup = publicLookup): Promise<SiteIcon | null> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const cover = await image(address, signal ? AbortSignal.any([signal, timeout]) : timeout, lookup, 4 * 1024 * 1024).catch(() => null);
  return cover ? shrinkCover(cover) : null;
}
