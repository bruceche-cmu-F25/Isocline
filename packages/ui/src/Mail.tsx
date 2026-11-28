/** The mail page: the Gmail inbox's last two weeks, read one message at a time, and answered from here.
 *
 * Under an open mail: draft a reply (Zirma writes one), reply in a line (a few words in the bar under the page, and
 * Zirma writes it out), or write it yourself. A draft is shown where it will go, under the mail it answers, and its
 * text can be changed by hand before it is sent. Zirma's drafts are proposals (they wait on the home node, and show
 * in 通知 too); a draft the user wrote, or took over by editing Zirma's, is kept on this device until it is sent.
 * Nothing goes out without a press on 发送: Zirma's as it stands is the proposal accepted, anything else is the
 * user's own `mail.send`.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Proposal, Run, StateResponse } from "@zirma/protocol";
import type { MailCategory, MailDetail, MailMessage, MailSent, MailSnapshot, SendInput } from "@zirma/module-mail/types";
import { api, newRequestId } from "./api.ts";
import { NewMail } from "./NewMail.tsx";
import { outcomeText } from "./Inbox.tsx";
import { Linked, OutLink } from "./Linked.tsx";
import { SourceBar } from "./SourceBar.tsx";
import { Icon, type IconName } from "./shell/icons.tsx";
import "./side-tree.css";
import { Select } from "./shell/Select.tsx";
import { PHONE, useMedia } from "./shell/layout.ts";
import { useRowSwipe } from "./swipe.ts";
import type { PageLine, Picked } from "./shell/about.ts";
import { MicButton } from "./voice/MicButton.tsx";
import { appendDictation } from "./voice/wav.ts";
import { intlLocale, t, type Key, getAssistant } from "./i18n/index.ts";

type Filter = "inbox" | "unread" | "favorites" | "important" | "drafts";
type CategoryFilter = "all" | MailCategory;
const FILTERS: Array<[Filter, Key]> = [
  ["inbox", "mail.inbox"], ["unread", "mail.unread"],
  ["favorites", "mail.favorites"], ["important", "mail.important"], ["drafts", "mail.drafts"],
];

/** The places in the sidebar (workspace-architecture.md §6, a page's own sidebar). */
const FILTER_ICONS: Record<Filter, IconName> = { inbox: "inbox", unread: "mail", favorites: "star", important: "flag", drafts: "write" };

const CATEGORIES: Array<[CategoryFilter, Key]> = [
  ["all", "mail.allCategories"], ["primary", "mail.primary"], ["social", "mail.social"],
  ["promotions", "mail.promotions"], ["updates", "mail.updates"], ["forums", "mail.forums"],
];

/** Size the trigger to its current label. The menu displays all choices and counts. */
function PhoneMailSelect<T extends string>({ label, options, value, onChange, count }: {
  label: string; options: Array<[T, Key]>; value: T; onChange(value: T): void; count?(value: T): number;
}) {
  const selected = options.find(([id]) => id === value)!;
  return <span className="mail-phone-select">
    <span aria-hidden="true">{t(value === "all" ? "common.all" : selected[1])}</span><Icon name="down" />
    <Select cover label={label} value={value} onChange={(next) => onChange(next as T)}
      options={options.map(([id, key]) => ({ value: id, label: count ? `${t(key)} · ${count(id)}` : t(key) }))} />
  </span>;
}

// Open the inbox on Primary. Status views span categories until the user explicitly chooses one.
function categoryFor(filter: Filter, selected: CategoryFilter | null): CategoryFilter {
  return selected ?? (filter === "inbox" ? "primary" : "all");
}

const isFavorite = (message: MailMessage) => message.starred || !!message.localSaved;
function matchesFilter(message: MailMessage, filter: Filter, selected: CategoryFilter | null) {
  const category = categoryFor(filter, selected);
  if (category !== "all" && message.category !== category) return false;
  if (filter === "favorites") return isFavorite(message);
  if (filter === "important") return message.important;
  if (filter === "drafts" || message.inInbox === false) return false;
  return filter === "inbox" || message.unread;
}

interface FavoriteProps {
  message: MailMessage;
  canModify: boolean;
  pending: boolean;
  onChange(message: MailMessage, starred: boolean): void;
}

/** A read-only Gmail star can be seen here; changing it needs the account's star-sync permission. */
function FavoriteButton({ message, canModify, pending, onChange, compact = false }: FavoriteProps & { compact?: boolean }) {
  const active = isFavorite(message);
  const locked = message.starred && !canModify;
  const label = locked ? t("mail.favorite.gmailOn")
    : active ? t(message.starred ? "mail.favorite.removeGmail" : "mail.favorite.removeLocal")
    : t(canModify ? "mail.favorite.addGmail" : "mail.favorite.addLocal");
  const title = compact ? `${label} · ${message.subject}` : label;
  return <button type="button" className={`mail-message-action${compact ? " compact" : ""}`} aria-pressed={active}
    disabled={pending || locked} title={title} aria-label={title} onClick={() => onChange(message, !active)}>
    <Icon name="star" />{!compact && label}
  </button>;
}

interface ArchiveProps {
  message: MailMessage;
  canModify: boolean;
  pending: boolean;
  onArchive(message: MailMessage): unknown;
}

/** A message in the list. On a phone a finger swipes it leftwards to archive it (swipe.ts); where an archived
 * message stays in view (Favorites, Important) it slides back once archived, without its archive button. */
function MailEntry({ swipe, leaves, onArchive, children }: { swipe: boolean; leaves: boolean; onArchive(): Promise<boolean>; children: ReactNode }) {
  const row = useRowSwipe(swipe, async () => { if (!(await onArchive()) || !leaves) row.reset(); });
  return (
    <li className="mail-list-entry" data-swipe={swipe || undefined} data-armed={row.armed || undefined} data-gone={row.gone || undefined} {...(swipe ? row.handlers : {})}>
      {swipe && <span className="mail-swipe-under" data-k="green" aria-hidden="true"><Icon name="archive" />{t("mail.archive")}</span>}
      <div className="mail-list-face" data-dragging={row.dragging || undefined} style={row.offset ? { transform: `translateX(${row.offset}px)` } : undefined}>{children}</div>
    </li>
  );
}

function ArchiveButton({ message, canModify, pending, onArchive, compact = false }: ArchiveProps & { compact?: boolean }) {
  if (message.inInbox === false) return null;
  const label = t("mail.archive");
  const hint = canModify ? label : t("mail.favorite.enable");
  const title = compact ? `${hint} · ${message.subject}` : hint;
  return <button type="button" className={`mail-message-action${compact ? " compact" : ""}`}
    disabled={!canModify || pending} title={title} aria-label={compact ? `${label} · ${message.subject}` : label}
    onClick={() => onArchive(message)}>
    <Icon name="archive" />{!compact && label}
  </button>;
}

const VIEW = "mail.inbox";
/** What a run asked for a new email (not a reply) has picked. */
const COMPOSE = "compose";
const GOING = new Set<Run["state"]>(["queued", "running", "cancelling"]);

/** A draft: Zirma's (a step of an open proposal) or the user's own (kept on this device). */
type Draft =
  | { kind: "alfred"; key: string; input: SendInput; at: string; proposal: Proposal; index: number }
  | ({ kind: "own" } & OwnDraft);
interface OwnDraft { key: string; input: SendInput; at: string; requestId?: string }

const messageKey = (message: Pick<MailMessage, "account" | "id">) => `${message.account}|${message.id}`;
const pickedOf = (message: MailMessage): Picked => ({ id: message.id, title: `${message.from}: ${message.subject}`.slice(0, 200) });
const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Today's mail by its time, older mail by its date. */
function when(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(intlLocale(), { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

const OWN_KEY = "zirma.mail.drafts";
function readOwn(): OwnDraft[] {
  try {
    const kept = JSON.parse(localStorage.getItem(OWN_KEY) ?? "[]") as unknown;
    return Array.isArray(kept) ? kept.filter((draft): draft is OwnDraft => !!draft && typeof draft.key === "string" && Array.isArray(draft.input?.to) && typeof draft.input.body === "string") : [];
  } catch { return []; }
}
/** The user's own drafts, kept on this device so a reload or a failed send does not lose the words. */
function useOwnDrafts() {
  const [own, setOwn] = useState<OwnDraft[]>(readOwn);
  const change = useCallback((next: (now: OwnDraft[]) => OwnDraft[]) => setOwn((now) => {
    const made = next(now);
    try { localStorage.setItem(OWN_KEY, JSON.stringify(made)); } catch { /* private mode: kept while the page is open */ }
    return made;
  }), []);
  const put = useCallback((draft: OwnDraft) => change((now) => [...now.filter((other) => other.key !== draft.key), draft]), [change]);
  const drop = useCallback((key: string) => change((now) => now.filter((other) => other.key !== key)), [change]);
  return { own, put, drop };
}

interface Acts {
  send(draft: Draft, body: string): Promise<void>;
  discard(draft: Draft): Promise<void>;
  /** Puts the draft in the bar under the page: the next words there are what to change. */
  change(draft: Draft, body: string): void;
  /** The user's own draft as they type it. */
  keep(draft: Draft, body: string): void;
}

/** One draft, where it will go: who it is for, its text (changed by hand, if it is the only thing to decide), and
 * send, change, or not. */
function DraftCard({ draft, acts, changing, heading, written, onWritten }: {
  draft: Draft; acts: Acts; changing: boolean; heading?: boolean;
  /** Zirma has just written it: its text is written out in front of the user, once. */
  written?: boolean;
  onWritten?(): void;
}) {
  const { input } = draft;
  const others = draft.kind === "alfred" ? draft.proposal.steps.filter((_, index) => index !== draft.index) : [];
  const stale = draft.kind === "alfred" && !!draft.proposal.stale;
  // A proposal with more steps is accepted as it was shown; its words change through Zirma.
  const editable = others.length === 0 && !stale;
  const [text, setText] = useState(input.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [shown, writing, finish] = useWritten(input.body, !!written);
  useEffect(() => {
    // A draft the user just started is theirs to type in.
    if (draft.kind === "own" && !input.body) field.current?.focus();
  }, []);
  // A draft being written under the mail is kept in sight as it grows; once written it is the user's to change.
  useEffect(() => {
    if (!written) return;
    root.current?.scrollIntoView({ block: "nearest", behavior: writing ? "smooth" : "auto" });
    if (!writing) onWritten?.();
  }, [writing]);
  const act = (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    action().catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  };
  const write = (next: string) => { setText(next); if (draft.kind === "own") acts.keep(draft, next); };
  return (
    <section className="mail-draft" ref={root} data-own={draft.kind === "own" || undefined} data-on={changing || undefined} aria-label={t(draft.kind === "own" ? "mail.draft.own" : "mail.draft.alfred")}>
      <p className="mail-draft-head">
        <b>{t(draft.kind === "own" ? "mail.draft.own" : "mail.draft.alfred")}</b>
        <span>{t("mail.to")} {input.to.join(", ")}{input.cc.length > 0 && ` · ${t("mail.cc")} ${input.cc.join(", ")}`}</span>
      </p>
      {heading && <p className="mail-draft-subject">{input.subject || t("mail.nosubject")}</p>}
      {writing ? (
        <p className="mail-draft-typing" aria-live="off" onClick={finish}>{shown}<i className="mail-caret" aria-hidden="true" /></p>
      ) : editable ? (
        <span className="with-mic">
          <textarea ref={field} value={text} onChange={(event) => write(event.target.value)} rows={Math.min(14, Math.max(3, text.split("\n").length + 1))} maxLength={20_000}
            placeholder={t("mail.own.placeholder")} aria-label={t("mail.draft.text")} disabled={busy} />
          <MicButton className="small" disabled={busy} onText={(words) => write(appendDictation(text, words))} />
        </span>
      ) : <p className="mail-draft-text">{input.body}</p>}
      {others.length > 0 && <ul className="mail-draft-also">{others.map((step, n) => <li key={n}>{step.preview}</li>)}</ul>}
      {stale && <p className="problem small">{t("inbox.staleWarn")}</p>}
      <div className="inbox-actions">
        {!stale && (
          <button type="button" disabled={busy || writing || !text.trim()} onClick={() => act(() => acts.send(draft, text))}>
            {others.length ? t("inbox.acceptN", { n: others.length + 1 }) : t("mail.send")}
          </button>
        )}
        <button type="button" className="ghost" disabled={busy || writing || !text.trim()} aria-pressed={changing} onClick={() => acts.change(draft, text)}>{t("mail.change")}</button>
        <button type="button" className="ghost" disabled={busy || writing} onClick={() => act(() => acts.discard(draft))}>{t("mail.discard")}</button>
      </div>
      {error && <p className="problem small" role="alert">{error}</p>}
    </section>
  );
}

/** A text written out as if by hand, when `on`: what is written so far, whether it is still going, and a way to
 * have the rest at once (a click). It takes one to two and a half seconds whatever the length, and none at all for
 * someone who asked for less motion. */
function useWritten(text: string, on: boolean): [string, boolean, () => void] {
  const chars = useMemo(() => Array.from(text), [text]);
  /** How much is written so far; null once it all is (and from the start, when it is not written out at all). */
  const [count, setCount] = useState<number | null>(() => (on && chars.length > 0 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : null));
  useEffect(() => {
    if (count === null) return;
    const total = Math.min(2400, Math.max(900, chars.length * 24));
    const began = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const next = Math.ceil(((now - began) / total) * chars.length);
      if (next >= chars.length) { setCount(null); return; }
      setCount((had) => (had === null ? null : Math.max(had, next)));
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const finish = useCallback(() => setCount(null), []);
  return [count === null ? text : chars.slice(0, count).join(""), count !== null, finish];
}

/** Zirma is writing: the draft's card is already where it will be, with lines being written in it. */
function Writing({ to }: { to?: string }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, []);
  return (
    <section className="mail-draft" data-writing ref={root} role="status">
      <p className="mail-draft-head"><b className="working-label">{t("mail.writing")}</b>{to && <span>{t("mail.to")} {to}</span>}</p>
      <div className="mail-draft-lines" aria-hidden="true"><i /><i /><i /></div>
    </section>
  );
}

/** A reply that was sent from here, or is on its way, under the mail it answers. */
function SentCard({ sent, onAgain }: { sent: MailSent; onAgain?(): void }) {
  const label = sent.state === "done" ? `${t("mail.sent.done")} · ${when(sent.at)}`
    : sent.state === "failed" ? `${t("mail.sent.failed")}${sent.error ? `：${sent.error}` : ""}`
    : sent.state === "unknown" ? t("mail.sent.unknown") : t("mail.sent.going");
  return (
    <section className="mail-sent" data-state={sent.state}>
      <p className="mail-draft-head"><b>{label}</b></p>
      <p className="mail-draft-text">{sent.body}</p>
      {sent.state === "failed" && onAgain && <div className="inbox-actions"><button type="button" className="ghost" onClick={onAgain}>{t("mail.sent.again")}</button></div>}
    </section>
  );
}

interface ReaderProps {
  message: MailMessage;
  draft: Draft | undefined;
  writing: boolean;
  sent: MailSent[];
  canSend: boolean;
  favorite: FavoriteProps;
  archive: ArchiveProps;
  /** Whether new mail from this sender is told (Settings → Reminders), and how to change that. */
  watch: WatchProps;
  line: PageLine;
  acts: Acts;
  /** The draft has just come from Zirma, and has not been written out yet. */
  written: boolean;
  onWritten(): void;
  /** Asks Zirma for a reply to this mail; `words` is what it should say, if the user gave any. */
  onDraft(words?: string): Promise<void>;
  /** Starts the user's own reply, empty or with the text of one that did not go out. */
  onOwn(body?: string): void;
  onBack(): void;
}

function MailBack({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="mail-back small" onClick={onBack}>
      <Icon name="back" />{t("mail.back")}
    </button>
  );
}

interface WatchProps { watching: boolean; pending: boolean; onChange(on: boolean): void }

/** "Remind me when they write": the sender joins the reminders' list (docs/design/reminders.md §5). */
function WatchButton({ watching, pending, onChange }: WatchProps) {
  return watching
    ? <button type="button" className="ghost small mail-watch" aria-pressed="true" disabled={pending} title={t("rem.mail.unwatch")} onClick={() => onChange(false)}><Icon name="check" />{t("rem.mail.watching")}</button>
    : <button type="button" className="ghost small mail-watch" aria-pressed="false" disabled={pending} onClick={() => onChange(true)}>{t("rem.mail.watch")}</button>;
}

function Reader({ message, draft, writing, sent, canSend, favorite, archive, watch, line, acts, written, onWritten, onDraft, onOwn, onBack }: ReaderProps) {
  const [detail, setDetail] = useState<MailDetail | "loading" | "gone">("loading");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setDetail("loading");
    api.query<MailDetail | { error: string }>("mail.message", { id: message.id, account: message.account })
      .then((result) => { if (alive) setDetail("error" in result ? "gone" : result); })
      .catch(() => { if (alive) setDetail("gone"); });
    return () => { alive = false; };
  }, [message.id, message.account]);
  useEffect(() => {
    if (typeof detail !== "object" || !detail.unread) return;
    const markRead = () => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", markRead);
      void api.op("mail.mark_read", { account: detail.account, id: detail.id }).catch((reason: Error) => setError(reason.message));
    };
    document.addEventListener("visibilitychange", markRead);
    markRead();
    return () => document.removeEventListener("visibilitychange", markRead);
  }, [detail]);
  const replyKey = `mail:reply:${messageKey(message)}`;
  const start = (words?: string) => { setError(null); return onDraft(words).catch((reason: Error) => { setError(reason.message); throw reason; }); };
  const inLine = () => line.attach(line.about === replyKey ? null : {
    key: replyKey, label: t("mail.reply.about", { who: short(message.from, 24) }), placeholder: t("mail.reply.placeholder"),
    chips: [t("mail.chip.yes"), t("mail.chip.no"), t("mail.chip.thanks")],
    send: (words) => start(words),
  });
  return (
    <article className="mail-read" aria-label={message.subject}>
      <MailBack onBack={onBack} />
      <h2>{message.subject}</h2>
      <p className="mail-from"><b>{message.from}</b>{message.from !== message.fromEmail && <span className="quiet"> &lt;{message.fromEmail}&gt;</span>}</p>
      <p className="quiet small">
        {new Date(message.receivedAt).toLocaleString(intlLocale(), { dateStyle: "medium", timeStyle: "short" })}
        {typeof detail === "object" && detail.to && ` · ${t("mail.to")} ${detail.to}`}
      </p>
      <div className="mail-message-actions">
        <FavoriteButton {...favorite} />
        <ArchiveButton {...archive} />
        <WatchButton {...watch} />
        {message.localSaved && !message.starred && favorite.canModify &&
          <button type="button" className="ghost small" disabled={favorite.pending} onClick={() => favorite.onChange(message, true)}>{t("mail.favorite.sync")}</button>}
        {!favorite.canModify && <a className="small" href="#p=core.settings">{t("mail.favorite.enable")}</a>}
      </div>
      {detail === "loading" && <p className="quiet">{t("mail.loading")}</p>}
      {detail === "gone" && <p className="quiet">{t("mail.gone")}</p>}
      {typeof detail === "object" && (
        <>
          <div className="mail-body"><Linked text={detail.body || detail.snippet} /></div>
          {detail.attachments.length > 0 && <p className="quiet small">{t("mail.attachments", { names: detail.attachments.join(", ") })}</p>}
          {detail.bodyIncomplete && <p className="quiet small">{t("mail.incomplete")}</p>}
        </>
      )}
      {sent.map((one) => <SentCard key={one.id} sent={one} onAgain={!draft && canSend ? () => onOwn(one.body) : undefined} />)}
      {draft ? <DraftCard key={draft.key} draft={draft} acts={acts} changing={line.about === `mail:change:${draft.key}`} written={written} onWritten={onWritten} />
        : writing ? <Writing to={message.fromEmail} />
        : (
          <div className="mail-reply">
            <div className="inbox-actions">
              {/* Once answered, another reply is possible but no longer the thing to do. */}
              <button type="button" className={sent.some((one) => one.state === "done") ? "ghost" : undefined} onClick={() => { void start().catch(() => {}); }}>{t("mail.reply.draft")}</button>
              <button type="button" className="ghost" aria-pressed={line.about === replyKey} onClick={inLine}>{t("mail.reply.line")}</button>
              {canSend && <button type="button" className="ghost" onClick={() => onOwn()}>{t("mail.reply.own")}</button>}
            </div>
            {!canSend && <p className="quiet small"><a href="#p=core.settings">{t("mail.nosend")}</a></p>}
            {error && <p className="problem small" role="alert">{error}</p>}
          </div>
        )}
      <p><OutLink href={message.link}>{t("mail.open")}</OutLink></p>
    </article>
  );
}

export function Mail({ snapshot, state, line, focus, onFocused, refresh, side }: {
  snapshot: MailSnapshot | undefined; state: StateResponse; line: PageLine;
  refresh(): void;
  /** The app sidebar's slot while it has room (PageDef.side): the places go there, as Notes' tree does. */
  side?: HTMLElement | null;
  /** A letter to open (`<account>|<id>`), asked for from another page. */
  focus?: string | null; onFocused?(): void;
}) {
  const phone = useMedia(PHONE);
  const moreId = useId();
  const [filter, setFilter] = useState<Filter>("inbox");
  const [category, setCategory] = useState<CategoryFilter | null>(null);
  /** `<account>|<id>` for a message; `d:<draft key>` for a draft with no message here (`d:new` while one is written). */
  const [picked, setPicked] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [savingFavorites, setSavingFavorites] = useState<string[]>([]);
  const [archiving, setArchiving] = useState<string[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Runs asked from here, by what they are about (a message's key, or COMPOSE), until the state has caught up. */
  const [follow, setFollow] = useState<Record<string, { run: string; at: number }>>({});
  const { own, put, drop } = useOwnDrafts();
  const [sending, setSending] = useState<string[]>([]);
  const messages = snapshot?.messages ?? [];
  const sources = snapshot?.sources ?? [];
  useEffect(() => {
    if (!focus) return;
    const asked = messages.find((message) => messageKey(message) === focus);
    if (asked) {
      if (!matchesFilter(asked, filter, category)) {
        const view = asked.inInbox !== false ? "inbox" : isFavorite(asked) ? "favorites" : "important";
        setFilter(view);
        setCategory(asked.inInbox !== false ? asked.category : "all");
      }
      setPicked(messageKey(asked));
    }
    onFocused?.();
  }, [focus]);
  const senders = sources.filter((source) => source.canSend).map((source) => source.account);
  const sentMail = snapshot?.sent ?? [];
  const lineNow = useRef(line);
  lineNow.current = line;

  const runs = state.runs;
  const drafts = useMemo<Draft[]>(() => [
    // One being rewritten is not offered: the page shows the new version being written in its place.
    ...(state.proposals ?? []).filter((proposal) => !proposal.revising).flatMap((proposal) => proposal.steps.flatMap((step, index): Draft[] => (step.op === "mail.send"
      ? [{ kind: "alfred", key: `${proposal.id}:${index}`, input: step.input as SendInput, at: proposal.createdAt, proposal, index }] : []))),
    ...own.map((draft): Draft => ({ kind: "own", ...draft })),
  ], [state.proposals, own]);

  // Zirma's drafts that turned up while the page was open are written out when first shown, once. Those that
  // were already waiting when it opened are simply there.
  const known = useRef<Set<string> | null>(null);
  const fresh = useRef(new Set<string>());
  for (const draft of drafts) if (draft.kind === "alfred" && known.current && !known.current.has(draft.key)) fresh.current.add(draft.key);
  known.current = new Set(drafts.map((draft) => draft.key));
  const shownWritten = (draft: Draft | undefined) => ({ written: !!draft && fresh.current.has(draft.key), onWritten: () => { if (draft) fresh.current.delete(draft.key); } });

  /** The message a draft answers: the one it replies to, or the one picked when Zirma was asked for it. */
  const answers = useCallback((draft: Draft): string | null => {
    if (draft.input.replyTo) return `${draft.input.account}|${draft.input.replyTo.id}`;
    if (draft.kind !== "alfred") return null;
    const asked = runs.find((run) => run.id === draft.proposal.runId)?.context;
    return asked?.view === VIEW && asked.selection && asked.selection.id !== COMPOSE ? `${draft.input.account}|${asked.selection.id}` : null;
  }, [runs]);
  // Zirma's newest draft for a message comes before the user's own.
  const draftFor = (key: string) => drafts.filter((draft) => answers(draft) === key).sort((a, b) => (a.kind === b.kind ? b.at.localeCompare(a.at) : a.kind === "alfred" ? -1 : 1))[0];
  const isWriting = (thing: string, selection: string) => {
    const followed = follow[thing];
    if (followed) {
      const run = runs.find((candidate) => candidate.id === followed.run);
      if (run ? GOING.has(run.state) : Date.now() - followed.at < 15_000) return true;
    }
    return runs.some((run) => GOING.has(run.state) && run.context?.view === VIEW && run.context.selection?.id === selection);
  };
  const following = (thing: string) => (runId: string | null) => { if (runId) setFollow((now) => ({ ...now, [thing]: { run: runId, at: Date.now() } })); };

  const activeCategory = categoryFor(filter, category);
  function chooseCategory(next: CategoryFilter) {
    setCategory(next);
    setPicked(null);
  }

  const shown = messages.filter((message) => matchesFilter(message, filter, category));
  const count = (which: Filter) => which === "drafts" ? drafts.length : messages.filter((message) => matchesFilter(message, which, category)).length;
  const open = messages.find((message) => messageKey(message) === picked);
  // Keep a retained favorite open in Favorites. A refreshed inbox should close a message
  // that has left it, even if another device archived it while this reader was open.
  useEffect(() => {
    if (!snapshot || !picked || picked.startsWith("d:")) return;
    if (!open || (open.inInbox === false && (filter === "inbox" || filter === "unread"))) {
      setPicked((current) => current === picked ? null : current);
    }
  }, [snapshot, picked, open, filter]);
  const openDraft = picked?.startsWith("d:") ? drafts.find((draft) => `d:${draft.key}` === picked) : undefined;
  const ownCompose = openDraft?.kind === "own" && openDraft.key.startsWith("compose:");
  const composing = isWriting(COMPOSE, COMPOSE);

  // A draft that is not under a message (a new email) is followed by the run that writes it: the pane waits while
  // Zirma writes, then shows what it made; a new version takes the place of the one it changed.
  const composeRun = follow[COMPOSE]?.run;
  useEffect(() => {
    if (!picked?.startsWith("d:") || openDraft || composing) return;
    const made = drafts.find((draft) => draft.kind === "alfred" && draft.proposal.runId === composeRun);
    const under = made && answers(made);
    setPicked(made ? (under && messages.some((message) => messageKey(message) === under) ? under : `d:${made.key}`) : null);
  }, [picked, openDraft, composing, composeRun, drafts]);
  // Another mail, or none: the words in the bar were about the one before.
  useEffect(() => {
    const about = lineNow.current.about;
    if (about?.startsWith("mail:") && about !== "mail:compose") lineNow.current.attach(null);
  }, [picked]);
  useEffect(() => { if (!said) return; const timer = window.setTimeout(() => setSaid(null), 5000); return () => window.clearTimeout(timer); }, [said]);

  const changeFavorite = async (message: MailMessage, starred: boolean) => {
    const key = messageKey(message);
    if (savingFavorites.includes(key)) return;
    setSavingFavorites((keys) => [...keys, key]);
    setActionError(null);
    setSaid(null);
    try {
      // Gmail's half goes out after this answers; if Gmail refuses it, Zirma says so in a notice.
      const saved = (await api.op("mail.favorite", { account: message.account, id: message.id, starred })).result as { starred: boolean; scope: "gmail" | "local" };
      refresh();
      setSaid(saved.scope === "gmail"
        ? t(saved.starred ? "mail.favorite.gmailOn" : "mail.favorite.gmailOff")
        : t(saved.starred ? "mail.favorite.localOn" : "mail.favorite.localOff"));
    } catch (reason) {
      setActionError(t("mail.favorite.failed", { subject: message.subject, error: (reason as Error).message }));
    } finally {
      setSavingFavorites((keys) => keys.filter((saving) => saving !== key));
    }
  };
  const canModify = (message: MailMessage) => sources.some((source) => source.account === message.account && source.canModify);
  const favoriteProps = (message: MailMessage): FavoriteProps => ({
    message, canModify: canModify(message),
    pending: savingFavorites.includes(messageKey(message)), onChange: changeFavorite,
  });

  /** Whether it went: a swiped row that did not comes back. */
  const archive = async (message: MailMessage): Promise<boolean> => {
    const key = messageKey(message);
    if (archiving.includes(key)) return false;
    setArchiving((keys) => [...keys, key]);
    setActionError(null);
    setSaid(null);
    try {
      const { result } = await api.op("mail.archive", { account: message.account, id: message.id });
      const { queued } = result as { queued: string | null };
      setSaid(t(queued ? "mail.archive.queued" : "mail.archive.already", { subject: message.subject }));
      return true;
    } catch (reason) {
      setActionError(t("mail.archive.failed", { subject: message.subject, error: (reason as Error).message }));
      return false;
    } finally {
      refresh();
      setArchiving((keys) => keys.filter((saving) => saving !== key));
    }
  };
  const archiveProps = (message: MailMessage): ArchiveProps => ({
    message, canModify: canModify(message), pending: archiving.includes(messageKey(message)), onArchive: archive,
  });
  // Reminders of new mail from a sender: the list lives in the settings, so every device shows the same.
  const [watchPending, setWatchPending] = useState(false);
  const watchProps = (message: MailMessage): WatchProps => {
    const senders = state.settings.reminders?.mail.senders ?? [];
    const address = message.fromEmail.toLowerCase();
    return {
      watching: senders.includes(address), pending: watchPending,
      onChange: (on) => {
        setWatchPending(true);
        setActionError(null);
        api.settings({ reminders: { mail: { senders: on ? [...senders, address] : senders.filter((known) => known !== address) } } })
          .catch((reason: Error) => setActionError(reason.message))
          .finally(() => setWatchPending(false));
      },
    };
  };

  const thingOf = (draft: Draft) => answers(draft) ?? COMPOSE;
  const pickedFor = (draft: Draft): Picked => {
    const message = messages.find((candidate) => messageKey(candidate) === answers(draft));
    return message ? pickedOf(message) : { id: COMPOSE, title: t("mail.compose.about") };
  };
  const sendOwn = async (draft: OwnDraft) => {
    const { result } = await api.op("mail.send", draft.input, draft.requestId);
    const refused = (result as { error?: unknown } | null)?.error;
    if (typeof refused === "string") throw new Error(refused);
    drop(draft.key);
    if (!draft.input.replyTo) setSaid(t("mail.sent.queued"));
  };
  const acts: Acts = {
    async send(draft, text) {
      const body = text.trim();
      if (draft.kind === "own") return sendOwn({ key: draft.key, at: draft.at, input: { ...draft.input, body } });
      if (body === draft.input.body.trim()) {
        const { proposal } = await api.accept(draft.proposal.id);
        if (proposal.state !== "executed") throw new Error(outcomeText(proposal));
        if (!draft.input.replyTo) setSaid(t("mail.sent.queued"));
        return;
      }
      // The user's own wording: Zirma's version gives way, and theirs goes as their own. It is kept here first, so
      // a send that fails leaves it to try again.
      const mine: OwnDraft = { key: answers(draft) ?? `new:${Date.now()}`, at: new Date().toISOString(), input: { ...draft.input, body } };
      put(mine);
      if (!answers(draft)) setPicked(`d:${mine.key}`);
      await api.decline(draft.proposal.id);
      await sendOwn(mine);
    },
    async discard(draft) {
      if (draft.kind === "own") drop(draft.key);
      else await api.decline(draft.proposal.id);
    },
    change(draft, text) {
      const key = `mail:change:${draft.key}`;
      if (line.about === key) { line.attach(null); return; }
      const body = text.trim(), thing = thingOf(draft), about = pickedFor(draft);
      line.attach({
        key, label: t("mail.change.about"), placeholder: t("mail.change.placeholder"),
        chips: [t("mail.chip.shorter"), t("mail.chip.warmer"), t("mail.chip.direct")],
        async send(words) {
          if (draft.kind === "alfred") {
            // What the user already changed by hand is where the new version starts.
            const edited = body !== draft.input.body.trim();
            following(thing)(await line.revise(draft.proposal.id, edited ? `${words}\n${t("mail.change.mine")}\n${body}` : words, about));
          } else {
            following(thing)(await line.ask(t("mail.goal.rework", { to: draft.input.to.join(", "), subject: short(draft.input.subject, 80), text: words, draft: body }), about));
            drop(draft.key);
          }
          if (thing === COMPOSE) setPicked("d:new");
        },
      });
    },
    keep(draft, body) { if (draft.kind === "own") put({ key: draft.key, at: draft.at, input: { ...draft.input, body } }); },
  };

  const draftReply = (message: MailMessage) => async (words?: string) => {
    const names = { who: message.from, subject: short(message.subject, 80) };
    following(messageKey(message))(await line.ask(words ? t("mail.goal.reply", { ...names, text: words }) : t("mail.goal.draft", names), pickedOf(message)));
  };
  const ownReply = (message: MailMessage) => (body = "") => put({
    key: messageKey(message), at: new Date().toISOString(),
    input: {
      account: message.account, to: [message.fromEmail.trim().toLowerCase()], cc: [], body,
      subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`, replyTo: { id: message.id, threadId: message.threadId },
    },
  });
  const startNew = () => {
    line.attach(null);
    const blank = own.find(({ key, input }) => key.startsWith("compose:") && !input.to.some(Boolean) && !input.cc.some(Boolean) && !input.subject && !input.body);
    const key = blank?.key ?? `compose:${newRequestId()}`;
    if (!blank) put({ key, at: new Date().toISOString(), input: { account: senders[0] ?? "", to: [], cc: [], subject: "", body: "" } });
    setFilter("drafts");
    setPicked(`d:${key}`);
  };
  const sendNew = async (draft: OwnDraft, input: SendInput) => {
    if (sending.includes(draft.key)) return;
    const requestId = draft.requestId ?? newRequestId();
    // Keep the receipt key with the draft so retrying after a lost response cannot send it twice.
    put({ key: draft.key, at: draft.at, input: { ...draft.input, account: input.account }, requestId });
    setSending((keys) => [...keys, draft.key]);
    try {
      await sendOwn({ ...draft, input, requestId });
      setPicked((current) => current === `d:${draft.key}` ? null : current);
    } finally {
      setSending((keys) => keys.filter((key) => key !== draft.key));
    }
  };
  const compose = () => line.attach(line.about === "mail:compose" ? null : {
    key: "mail:compose", label: t("mail.compose.about"), placeholder: t("mail.compose.placeholder"),
    async send(words) {
      following(COMPOSE)(await line.ask(t("mail.goal.compose", { text: words }), { id: COMPOSE, title: t("mail.compose.about") }));
      setFilter("drafts");
      setPicked("d:new");
    },
  });

  const replied = new Set(sentMail.filter((sent) => sent.replyTo && sent.state === "done").map((sent) => `${sent.account}|${sent.replyTo}`));
  const pane = open ? (
    <Reader key={picked} message={open} draft={draftFor(messageKey(open))} writing={isWriting(messageKey(open), open.id)}
      favorite={favoriteProps(open)} archive={archiveProps(open)} watch={watchProps(open)}
      sent={sentMail.filter((sent) => sent.replyTo === open.id && sent.account === open.account)}
      canSend={sources.find((source) => source.account === open.account)?.canSend ?? false}
      line={line} acts={acts} {...shownWritten(draftFor(messageKey(open)))} onDraft={draftReply(open)} onOwn={ownReply(open)} onBack={() => setPicked(null)} />
  ) : openDraft ? (
    <article className="mail-read" aria-label={openDraft.input.subject || t("mail.compose.about")}>
      {!ownCompose && <MailBack onBack={() => setPicked(null)} />}
      {ownCompose ? (
        <NewMail key={openDraft.key} input={openDraft.input} accounts={senders} busy={sending.includes(openDraft.key)} onBack={() => setPicked(null)}
          onChange={(input) => put({ key: openDraft.key, at: openDraft.at, input })}
          onDiscard={() => { drop(openDraft.key); setPicked(null); }}
          onSend={(input) => sendNew(openDraft, input)} />
      ) : <DraftCard key={openDraft.key} draft={openDraft} acts={acts} changing={line.about === `mail:change:${openDraft.key}`} heading {...shownWritten(openDraft)} />}
    </article>
  ) : picked?.startsWith("d:") && composing ? (
    <article className="mail-read">
      <MailBack onBack={() => setPicked(null)} />
      <Writing />
    </article>
  ) : <p className="mail-read quiet mail-pick">{t("mail.pick")}</p>;

  const hasViews = sources.length > 0 || drafts.length > 0 || composing;
  const needsConnection = !sources.length || sources.some((source) => source.error);
  const sourceBar = <SourceBar module="mail" mark="gmail" sources={sources} notConnected={t("src.notConnected.mail")} />;
  const chooseView = (view: Filter) => { setFilter(view); setPicked(null); };
  // In the sidebar: a new letter on top, then the places with their counts (workspace-architecture.md §6).
  const inSide = !!side && !phone;
  const sideNav = inSide && createPortal(
    <nav className="st-list" aria-label={t("mail.filters")}>
      <button type="button" className="st-node" onClick={startNew}><span className="st-space" /><Icon name="plus" /><span className="st-name">{t("mail.new")}</span></button>
      {hasViews && FILTERS.map(([id, label]) => (
        <button type="button" key={id} className="st-node" aria-current={filter === id ? "true" : undefined} onClick={() => chooseView(id)}>
          <span className="st-space" /><Icon name={FILTER_ICONS[id]} /><span className="st-name">{t(label)}</span><span className="st-count">{count(id) || ""}</span>
        </button>
      ))}
    </nav>,
    side,
  );

  return (
    <section className="mail" data-composing={ownCompose || undefined} data-side={inSide || undefined} aria-label={t("page.mail")}>
      {sideNav}
      {phone ? (
        <div className="mail-toolbar mail-phone-toolbar">
          <div className="mail-phone-row">
            {hasViews && <>
              <PhoneMailSelect label={t("mail.filters")} options={FILTERS} value={filter} onChange={chooseView} count={count} />
              {filter !== "drafts" && <PhoneMailSelect label={t("mail.category")} options={CATEGORIES} value={activeCategory} onChange={chooseCategory} />}
            </>}
            <button type="button" className="mail-phone-new" onClick={startNew} aria-label={t("mail.new")} title={t("mail.new")}><Icon name="write" /></button>
            {hasViews && <button type="button" popoverTarget={moreId} aria-label={t("mail.moreActions")} title={t("mail.moreActions")}><Icon name="more" /></button>}
          </div>
          {needsConnection && sourceBar}
          {hasViews && <div id={moreId} popover="auto" className="mail-phone-actions" role="group" aria-label={t("mail.moreActions")}>
            <div className="mail-phone-actions-head">
              <strong>{t("mail.moreActions")}</strong>
              <button type="button" popoverTarget={moreId} popoverTargetAction="hide" aria-label={t("common.close")}><Icon name="close" /></button>
            </div>
            <button type="button" className="mail-phone-draft" popoverTarget={moreId} popoverTargetAction="hide"
              aria-pressed={line.about === "mail:compose"} onClick={compose}>{t("mail.compose")}</button>
            {!needsConnection && sourceBar}
          </div>}
        </div>
      ) : (
        <div className="mail-toolbar">
          {sourceBar}
          <div className="mail-toolbar-actions">
            {hasViews && <button type="button" className="mail-compose" aria-pressed={line.about === "mail:compose"} onClick={compose}>{t("mail.compose")}</button>}
            {!inSide && <button type="button" className="mail-new" onClick={startNew}><Icon name="plus" />{t("mail.new")}</button>}
          </div>
        </div>
      )}
      {hasViews && (
        <>
          {!phone && <div className="mail-filterbar">
            {!inSide && <div className="mail-filters" role="group" aria-label={t("mail.filters")}>
              {FILTERS.map(([id, label]) => (
                <button type="button" key={id} aria-pressed={filter === id} onClick={() => chooseView(id)}>
                  {t(label)} <span className="count">{count(id)}</span>
                </button>
              ))}
            </div>}
            {filter !== "drafts" && (
              <span className="mail-category">
                <span aria-hidden="true">{t("mail.category")}</span>
                <Select className="field-select" label={t("mail.category")} value={activeCategory} onChange={(next) => chooseCategory(next as CategoryFilter)}
                  options={CATEGORIES.map(([id, label]) => ({ value: id, label: t(label) }))} />
              </span>
            )}
          </div>}
          {said && <p className="inbox-said" role="status">{said}</p>}
          {actionError && <p className="problem small" role="alert">{actionError}</p>}
          <div className="mail-split" data-reading={open || openDraft || (picked?.startsWith("d:") && composing) ? true : undefined}>
            <ul className="mail-list">
              {filter === "drafts" ? (
                <>
                  {composing && <li><button type="button" className="mail-row" aria-current={picked === "d:new" || undefined} onClick={() => setPicked("d:new")}><span className="mail-dot" aria-hidden="true" /><span className="mail-who working-label">{t("mail.writing")}</span></button></li>}
                  {drafts.length === 0 && !composing && <li className="quiet empty-list">{t("mail.empty.drafts")}</li>}
                  {drafts.toSorted((a, b) => b.at.localeCompare(a.at)).map((draft) => {
                    const under = answers(draft);
                    const inReader = under && draftFor(under)?.key === draft.key && messages.some((message) => messageKey(message) === under);
                    const target = inReader ? under : `d:${draft.key}`;
                    const recipients = draft.input.to.map((address) => address.trim()).filter(Boolean).join(", ");
                    const preview = draft.input.body.trim().slice(0, 160);
                    return (
                      <li key={draft.key}>
                        <button type="button" className="mail-row mail-draft-row" aria-current={picked === target || undefined} onClick={() => setPicked(target)}>
                          <span className="mail-draft-title">{draft.input.subject.trim() || t("mail.draft.untitled")}</span>
                          <span className="mail-meta">{draft.kind === "alfred" && <span className="tag" data-k="alfred">{getAssistant()}</span>}<time dateTime={draft.at}>{when(draft.at)}</time></span>
                          {recipients && <span className="mail-draft-to">{t("mail.to")} {recipients}</span>}
                          {preview && <span className="mail-snippet">{preview}</span>}
                        </button>
                      </li>
                    );
                  })}
                </>
              ) : (
                <>
                  {shown.length === 0 && <li className="quiet empty-list">{t("mail.empty")}</li>}
                  {shown.map((message) => {
                    const key = messageKey(message);
                    // On a phone a row that can be swiped away does not need its own archive button as well.
                    const swipe = phone && message.inInbox !== false && canModify(message);
                    return (
                      <MailEntry key={key} swipe={swipe} leaves={filter === "inbox" || filter === "unread"}
                        onArchive={() => archive(message)}>
                        <button type="button" className="mail-row" data-unread={message.unread || undefined} aria-current={picked === key || undefined} onClick={() => setPicked(key)}>
                          <span className="mail-dot" aria-hidden="true" />
                          <span className="mail-who">{message.from}</span>
                          <span className="mail-meta">
                            {draftFor(key) ? <span className="tag" data-k="alfred">{t("mail.tag.draft")}</span> : replied.has(key) && <span className="tag">{t("mail.tag.replied")}</span>}
                            <time>{when(message.receivedAt)}</time>
                          </span>
                          <span className="mail-subject">{message.subject}</span>
                          <span className="mail-snippet">{message.snippet}</span>
                        </button>
                        <FavoriteButton {...favoriteProps(message)} compact />
                        {!swipe && <ArchiveButton {...archiveProps(message)} compact />}
                      </MailEntry>
                    );
                  })}
                </>
              )}
            </ul>
            {pane}
          </div>
        </>
      )}
    </section>
  );
}
