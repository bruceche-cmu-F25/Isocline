import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Proposal, StateResponse } from "@isocline/protocol";
import type { MailSnapshot } from "@isocline/module-mail/types";
import { api } from "./api.ts";
import { Linked, OutLink } from "./Linked.tsx";
import { RunResult } from "./RunResult.tsx";
import { Request } from "./Conversation.tsx";
import type { PageLine } from "./shell/about.ts";
import { inboxItems, kindColour, kindName, KINDS, type InboxItem, type InboxKind } from "./shell/inbox.ts";
import { when } from "./shell/Nav.tsx";
import { Figure } from "./shell/Figure.tsx";
import { dragHandle, PHONE, useMedia } from "./shell/layout.ts";
import { editionDate, hhmm } from "./automationText.ts";
import "./inbox-reader.css";
import { intlLocale, t } from "./i18n/index.ts";
import { snapshotOf } from "./modules.ts";

export interface InboxProps {
  state: StateResponse;
  /** An item to bring up (e.g. from a notification): `p:<proposal id>`, `r:<run id>`, `n:<notice id>`. */
  focus: string | null;
  onFocused(): void;
  onOpenConversation(conversationId: string, runId?: string): void;
  /** The bar under the page: what to change about a proposal is written there, as everywhere. */
  line: PageLine;
}

/** What one decision did, said back briefly. */
export function outcomeText({ state, outcome }: Proposal): string {
  if (state === "executed") {
    if (outcome?.deliveryQueued === undefined) return t("inbox.approved");
    return t(outcome.deliveryQueued ? "inbox.out.queued" : "inbox.done");
  }
  if (state === "stale") return t("inbox.out.stale");
  if (state === "expired") return t("inbox.out.expired");
  if (state === "failed") return t("inbox.out.failed", { error: outcome?.error ?? t("inbox.out.error") });
  return "";
}

/** Older mail notices can still be matched to their sending account by the outbound record's id. */
function reviewLink(payload: Record<string, unknown>, mail?: MailSnapshot) {
  const email = payload.module === "mail" && payload.action === "send";
  if (!email && payload.module !== "calendar") return null;
  let account = payload.account;
  if (typeof account !== "string" && email) account = mail?.sent?.find((sent) => sent.id === payload.outboundId)?.account;
  if (typeof account !== "string" || !/^[^\s@/]+@[^\s@/]+$/.test(account)) return null;
  const id = encodeURIComponent(account);
  return email
    ? { href: `https://mail.google.com/mail/u/${id}/#sent`, label: t("inbox.openSent") }
    : { href: `https://calendar.google.com/calendar/?authuser=${id}`, label: t("inbox.openCalendar") };
}

/** One thing, in full, with what can be done about it. Also what a waiting row on 今天 opens into (Today.tsx). */
export function Detail({ item, onDone, onOpenConversation, conversationTitle, line, mail }: {
  item: InboxItem; mail?: MailSnapshot; onDone(message?: string): void; onOpenConversation(conversationId: string, runId?: string): void; conversationTitle?: string; line: PageLine;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setError(null); }, [item.id]);
  // Another item, or none: the words in the bar were about the one before.
  const lineNow = useRef(line);
  lineNow.current = line;
  useEffect(() => () => { if (lineNow.current.about?.startsWith("inbox:")) lineNow.current.attach(null); }, [item.id]);

  const act = (action: () => Promise<string | undefined | void>) => {
    setBusy(true);
    setError(null);
    action().then((message) => onDone(message ?? undefined)).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const { proposal, run, notice, edition } = item;
  const acknowledge = async () => {
    for (const other of item.alsoNotices ?? []) await api.acknowledge(other.id);
    if (notice) await api.acknowledge(notice.id);
  };
  const outbound = notice?.kind === "outbound" ? notice.payload : undefined;
  const providerLink = outbound && reviewLink(outbound, mail);

  return (
    <article className="inbox-detail" data-k={kindColour(item.kind)} aria-label={item.title}>
      <header className="inbox-detail-head">
        <h2><Linked text={edition?.name ?? item.title} /></h2>
        <p className="inbox-kind">
          {!edition && item.kind !== "away" && <span className="tag" data-k={kindColour(item.kind)}>{kindName(item.kind)}</span>}
          <time dateTime={item.at}>{edition ? `${editionDate(item.at)} · ${hhmm(new Date(item.at))}` : when(item.at)}</time>
          {!edition && item.conversationId && conversationTitle && (
            <button type="button" className="link" onClick={() => onOpenConversation(item.conversationId!, item.runId ?? undefined)}>{t("inbox.from", { title: conversationTitle })}</button>
          )}
        </p>
      </header>
      {edition
        ? <RunResult key={edition.runId} runId={edition.runId} run={edition.run} preview={edition.preview} sections={edition.sections} reading />
        : (proposal?.revising ? proposal.summary : item.summary) && <p className="inbox-summary"><Linked text={proposal?.revising ? proposal.summary : item.summary} /></p>}

      {proposal && (
        <>
          <div className="card">
            <p className="card-label">{proposal.revising ? t("inbox.stepsWas", { n: proposal.steps.length }) : proposal.stale ? t("inbox.stepsStale") : t("inbox.steps", { n: proposal.steps.length })}</p>
            <ol className="proposal-steps">{proposal.steps.map((step, n) => (
              <li key={n}><Linked text={step.preview} />{step.detail && <pre className="step-detail"><Linked text={step.detail} /></pre>}</li>
            ))}</ol>
          </div>
          {proposal.revising ? (
            <>
              <p className="inbox-revising" role="status"><span className="working-label">{t("inbox.revisingShort")}</span></p>
              {proposal.revising.request && <p className="quiet small inbox-revising-asked">{t("inbox.revising", { request: proposal.revising.request })}</p>}
              <div className="inbox-actions">
                {proposal.conversationId && <button type="button" className="ghost" onClick={() => onOpenConversation(proposal.conversationId!, proposal.revising!.runId)}>{t("inbox.openConversation")}</button>}
                <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.decline(proposal.id).then(() => undefined))}>{t("common.no")}</button>
              </div>
            </>
          ) : proposal.stale ? (
            <>
              <p className="problem small">{t("inbox.staleWarn")}</p>
              <div className="inbox-actions">
                <button type="button" disabled={busy} onClick={() => act(() => api.revise(proposal.id, t("inbox.lookAgainText")).then(() => t("inbox.lookingAgain")))}>{t("inbox.lookAgain")}</button>
                <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.decline(proposal.id).then(() => undefined))}>{t("common.no")}</button>
              </div>
            </>
          ) : (
            <div className="inbox-actions">
              <button type="button" disabled={busy} onClick={() => act(() => api.accept(proposal.id).then(({ proposal: done }) => outcomeText(done)))}>
                {proposal.steps.length > 1 ? t("inbox.acceptN", { n: proposal.steps.length }) : t("inbox.accept")}
              </button>
              {/* What to change is said in the bar under the page; the new version then lands in this list. */}
              <button type="button" className="ghost" disabled={busy} aria-pressed={line.about === `inbox:change:${proposal.id}`} onClick={() => line.attach(line.about === `inbox:change:${proposal.id}` ? null : {
                key: `inbox:change:${proposal.id}`, label: t("inbox.revise"), placeholder: t("inbox.revisePlaceholder"),
                send: async (words) => { await line.revise(proposal.id, words, { id: proposal.id, title: proposal.title.slice(0, 200) }); onDone(t("inbox.revised")); },
              })}>{t("inbox.revise")}</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.decline(proposal.id).then(() => undefined))}>{t("common.no")}</button>
            </div>
          )}
          {!proposal.revising && <p className="quiet small">{t("inbox.expires", { date: new Date(proposal.expiresAt).toLocaleDateString(intlLocale(), { month: "long", day: "numeric" }) })}</p>}
        </>
      )}

      {run?.request && (
        <>
          <Request key={run.request.id} run={run} request={run.request} showQuestion={false} onAnswered={() => onDone()} />
          <div className="inbox-actions">
            <button type="button" className="ghost" onClick={() => onOpenConversation(run.conversationId, run.id)}>{t("inbox.answerInConversation")}</button>
          </div>
        </>
      )}

      {notice && outbound && Array.isArray(outbound.previews) && outbound.previews.length > 1 && (
        <div className="card">
          <ol className="proposal-steps">{outbound.previews.map((preview, n) => <li key={n}><Linked text={String(preview)} /></li>)}</ol>
        </div>
      )}
      {notice && outbound && (
        <div className="inbox-actions">
          {providerLink && <OutLink href={providerLink.href}>{providerLink.label}</OutLink>}
          <button type="button" disabled={busy} onClick={() => act(() => api.acknowledge(notice.id).then(() => undefined))}>
            {t(outbound.state === "unknown" ? "inbox.checked" : "common.gotIt")}
          </button>
        </div>
      )}

      {notice?.kind === "run_interrupted" && (
        <div className="inbox-actions">
          <button type="button" disabled={busy} onClick={() => act(async () => { await api.resume(String(notice.payload.runId)); await api.acknowledge(notice.id); return t("inbox.resumed"); })}>{t("inbox.resume")}</button>
          <button type="button" className="ghost" disabled={busy} onClick={() => act(() => api.acknowledge(notice.id).then(() => undefined))}>{t("common.no")}</button>
        </div>
      )}
      {item.results?.map(({ edition }) => edition && (
        <details key={edition.runId} className="away-edition">
          <summary>{edition.title}</summary>
          <RunResult runId={edition.runId} run={edition.run} preview={edition.preview} sections={edition.sections} reading />
        </details>
      ))}
      {(notice?.kind === "run_result" || notice?.kind === "welcome") && (
        <div className="inbox-actions">
          {edition && <button type="button" disabled={busy} onClick={() => act(acknowledge)}>{t("common.gotIt")}</button>}
          {item.results?.filter((result) => !result.edition).map((result) => (
            <button type="button" key={result.runId} onClick={() => onOpenConversation(result.conversationId, result.runId)}>
              {result.name ? t("inbox.openNamedResult", { name: result.name }) : t("inbox.openTimedResult", { time: new Date(result.at).toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit" }) })}
            </button>
          ))}
          {item.conversationId && <button type="button" className={edition ? "ghost" : undefined} onClick={() => { if (!edition) void acknowledge().catch(() => {}); onOpenConversation(item.conversationId!, item.runId ?? undefined); }}>{t("inbox.openConversation")}</button>}
          {!edition && <button type="button" className={item.conversationId || item.results?.length ? "ghost" : undefined} disabled={busy} onClick={() => act(acknowledge)}>{t("common.gotIt")}</button>}
        </div>
      )}
      {error && <p className="problem small" role="alert">{error}</p>}
    </article>
  );
}

const LIST_WIDTH_KEY = "isocline.inbox.listWidth";
const MIN_LIST_WIDTH = 160;
const MIN_DETAIL_WIDTH = 320;

function savedListWidth(): number | null {
  try {
    const width = Number(localStorage.getItem(LIST_WIDTH_KEY));
    return Number.isFinite(width) && width >= MIN_LIST_WIDTH ? width : null;
  } catch { return null; }
}

/** 通知: what needs you, and what Isocline wants you to know. A list on the left, the chosen item on the right. */
export function Inbox({ state, focus, onFocused, onOpenConversation, line }: InboxProps) {
  const inbox = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLButtonElement | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const phone = useMedia(PHONE);
  const [pageWidth, setPageWidth] = useState(0);
  const [preferredListWidth, setPreferredListWidth] = useState(savedListWidth);
  // The navigation and assistant panels can resize this page without resizing the window.
  useLayoutEffect(() => {
    const element = inbox.current;
    if (!element) return;
    const measure = () => setPageWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      if (preferredListWidth === null) localStorage.removeItem(LIST_WIDTH_KEY);
      else localStorage.setItem(LIST_WIDTH_KEY, String(preferredListWidth));
    } catch { /* keep the width for this visit */ }
  }, [preferredListWidth]);
  const items = useMemo(() => inboxItems(state), [state]);
  const [filter, setFilter] = useState<InboxKind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    if (!focus) return;
    setFilter("all");
    const target = items.find((item) => item.id === focus || item.alsoNotices?.some((notice) => `n:${notice.id}` === focus));
    if (target) setSelected(target.id);
    else { setSelected(null); setSaid(t("inbox.noLongerPending")); }
    onFocused();
  }, [focus, items, onFocused]);
  useEffect(() => { if (!said) return; const timer = window.setTimeout(() => setSaid(null), 5000); return () => window.clearTimeout(timer); }, [said]);

  const activeFilter = items.some((item) => item.kind === filter) ? filter : "all";
  useEffect(() => { if (filter !== activeFilter) setFilter(activeFilter); }, [filter, activeFilter]);
  const shown = items.filter((item) => activeFilter === "all" || item.kind === activeFilter);
  const firstUpdate = shown.findIndex((item) => item.kind !== "decide");
  const grouped = activeFilter === "all" && firstUpdate > 0;
  const current = shown.find((item) => item.id === selected) ?? null;
  const onlyItem = items.length === 1 && !phone;
  const columns = pageWidth >= 740 && !phone && !onlyItem;
  const defaultListWidth = Math.min(272, Math.max(200, Math.round(pageWidth * 0.23)));
  const maxListWidth = Math.max(MIN_LIST_WIDTH, pageWidth - MIN_DETAIL_WIDTH);
  const clampList = (width: number) => Math.min(maxListWidth, Math.max(MIN_LIST_WIDTH, Math.round(width)));
  const listWidth = clampList(preferredListWidth ?? defaultListWidth);
  const detail = current ?? (columns || onlyItem ? shown[0] : null);
  const titleOf = (id: string | null) => state.conversations.find((conversation) => conversation.id === id)?.title;
  const chips = [["all", t("common.all"), items.length] as const, ...KINDS.map(([kind, name]) => [kind, t(name), items.filter((item) => item.kind === kind).length] as const).filter(([, , count]) => count > 0)];

  return (
    <section ref={inbox} className="inbox" aria-label={t("inbox.label")}>
      {chips.length > 2 && (items.length > 5 || activeFilter !== "all") && (
        <div className="chips" role="group" aria-label={t("inbox.byKind")}>
          {chips.map(([id, name, count]) => (
            <button type="button" key={id} className="chip" aria-pressed={activeFilter === id} onClick={() => setFilter(id)}>
              {id !== "all" && <span className="mark" data-k={kindColour(id)} />}{name}<span className="count">{count}</span>
            </button>
          ))}
        </div>
      )}
      {said && <p className="inbox-said" role="status">{said}</p>}
      {!items.length ? (
        <div className="empty inbox-entry">
          <div className="inbox-entry-center">
            <Figure state="rest" size={112} className="figure-tour" />
            <div className="inbox-entry-body">
              <p className="empty-title" role="status">{t("inbox.emptyTitle")}</p>
              <p className="quiet">{t("inbox.emptyHint")}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="split" data-columns={columns || undefined}
          style={columns ? { gridTemplateColumns: `${listWidth}px 0 minmax(0, 1fr)` } : undefined}>
          <ul className="inbox-list" id="inbox-list" hidden={!!detail && !columns}>
            {shown.map((item, index) => (
              <li key={item.id}>
                {grouped && (index === 0 || index === firstUpdate) &&
                  <h3 className="inbox-group-title">{t(index === 0 ? "inbox.k.decide" : "inbox.updates")}</h3>}
                <button type="button" className="note" aria-current={detail?.id === item.id ? "true" : undefined} onClick={(event) => {
                  returnTo.current = event.currentTarget;
                  setSelected(item.id);
                  if (!columns) requestAnimationFrame(() => back.current?.focus());
                }}>
                  <span className="mark" data-k={kindColour(item.kind)} aria-label={kindName(item.kind)} />
                  <span className="note-body"><b>{item.edition?.name ?? item.title}</b>{item.summary && <span>{item.summary}</span>}</span>
                  <time dateTime={item.at}>{when(item.at)}</time>
                </button>
              </li>
            ))}
          </ul>
          {columns && (
            <div className="resizer resizer-inbox" role="separator" tabIndex={0} aria-orientation="vertical"
              aria-controls="inbox-list" aria-label={t("inbox.listWidth")} title={t("resize.inbox")}
              aria-valuemin={MIN_LIST_WIDTH} aria-valuemax={maxListWidth} aria-valuenow={listWidth}
              onPointerDown={dragHandle(listWidth, "right", (width) => setPreferredListWidth(clampList(width)))}
              onDoubleClick={() => setPreferredListWidth(null)}
              onKeyDown={(event) => {
                const widths: Record<string, number> = {
                  ArrowLeft: listWidth - 16, ArrowRight: listWidth + 16, Home: MIN_LIST_WIDTH, End: maxListWidth,
                };
                if (!Object.hasOwn(widths, event.key)) return;
                event.preventDefault();
                setPreferredListWidth(clampList(widths[event.key]));
              }} />
          )}
          {detail && (
            <div className="inbox-pane" key={detail.id}>
              {!columns && !onlyItem && <button type="button" ref={back} className="back link" onClick={() => {
                setSelected(null);
                requestAnimationFrame(() => returnTo.current?.focus());
              }}>{t("inbox.back")}</button>}
              <Detail item={detail} mail={snapshotOf(state, "mail")} conversationTitle={titleOf(detail.conversationId) ?? undefined} onOpenConversation={onOpenConversation} line={line}
                onDone={(message) => { setSelected(null); if (message) setSaid(message); }} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
