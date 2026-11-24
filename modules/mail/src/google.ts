/** Reading Gmail: the anti-corruption layer between Gmail's messages and the module's. Gmail's rules stay here: labels
 * say unread, important, starred and category; a body is a tree of MIME parts, of which only text is read (never an
 * attachment). Adapted from Robin's extension/robin/gmail.ts.
 */
import { ServiceError, type GoogleSession } from "@isocline/module-kit";
import type { MailCategory } from "./types.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** The inbox's last two weeks; at most this many messages per account. */
export const INBOX_QUERY = "in:inbox newer_than:14d";
export const INBOX_MAX = 500;
/** New messages read in full per pass; the rest come next time. */
const NEW_PER_PASS = 60;
/** Rotate through previously seen mail outside the ordinary inbox to verify retention and detect deletions. */
const OUTSIDE_PER_PASS = 30;
const CONCURRENCY = 5;
const BODY_MAX = 20_000;

interface Header { name?: string; value?: string }
interface Part { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; attachmentId?: string; size?: number }; parts?: Part[] }
export interface GmailMessage { id?: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part }

/** A message as the module stores it. */
export interface MessageRow {
  id: string;
  threadId: string;
  from: string;
  fromEmail: string;
  to: string;
  subject: string;
  snippet: string;
  body: string;
  attachments: string[];
  bodyIncomplete: boolean;
  receivedAt: number;
  unread: boolean;
  important: boolean;
  starred: boolean;
  category: MailCategory;
}

const header = (payload: Part | undefined, name: string) =>
  payload?.headers?.find((entry) => (entry.name ?? "").toLowerCase() === name)?.value?.trim() ?? "";

/** `"Ana Lima" <ana@example.com>` → name and address. */
export function parseAddress(value: string): { name: string; email: string } {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { name: match[1].trim() || match[2].trim(), email: match[2].trim().toLowerCase() };
  return { name: value.trim(), email: value.trim().toLowerCase() };
}

const decode = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** The few character references Gmail writes into text: in a body's HTML, and in every snippet. */
export const unescapeHtml = (text: string): string =>
  text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export function stripHtml(html: string): string {
  const text = html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<a\b[^>]*href\s*=\s*["'](https?:[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => `${label} (${href})`)
    .replace(/<[^>]+>/g, " ");
  return unescapeHtml(text)
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

/** The readable text of a message: text/plain when there is one, else HTML without markup. Attachments are named,
 * never decoded. */
export function extractBody(root: Part | undefined): { body: string; attachments: string[]; incomplete: boolean } {
  const attachments: string[] = [];
  let incomplete = !root;
  let visited = 0;
  const walk = (part: Part | undefined, depth: number): { text: string; plain: boolean } => {
    if (!part || ++visited > 2000 || depth > 30) { incomplete = true; return { text: "", plain: false }; }
    const mime = (part.mimeType ?? "").toLowerCase();
    const disposition = header(part, "content-disposition");
    if (part.filename || /^attachment\b/i.test(disposition) || (!mime.startsWith("text/") && !mime.startsWith("multipart/") && (part.body?.attachmentId || part.body?.data))) {
      attachments.push((part.filename?.trim() || "attachment").slice(0, 200));
      return { text: "", plain: false };
    }
    if (mime === "multipart/encrypted") incomplete = true;
    if (part.parts?.length) {
      const children = part.parts.map((child) => walk(child, depth + 1));
      if (mime === "multipart/alternative") return children.find((child) => child.plain && child.text) ?? children.find((child) => child.text) ?? { text: "", plain: false };
      return { text: children.map((child) => child.text).filter(Boolean).join("\n\n"), plain: children.some((child) => child.plain) };
    }
    if (mime === "text/plain" || mime === "text/html") {
      if (!part.body?.data && (part.body?.attachmentId || (part.body?.size ?? 0) > 0)) incomplete = true;
      const text = part.body?.data ? decode(part.body.data) : "";
      return { text: mime === "text/html" ? stripHtml(text) : text.trim(), plain: mime === "text/plain" };
    }
    return { text: "", plain: false };
  };
  return { body: walk(root, 0).text.trim().slice(0, BODY_MAX), attachments: attachments.slice(0, 20), incomplete };
}

const CATEGORIES: Array<[string, MailCategory]> = [["CATEGORY_PROMOTIONS", "promotions"], ["CATEGORY_SOCIAL", "social"], ["CATEGORY_UPDATES", "updates"], ["CATEGORY_FORUMS", "forums"]];

export function mapMessage(raw: GmailMessage): MessageRow | null {
  if (!raw.id) return null;
  const labels = raw.labelIds ?? [];
  const from = parseAddress(header(raw.payload, "from"));
  const { body, attachments, incomplete } = extractBody(raw.payload);
  return {
    id: raw.id, threadId: raw.threadId ?? raw.id,
    from: from.name.slice(0, 200), fromEmail: from.email.slice(0, 320), to: header(raw.payload, "to").slice(0, 1000),
    subject: (header(raw.payload, "subject") || "(no subject)").slice(0, 500),
    snippet: (raw.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    body, attachments, bodyIncomplete: incomplete,
    receivedAt: Number(raw.internalDate ?? 0) || Date.parse(header(raw.payload, "date")) || 0,
    unread: labels.includes("UNREAD"), important: labels.includes("IMPORTANT"), starred: labels.includes("STARRED"),
    category: CATEGORIES.find(([label]) => labels.includes(label))?.[1] ?? "primary",
  };
}

async function inParallel<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]); }
  }));
  return results;
}

async function ids(session: Pick<GoogleSession, "get">, q: string, signal?: AbortSignal): Promise<string[]> {
  const found = new Set<string>();
  const tokens = new Set<string>();
  let token: string | undefined;
  do {
    const query = new URLSearchParams({ q, maxResults: String(INBOX_MAX - found.size), fields: "messages/id,nextPageToken" });
    if (token) query.set("pageToken", token);
    const body = await session.get(`${API}/messages?${query}`, signal);
    for (const { id } of (body.messages ?? []) as Array<{ id?: string }>) {
      if (id) found.add(id);
      if (found.size === INBOX_MAX) break;
    }
    token = body.nextPageToken as string | undefined;
    if (token && tokens.has(token)) throw new Error("Gmail returned a repeated page token");
    if (token) tokens.add(token);
  } while (token && found.size < INBOX_MAX);
  return [...found];
}

/** An ID can disappear between listing the inbox and reading the message. Other failures keep the last mirror. */
async function getMessage(session: Pick<GoogleSession, "get">, id: string, format: "full" | "minimal", signal?: AbortSignal): Promise<GmailMessage | null> {
  const query = new URLSearchParams({ format });
  if (format === "minimal") query.set("fields", "id,labelIds");
  try {
    const raw = await session.get(`${API}/messages/${encodeURIComponent(id)}?${query}`, signal) as GmailMessage;
    if (raw.id !== id) throw new Error("Gmail returned an unexpected message");
    return raw.labelIds?.some((label) => label === "TRASH" || label === "SPAM") ? null : raw;
  } catch (error) {
    if (error instanceof ServiceError && (error.status === 404 || error.status === 410)) return null;
    throw error;
  }
}

/** Known IDs are ordered by their oldest out-of-window verification, so even a large retained collection is revisited. */
export async function readInbox(
  session: Pick<GoogleSession, "get">, known: ReadonlySet<string>, dueForVerification: string[], signal?: AbortSignal,
) {
  const [recent, unreadIds, starredIds, importantIds] = await Promise.all([
    ids(session, INBOX_QUERY, signal),
    ids(session, `${INBOX_QUERY} is:unread`, signal),
    ids(session, `${INBOX_QUERY} is:starred`, signal),
    ids(session, `${INBOX_QUERY} is:important`, signal),
  ]);
  const inbox = new Set(recent);
  const fresh = recent.filter((id) => !known.has(id)).slice(0, NEW_PER_PASS);
  const added: MessageRow[] = [];
  for (const raw of await inParallel(fresh, CONCURRENCY, (id) => getMessage(session, id, "full", signal))) {
    if (raw?.labelIds?.includes("INBOX")) {
      const row = mapMessage(raw);
      if (row) added.push(row);
    }
  }
  const outside = dueForVerification.filter((id) => !inbox.has(id)).slice(0, OUTSIDE_PER_PASS);
  const checked = await inParallel(outside, CONCURRENCY, async (id) => {
    const raw = await getMessage(session, id, "minimal", signal);
    return { id, labels: raw ? new Set(raw.labelIds ?? []) : null };
  });
  return { inbox, unread: new Set(unreadIds), starred: new Set(starredIds), important: new Set(importantIds), added, checked };
}
