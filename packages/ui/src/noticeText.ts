import type { Notice } from "@isocline/protocol";
import type { FigureState } from "./entity/tesseract.js";
import { getLocale, translate, type Locale, getAssistant } from "./i18n/dict.ts";
import { plainText } from "./markdown.ts";

/** What Isocline says about a notice, how the figure looks while saying it, and what opening it means. */
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
  const params = new URLSearchParams({ p: "core.inbox" });
  if (item) params.set("item", item);
  return `/#${params}`;
}

/** In `locale` (default: the current one). Shared by the figure and the Mac app's fallback notifications. */
export function noticeLines(notice: Notice, locale: Locale = getLocale()): NoticeLines {
  const say = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars);
  const goal = String(notice.payload.goal ?? "");
  const look = say("presence.action.look");
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
    const preview = String(notice.payload.preview ?? "");
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
