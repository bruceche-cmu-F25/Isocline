/** The Chats page (docs/design/chat.md): everyday conversations with Zirma as a module page. Its own sidebar holds a
 * new-chat row, the conversations by when they last moved (Today, Previous 7 days, Older) and Archived; the page is the
 * open conversation, laid out as Zirma's panel is. Without the app sidebar (folded, or a phone) the list sits in the
 * page; on a narrow page it is a list you tap into. */
import type { Conversation as ConversationRow, CoreEvent, StateResponse } from "@zirma/protocol";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./api.ts";
import { Conversation } from "./Conversation.tsx";
import { ConversationStatus } from "./shell/ConversationStatus.tsx";
import { Icon } from "./shell/icons.tsx";
import { useArchive, type ArchiveConversation } from "./shell/useArchive.tsx";
import { t, type Key } from "./i18n/index.ts";
import "./side-tree.css";
import "./chats.css";

export interface ChatProps {
  /** The open conversation (the route's `selected`), or null for a new one. */
  selected: string | null;
  /** Opens one here, or a new one (null). */
  onSelect(id: string | null): void;
  onShowArchive(): void;
  onArchive: ArchiveConversation;
  highlighted: ReadonlySet<string>;
  pageTitle(view: string): string | undefined;
  automationTitle(id: string): string | undefined;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  onView(module: string, view: string): void;
}

/** Everyday conversations: not a development session, not one only an automation uses. The sidebar's list, too. */
export const dailyConversations = (state: StateResponse) =>
  state.conversations.filter((conversation) => !conversation.projectId && !conversation.automationOnly);

const BANDS: Array<[Key, (days: number) => boolean]> = [["chat.today", (days) => days < 1], ["chat.week", (days) => days >= 1 && days <= 7], ["chat.older", (days) => days > 7]];
/** Whole days between the start of today and the start of that day, in local time. */
function daysAgo(iso: string, now = new Date()): number {
  const day = new Date(iso);
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return Math.round((start(now) - start(day)) / 86_400_000);
}
/** Below this page width the list and the conversation take turns. */
const NARROW = 720;

export function Chats({ state, side, selected, onSelect, onShowArchive, onArchive, highlighted, pageTitle, automationTitle, onEvent, onView }: ChatProps & { state: StateResponse; side: HTMLElement | null }) {
  const page = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  // On a narrow page, whether the list is showing (else the open conversation).
  const [listing, setListing] = useState(true);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const { archive, archiving, archiveError, asking, dialogs } = useArchive(onArchive);
  const conversations = dailyConversations(state).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const open = conversations.find((conversation) => conversation.id === selected);

  useEffect(() => {
    const element = page.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!menu) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".ch-menu, .ch-more")) setMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape); };
  }, [menu]);

  const pick = (id: string | null) => { setMenu(null); setListing(false); onSelect(id); };
  const rename = (conversation: ConversationRow, title: string) => {
    setRenaming(null);
    const name = title.trim();
    if (name && name !== conversation.title) api.updateConversation(conversation.id, { title: name }).catch(() => {});
  };

  const row = (conversation: ConversationRow): ReactNode => (
    <div key={conversation.id} className="st-node ch-row" role="button" tabIndex={0} aria-current={selected === conversation.id ? "true" : undefined}
      title={conversation.lastGoal ?? conversation.title}
      onClick={() => pick(conversation.id)} onDoubleClick={() => setRenaming(conversation.id)}
      onKeyDown={(event) => { if (event.key === "Enter" && event.target === event.currentTarget) pick(conversation.id); }}>
      <span className="st-space"><ConversationStatus conversation={conversation} /></span>
      {renaming === conversation.id
        ? <input className="ch-rename" autoFocus defaultValue={conversation.title} maxLength={120} aria-label={t("nav.rename")}
            onClick={(event) => event.stopPropagation()} onBlur={(event) => rename(conversation, event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") rename(conversation, event.currentTarget.value);
              if (event.key === "Escape") setRenaming(null);
            }} />
        : <span className="st-name">{conversation.title}</span>}
      {conversation.attention > 0 && <span className="st-count ch-waiting" aria-label={t("nav.attention", { n: conversation.attention })}>{conversation.attention}</span>}
      <button type="button" className="ch-more" aria-label={t("chat.more", { title: conversation.title })} aria-expanded={menu === conversation.id}
        onClick={(event) => { event.stopPropagation(); setMenu(menu === conversation.id ? null : conversation.id); }}><Icon name="more" /></button>
      {menu === conversation.id && (
        <div className="ch-menu" role="menu" onClick={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); setRenaming(conversation.id); }}>{t("chat.rename")}</button>
          <button type="button" role="menuitem" disabled={archiving} onClick={() => { setMenu(null); void archive(conversation); }}>{t("chat.archive")}</button>
        </div>
      )}
    </div>
  );

  const list = (
    <nav className="st-list ch-list" aria-label={t("page.chat")}>
      <button type="button" className="st-node" aria-current={!selected && !listing ? "true" : undefined} onClick={() => pick(null)}>
        <span className="st-space" /><Icon name="plus" /><span className="st-name">{t("nav.newConversation")}</span>
      </button>
      {conversations.length === 0 && <p className="ch-hint">{t("nav.noConversations")}</p>}
      {BANDS.map(([label, test]) => {
        const band = conversations.filter((conversation) => test(daysAgo(conversation.updatedAt)));
        return band.length ? <div key={label} role="group" aria-label={t(label)}><div className="st-label">{t(label)}</div>{band.map(row)}</div> : null;
      })}
      <div className="ch-foot">
        <button type="button" className="st-node" aria-haspopup="dialog" onClick={onShowArchive}>
          <span className="st-space" /><Icon name="archive" /><span className="st-name">{t("chat.archived")}</span>
        </button>
      </div>
      {archiveError && !asking && <p className="problem small ch-error" role="alert">{archiveError}</p>}
    </nav>
  );

  // Where the list goes: the app sidebar while it has room; else in the page, beside the conversation or, narrow,
  // instead of it.
  const listHere = !side;
  const showList = listHere && (!narrow || listing);
  const showConversation = !listHere || !narrow || !listing;

  return (
    <section className="chats" ref={page} data-narrow={narrow || undefined} data-list={listHere || undefined} aria-label={t("page.chat")}>
      {side && createPortal(list, side)}
      {showList && list}
      {showConversation && (
        <div className="alfred ch-open">
          {listHere && narrow && (
            <header className="ch-head">
              <button type="button" className="icon-btn" onClick={() => setListing(true)} aria-label={t("chat.all")} title={t("chat.all")}><Icon name="back" /></button>
              <b>{open?.title ?? t("conv.new")}</b>
            </header>
          )}
          <Conversation key={selected ?? "new"} id={selected} highlighted={highlighted} slim tuning preferredModel={state.settings?.model} suggestions={[]}
            pageTitle={pageTitle} automationTitle={automationTitle} onEvent={onEvent} onView={onView} onStarted={(id) => onSelect(id)} />
        </div>
      )}
      {dialogs}
    </section>
  );
}
