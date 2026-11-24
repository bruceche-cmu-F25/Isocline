/** The inbox (the 通知 page): one list of what needs the user or what Zirma wants them to know, read from the
 * core's state. It stores nothing of its own: an item leaves when its proposal is decided, its run moves on, or its
 * notice is acknowledged.
 *   decide  a proposal; a run waiting on an answer or a permission; a run that was interrupted
 *   result  a run finished (not yet seen)
 *   away    what happened while the user was away
 */
import type { AwayDigest, Notice, Proposal, Run, StateResponse } from "@zirma/protocol";
import { getLocale, t, type Key } from "../i18n/dict.ts";
import { plainText } from "../markdown.ts";
import { automationTitle, editionTitle } from "../automationText.ts";
import { awayUpdate } from "../welcome.ts";
import { outboundWhat } from "../noticeText.ts";

export type InboxKind = "decide" | "result" | "away" | "remind";
export const KINDS: Array<[InboxKind, Key, string]> = [["decide", "inbox.k.decide", "warm"], ["result", "inbox.k.result", "alfred"], ["away", "inbox.k.away", "gray"], ["remind", "inbox.k.remind", "teal"]];
export const kindName = (kind: InboxKind) => t(KINDS.find(([id]) => id === kind)![1]);
export const kindColour = (kind: InboxKind) => KINDS.find(([id]) => id === kind)![2];

export interface InboxItem {
  id: string;
  kind: InboxKind;
  title: string;
  summary: string;
  at: string;
  conversationId: string | null;
  runId: string | null;
  proposal?: Proposal;
  run?: Run;
  notice?: Notice;
  edition?: Edition;
  results?: Array<AwayResult & { edition?: Edition }>;
  /** Additional notices covered by the same row, e.g. a return that only reports this result. */
  alsoNotices?: Notice[];
}

type AwayResult = NonNullable<AwayDigest["runs"]["results"]>[number];
export interface Edition {
  /** Drawn in sections: its automation says so, or the notice did when it was made. */
  sections: boolean;
  name: string;
  runId: string;
  conversationId: string;
  at: string;
  title: string;
  preview: string;
  run?: Run;
}

/** A saved welcome from before run references can be linked when its single completion is unambiguous. */
function awayResults(digest: AwayDigest, returnedAt: string, state: StateResponse): NonNullable<AwayDigest["runs"]["results"]> {
  if (digest.runs.results) return digest.runs.results;
  if (digest.runs.completed !== 1 || digest.runs.goals.length !== 1) return [];
  const candidates = state.runs.filter((run) => run.state === "completed" && run.updatedAt > digest.since && run.updatedAt <= returnedAt);
  const [run] = candidates;
  if (candidates.length !== 1 || run.goal.slice(0, 80) !== digest.runs.goals[0]) return [];
  const automation = state.automations?.find((candidate) => candidate.id === run.automationId);
  return [{ runId: run.id, conversationId: run.conversationId, at: run.updatedAt, name: automation ? automationTitle(automation) : null }];
}

/** A persisted result is addressable even when it has fallen outside the state's recent runs. */
function editionFor(result: AwayResult, state: StateResponse, notice?: Notice): Edition | undefined {
  const run = state.runs.find((candidate) => candidate.id === result.runId);
  const id = notice?.payload.automationId ?? run?.automationId;
  const automation = state.automations?.find((candidate) => id
    ? candidate.id === id
    : candidate.lastRunId === result.runId || (result.name && candidate.conversationId === result.conversationId));
  if (!automation && !id && notice?.payload.delivery !== "inbox" && !result.name) return undefined;
  const savedName = result.name ?? (typeof notice?.payload.goal === "string" ? notice.payload.goal : null);
  const name = automation ? automationTitle(automation) : savedName || t("inbox.k.result");
  const at = run?.createdAt ?? result.at;
  const snippet = run?.outcome?.reply ?? (typeof notice?.payload.reply === "string" ? notice.payload.reply : undefined)
    ?? (automation?.lastRun?.id === result.runId ? automation.lastRun.reply : null);
  const sections = (automation ? automation.layout : notice?.payload.layout) === "sections";
  return { sections, runId: result.runId, conversationId: result.conversationId, name, title: editionTitle(name, at),
    at, preview: snippet ? plainText(snippet).slice(0, 280) : "", run };
}

export function inboxItems(state: StateResponse): InboxItem[] {
  const items: InboxItem[] = [];
  for (const proposal of state.proposals ?? []) {
    // Being revised: it stays where it was, saying so, until the new version takes its place.
    const summary = proposal.revising ? t("inbox.revisingShort") : proposal.summary;
    items.push({ id: `p:${proposal.id}`, kind: "decide", title: proposal.title, summary, at: proposal.createdAt,
      conversationId: proposal.conversationId, runId: proposal.runId, proposal });
  }
  for (const run of state.runs) {
    if (!run.request) continue;
    items.push({ id: `r:${run.id}`, kind: "decide", title: run.request.question,
      summary: t(run.request.kind === "permission" ? "inbox.r.permission" : "inbox.r.input", { goal: run.goal }), at: run.request.createdAt,
      conversationId: run.conversationId, runId: run.id, run });
  }
  const delivered = new Map<string, InboxItem>();
  // Handle results before returns so a result keeps its canonical notification link.
  const notices = [...state.notices].sort((a, b) => Number(a.kind === "welcome") - Number(b.kind === "welcome"));
  for (const notice of notices) {
    const goal = String(notice.payload.goal ?? "");
    const conversationId = (notice.payload.conversationId as string | undefined) ?? null, runId = (notice.payload.runId as string | undefined) ?? null;
    if (notice.kind === "run_interrupted") {
      items.push({ id: `n:${notice.id}`, kind: "decide", title: t("inbox.interrupted.title", { goal }), summary: t("inbox.interrupted.summary"),
        at: notice.createdAt, conversationId, runId, notice });
    } else if (notice.kind === "run_result") {
      // A run that left a proposal is said by the proposal itself.
      if (runId && (state.proposals ?? []).some((proposal) => proposal.runId === runId)) continue;
      const status = notice.payload.status;
      // The notice carries the start of the reply, cut short: shown as plain text, since Markdown cut in the middle draws wrong.
      const reply = typeof notice.payload.reply === "string" ? plainText(notice.payload.reply) : "";
      const summary = status === "failed" ? t("inbox.failed") : status === "cancelled" ? t("inbox.cancelled") : reply || t("inbox.done");
      const edition = runId && conversationId ? editionFor({ runId, conversationId, at: notice.createdAt,
        name: notice.payload.automationId || notice.payload.delivery === "inbox" ? goal : null }, state, notice) : undefined;
      const item: InboxItem = { id: `n:${notice.id}`, kind: "result", title: edition?.title ?? goal, summary: edition?.preview || summary,
        at: edition?.at ?? notice.createdAt, conversationId, runId, notice, edition };
      if (edition) delivered.set(edition.runId, item);
      items.push(item);
    } else if (notice.kind === "outbound") {
      // A change outside Zirma (an event, an email) after the user's yes: how it went. Unknown needs them to check.
      const status = notice.payload.state, module = notice.payload.module;
      const summary = status === "unknown"
        ? t(module === "mail" ? "inbox.mail.unknown" : module === "calendar" ? "inbox.calendar.unknown" : "inbox.sent.unknown")
        // Several a proposal made, told together: where they came from.
        : status === "done" && typeof notice.payload.count === "number" && notice.payload.count > 1
          ? (typeof notice.payload.title === "string" ? t("inbox.sent.from", { title: notice.payload.title }) : t("inbox.sent.done"))
        : status === "done" ? t(module === "mail" ? "inbox.mail.sent" : "inbox.sent.done")
        : t("inbox.sent.failed", { error: String(notice.payload.error ?? "") });
      items.push({ id: `n:${notice.id}`, kind: needsReview(notice) ? "decide" : "result", title: outboundWhat(notice.payload, t),
        summary, at: notice.createdAt, conversationId: null, runId: null, notice });
    } else if (notice.kind === "welcome") {
      const digest = notice.payload as unknown as AwayDigest;
      const results = awayResults(digest, notice.createdAt, state).map((result) => {
        const source = state.notices.find((candidate) => candidate.kind === "run_result" && candidate.payload.runId === result.runId);
        const edition = editionFor(result, state, source);
        return { ...result, edition };
      });
      const edition = results[0]?.edition;
      if (edition && digest.runs.completed === 1 && !digest.runs.failed && !digest.runs.interrupted && !digest.waiting) {
        const previous = delivered.get(edition.runId);
        if (previous) (previous.alsoNotices ??= []).push(notice);
        else {
          const item: InboxItem = { id: `n:${notice.id}`, kind: "result", title: edition.title, summary: edition.preview, at: edition.at,
            runId: edition.runId, conversationId: edition.conversationId, notice, edition };
          delivered.set(edition.runId, item);
          items.push(item);
        }
        continue;
      }
      const update = awayUpdate(digest, getLocale(), results[0]?.name);
      if (!update) continue;
      const summary = t("inbox.awaySummary", { update: update[0].toLocaleUpperCase(getLocale()) + update.slice(1) });
      items.push({ id: `n:${notice.id}`, kind: "away", title: t("inbox.k.away"), summary, at: notice.createdAt, conversationId: null, runId: null, notice, results });
    }
  }
  // What needs a decision first; within each, newest first.
  return items.sort((a, b) => Number(b.kind === "decide") - Number(a.kind === "decide") || b.at.localeCompare(a.at));
}

/** Proposals and questions have their own rows; these two kinds exist only as notices. */
function needsReview(notice: Notice): boolean {
  if (notice.kind !== "outbound" && notice.kind !== "run_interrupted") return false;
  return notice.class ? notice.class === "needs_you" : notice.kind === "run_interrupted" || notice.payload.state !== "done";
}

export const waitingCount = (state: StateResponse) =>
  (state.proposals ?? []).length + state.runs.filter((run) => run.request).length + state.notices.filter(needsReview).length;
