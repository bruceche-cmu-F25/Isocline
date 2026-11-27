import type { Notice } from "@zirma/protocol";
import type { FigureState } from "./entity/tesseract.js";
import { getLocale, localeTag, translate, type Locale, getAssistant } from "./i18n/dict.ts";
import { plainText } from "./markdown.ts";

/** What Zirma says about a notice, how the figure looks while saying it, and what opening it means. */
export interface NoticeLines {
  title: string;
  body: string;
  /** The figure's state while this notice is on screen. */
  mood: FigureState;
  /** A question is closed by answering it and a proposal by deciding it, never just by opening them. */
  closesOnOpen: boolean;
  /** The label of the open button. */
  action: string;
}

/** The durable Inbox row behind a notification, when there is one to review. */
export function inboxTarget(notice: Pick<Notice, "id" | "kind" | "payload">): string | null {
  if (notice.kind === "proposal" && typeof notice.payload.proposalId === "string") return `p:${notice.payload.proposalId}`;
  if (notice.kind === "run_request" && typeof notice.payload.runId === "string") return `r:${notice.payload.runId}`;
  if (notice.kind === "run_result" && (notice.payload.delivery === "inbox" || typeof notice.payload.automationId === "string")) return `n:${notice.id}`;
  if (notice.kind === "outbound" || notice.kind === "run_interrupted") return `n:${notice.id}`;
  return null;
}

export function inboxUrl(item: string | null): string {
  return pageUrl("core.inbox", item);
}

/** A page of the app, and the thing on it to show. */
export function pageUrl(page: string, item?: string | null): string {
  const params = new URLSearchParams({ p: page });
  if (item) params.set("item", item);
  return `/#${params}`;
}

/** What a reminder (docs/design/reminders.md) is about, as its notice carries it. */
export interface ReminderLine { source: "event" | "todo" | "mail"; id: string; title: string; at: string; location?: string; meeting?: boolean; from?: string; account?: string }
const reminderItems = (notice: Pick<Notice, "payload">): ReminderLine[] => Array.isArray(notice.payload.items) ? notice.payload.items as ReminderLine[] : [];

/** Where opening a reminder goes: the page of the thing it is about (a message: that message). */
export function reminderPage(notice: Pick<Notice, "kind" | "payload">): { page: string; item?: string } | null {
  if (notice.kind !== "reminder") return null;
  const [first] = reminderItems(notice);
  if (!first) return null;
  if (first.source === "event") return { page: "calendar.week" };
  if (first.source === "todo") return { page: "todo.list" };
  return { page: "mail.inbox", ...(first.account ? { item: `${first.account}|${first.id}` } : {}) };
}

/** What a reminder says, in `locale`, at `now`: "In 10 min: Group meeting", and where or when. Shared with the
 * home node's push text. */
export function reminderText(notice: Pick<Notice, "payload">, locale: Locale, now: number = Date.now()): { title: string; body: string } {
  const say = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  const items = reminderItems(notice);
  const [first] = items;
  if (!first) return { title: getAssistant(), body: "" };
  const time = (iso: string) => new Intl.DateTimeFormat(localeTag(locale), { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  if (first.source === "mail") {
    if (items.length === 1) return { title: say("rem.mail.one", { from: first.from ?? "" }), body: first.title };
    return { title: say("rem.mail.many", { n: items.length }), body: items.map((item) => item.from ?? "").filter(Boolean).join(locale === "zh" ? "、" : ", ") };
  }
  const minutes = Math.max(1, Math.round((Date.parse(first.at) - now) / 60_000));
  const when = minutes >= 60 && minutes % 60 === 0 ? say("rem.hours", { n: minutes / 60 }) : say("rem.min", { n: minutes });
  const title = items.length > 1 ? say("rem.more", { title: first.title, n: items.length - 1 }) : first.title;
  if (first.source === "todo") return { title: say("rem.todo.in", { when, title }), body: say("rem.todo.at", { time: time(first.at) }) };
  return { title: say("rem.event.in", { when, title }), body: first.location || (first.meeting ? say("rem.meeting") : say("rem.at", { time: time(first.at) })) };
}

/** What an outbound notice says it did: the change itself, or, for the several one proposal made (told together by
 * the core's outbound.ts), how many went through. Shared with the home node's push text. */
export function outboundWhat(payload: Record<string, unknown>, say: (key: "mac.outbound.many" | "mac.outbound.many.calendar" | "mac.outbound.many.mail", vars: Record<string, string>) => string): string {
  const count = typeof payload.count === "number" ? payload.count : 1;
  if (count < 2) return String(payload.preview ?? "");
  return say(payload.module === "calendar" ? "mac.outbound.many.calendar" : payload.module === "mail" ? "mac.outbound.many.mail" : "mac.outbound.many", { n: String(count) });
}

/** In `locale` (default: the current one). Shared by the figure and the Mac app's fallback notifications. */
export function noticeLines(notice: Notice, locale: Locale = getLocale()): NoticeLines {
  const say = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  const goal = String(notice.payload.goal ?? "");
  const look = say("presence.action.look");
  if (notice.kind === "reminder") {
    const { title, body } = reminderText(notice, locale);
    return { title, body, mood: "notice", closesOnOpen: true, action: look };
  }
  if (notice.kind === "run_interrupted") {
    return { title: say("mac.interrupted.title"), body: say("mac.interrupted.body", { goal }), mood: "error", closesOnOpen: false, action: look };
  }
  if (notice.kind === "proposal") {
    return { title: say("mac.proposal.title"), body: String(notice.payload.title ?? ""), mood: "notice", closesOnOpen: false, action: say("presence.action.decide") };
  }
  if (notice.kind === "run_request") {
    const permission = notice.payload.kind === "permission";
    return {
      title: say(permission ? "mac.permission.title" : "mac.input.title"), body: String(notice.payload.question ?? goal),
      mood: "notice", closesOnOpen: false, action: say(permission ? "presence.action.allow" : "presence.action.answer"),
    };
  }
  if (notice.kind === "outbound") {
    // An accepted change sent to Google (calendar, mail): whether it got there.
    const preview = outboundWhat(notice.payload, say);
    const state = notice.payload.state;
    if (state === "done") return { title: say("mac.outbound.done"), body: preview, mood: "done", closesOnOpen: false, action: look };
    if (state === "failed") {
      const error = notice.payload.error ? String(notice.payload.error) : "";
      return { title: say("mac.outbound.failed"), body: error ? say("mac.outbound.failedBody", { preview, error }) : preview, mood: "error", closesOnOpen: false, action: look };
    }
    return { title: say("mac.outbound.unknown"), body: say("mac.outbound.unknownBody", { preview }), mood: "notice", closesOnOpen: false, action: look };
  }
  const status = notice.payload.status;
  if (status === "failed") return { title: say("mac.failed.title"), body: say("mac.goal", { goal }), mood: "error", closesOnOpen: true, action: look };
  if (status === "cancelled") return { title: say("mac.cancelled.title"), body: say("mac.goal", { goal }), mood: "rest", closesOnOpen: true, action: look };
  return { title: goal ? say("mac.goal", { goal }) : getAssistant(), body: (typeof notice.payload.reply === "string" && plainText(notice.payload.reply)) || say("mac.done.body", { goal }), mood: "done", closesOnOpen: true, action: look };
}
