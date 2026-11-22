import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Proposal, StateResponse } from "@alfred/protocol";
import type { MailSnapshot } from "@alfred/module-mail/types";
import { api } from "./api.ts";
import { InboxEntry, type NamePreference } from "./InboxEntry.tsx";
import { Linked, OutLink } from "./Linked.tsx";
import { RunResult } from "./RunResult.tsx";
import { Request } from "./Conversation.tsx";
import type { PageLine } from "./shell/about.ts";
import { inboxItems, kindColour, kindName, KINDS, type InboxItem, type InboxKind } from "./shell/inbox.ts";
import { when } from "./shell/Nav.tsx";
import { PHONE, useMedia } from "./shell/layout.ts";
import { editionDate, hhmm } from "./automationText.ts";
import "./inbox-reader.css";
import { intlLocale, t } from "./i18n/index.ts";

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
        ? <RunResult key={edition.runId} runId={edition.runId} run={edition.run} preview={edition.preview} morningBrief={edition.morningBrief} reading />
        : item.summary && <p className="inbox-summary"><Linked text={item.summary} /></p>}

      {proposal && (
        <>
          <div className="card">
            <p className="card-label">{proposal.stale ? t("inbox.stepsStale") : t("inbox.steps", { n: proposal.steps.length })}</p>
            <ol className="proposal-steps">{proposal.steps.map((step, n) => (
              <li key={n}><Linked text={step.preview} />{step.detail && <pre className="step-detail"><Linked text={step.detail} /></pre>}</li>
            ))}</ol>
          </div>
          {proposal.stale ? (
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
          <p className="quiet small">{t("inbox.expires", { date: new Date(proposal.expiresAt).toLocaleDateString(intlLocale(), { month: "long", day: "numeric" }) })}</p>
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
          <RunResult runId={edition.runId} run={edition.run} preview={edition.preview} morningBrief={edition.morningBrief} reading />
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

/** 通知: what needs you, and what Alfred wants you to know. A list on the left, the chosen item on the right. */
export function Inbox({ name, saveName, onEnter, state, focus, onFocused, onOpenConversation, line }: InboxProps & NamePreference & { onEnter?: () => void }) {
  const inbox = useRef<HTMLElement>(null);
  const returnTo = useRef<HTMLButtonElement | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const phone = useMedia(PHONE);
  const [roomForColumns, setRoomForColumns] = useState(false);
  // The navigation and assistant panels can resize this page without resizing the window.
  useLayoutEffect(() => {
    const element = inbox.current;
    if (!element) return;
    const measure = () => setRoomForColumns(element.clientWidth >= 740);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const welcoming = !!onEnter;
  const items = useMemo(() => inboxItems(state), [state]);
  const [filter, setFilter] = useState<InboxKind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    if (welcoming || !focus) return;
    setFilter("all");
    const target = items.find((item) => item.id === focus || item.alsoNotices?.some((notice) => `n:${notice.id}` === focus));
    if (target) setSelected(target.id);
    else { setSelected(null); setSaid(t("inbox.noLongerPending")); }
    onFocused();
  }, [welcoming, focus, items, onFocused]);
  useEffect(() => { if (!said) return; const timer = window.setTimeout(() => setSaid(null), 5000); return () => window.clearTimeout(timer); }, [said]);

  const activeFilter = items.some((item) => item.kind === filter) ? filter : "all";
  useEffect(() => { if (filter !== activeFilter) setFilter(activeFilter); }, [filter, activeFilter]);
  const shown = items.filter((item) => activeFilter === "all" || item.kind === activeFilter);
  const firstUpdate = shown.findIndex((item) => item.kind !== "decide");
  const grouped = activeFilter === "all" && firstUpdate > 0;
  const current = shown.find((item) => item.id === selected) ?? null;
  const onlyItem = items.length === 1 && !phone;
  const columns = roomForColumns && !phone && !onlyItem;
  const detail = current ?? (columns || onlyItem ? shown[0] : null);
  const titleOf = (id: string | null) => state.conversations.find((conversation) => conversation.id === id)?.title;
  const chips = [["all", t("common.all"), items.length] as const, ...KINDS.map(([kind, name]) => [kind, t(name), items.filter((item) => item.kind === kind).length] as const).filter(([, , count]) => count > 0)];

  return (
    <section ref={inbox} className="inbox" aria-label={t("inbox.label")}>
      {!welcoming && chips.length > 2 && (items.length > 5 || activeFilter !== "all") && (
        <div className="chips" role="group" aria-label={t("inbox.byKind")}>
          {chips.map(([id, name, count]) => (
            <button type="button" key={id} className="chip" aria-pressed={activeFilter === id} onClick={() => setFilter(id)}>
              {id !== "all" && <span className="mark" data-k={kindColour(id)} />}{name}<span className="count">{count}</span>
            </button>
          ))}
        </div>
      )}
      {!welcoming && said && <p className="inbox-said" role="status">{said}</p>}
      {welcoming || !items.length ? (
        <InboxEntry name={name} saveName={saveName} onEnter={onEnter} hasItems={items.length > 0} />
      ) : (
        <div className="split" data-columns={columns || undefined}>
          <ul className="inbox-list" hidden={!!detail && !columns}>
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
          {detail && (
            <div className="inbox-pane" key={detail.id}>
              {!columns && !onlyItem && <button type="button" ref={back} className="back link" onClick={() => {
                setSelected(null);
                requestAnimationFrame(() => returnTo.current?.focus());
              }}>{t("inbox.back")}</button>}
              <Detail item={detail} mail={state.modules.mail as MailSnapshot | undefined} conversationTitle={titleOf(detail.conversationId) ?? undefined} onOpenConversation={onOpenConversation} line={line}
                onDone={(message) => { setSelected(null); if (message) setSaid(message); }} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
