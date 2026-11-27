/** Reaching a page on the public web, carefully: shared by Links (a saved page's title) and the web tools (a page's
 * text, docs/design/web.md §4.4).
 *
 * The address comes from a person, a model or a web page, so:
 * - http and https only, and never to this machine or a private network. The check is made on the very address
 *   the connection is opened to (the request's own DNS lookup), and again on every redirect, so a name that
 *   resolves to something private a moment later is refused too.
 * - a limit on time and on bytes; nothing of the user is sent (no cookies).
 */
import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList } from "node:net";
import { Transform } from "node:stream";
import { createBrotliDecompress, createUnzip } from "node:zlib";

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

export type Lookup = (hostname: string, options: object, callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => void;
/** DNS for the connection itself: every address the name resolves to must be public, or none is used. */
export const publicLookup: Lookup = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
      return callback(new PageFetchError("private", `Refusing a private address for ${hostname}`), []);
    }
    callback(null, addresses);
  });
};

/** One GET, answered by its response; redirects are the caller's to follow (and check). */
export function getPublic(url: URL, options: { signal?: AbortSignal; lookup: Lookup; agent: string; accept: string; language: string; timeoutMs: number }): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", lookup: options.lookup as never, signal: options.signal, timeout: options.timeoutMs,
      headers: { "User-Agent": options.agent, Accept: options.accept, "Accept-Language": options.language, "Accept-Encoding": "identity" },
    }, resolve);
    request.on("timeout", () => request.destroy(new PageFetchError("timeout", "The page took too long")));
    request.on("error", (error) => reject(error instanceof PageFetchError ? error : new PageFetchError((error as NodeJS.ErrnoException).name === "AbortError" ? "timeout" : "network", error.message)));
    request.end();
  });
}

/** A response's body, at most `maxBytes` of it: a longer one is cut there and the connection closed. */
export async function readBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  // Some public pages return a compressed body even when the request explicitly asks for identity.
  // Limit both the transfer and the expanded body.
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
        done(received > maxBytes + 64 * 1024 ? new PageFetchError("status", "The encoded page is too large") : null, chunk);
      },
    });
    stream = response.compose(wireLimit).compose(decoder);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const part = (chunk as Buffer).subarray(0, maxBytes - size);
      chunks.push(part);
      size += part.length;
      if (size === maxBytes) break;
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof PageFetchError) throw error;
    throw new PageFetchError("network", "The page could not be read");
  } finally { response.destroy(); }
}

/** The page's text in the encoding it says it is in (its header, else its own meta tag), else UTF-8. */
export function decodeText(bytes: Buffer, contentType: string): string {
  const named = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString("latin1"))?.[1];
  try { return new TextDecoder(named ?? "utf-8").decode(bytes); } catch { return bytes.toString("utf8"); }
}
