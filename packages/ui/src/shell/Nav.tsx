import { ConversationStatus } from "./ConversationStatus.tsx";
import type { Conversation, StateResponse } from "@zirma/protocol";
import { useState } from "react";
import { api, type Connection } from "../api.ts";
import { getLocale, intlLocale, localeTag, nextLocale, t } from "../i18n/index.ts";
import { origin, setAppearance, useScheme } from "../scheme.ts";
import { Icon } from "./icons.tsx";
import { useArchive } from "./useArchive.tsx";
import { moduleOf, type PageDef } from "./pages.tsx";
import type { Mode } from "./Topbar.tsx";

const CONNECTION = { connecting: "nav.connecting", live: "nav.live", reconnecting: "nav.reconnecting" } as const;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl+";

/** "08:20" today, "yesterday", or the date ("11月16日" / "Nov 16"). */
export function when(iso: string): string {
  const at = new Date(iso), now = new Date();
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (days === 1) return t("nav.yesterday");
  return at.toLocaleDateString(intlLocale(), { month: "short", day: "numeric" });
}

export interface NavProps {
  state: StateResponse;
  pages: PageDef[];
  page: string;
  /** Daily: the workspace, modules and conversations. Dev: the Code page and its projects' sessions. All: both (phone). */
  mode: Mode | "all";
  selected: string | null;
  /** The development session open on the Code page, if any. */
  session: string | null;
  onSession(id: string | null): void;
  onNewProjectSession(projectId: string): void;
  connection: Connection;
  onArchive(conversation: Conversation, worktree?: "keep" | "discard", archiveRuns?: "finish" | "stop"): Promise<void>;
  onShowArchive(): void;
  onPage(key: string): void;
  onSelect(id: string | null): void;
  /** Shown as a sheet (phone): a button closes it. */
  onClose?: () => void;
  /** Switch between Chinese and English. */
  onLanguage(): void;
}

const UNFOLDED_KEY = "zirma.unfoldedProjects";

/** The projects unfolded on this device; every other one starts folded. */
function readUnfolded(): Set<string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(UNFOLDED_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}
function writeUnfolded(ids: Set<string>): void {
  try { localStorage.setItem(UNFOLDED_KEY, JSON.stringify([...ids])); } catch { /* private mode: lasts until the page closes */ }
}

/** A folded project still shows the most pressing state among its sessions: a reply unread, a question, or work running. */
function FoldedStatus({ sessions }: { sessions: Conversation[] }) {
  const unread = sessions.find((conversation) => conversation.unreadReplyId);
  const attention = sessions.reduce((sum, conversation) => sum + conversation.attention, 0);
  const busy = sessions.reduce((sum, conversation) => sum + conversation.busy, 0);
  if (!unread && !attention && !busy) return null;
  return <ConversationStatus conversation={{ unreadReplyId: unread?.unreadReplyId ?? null, attention, busy }} />;
}

/** The sidebar: the workspace's pages, then the conversations, like a session list; in Code, the projects' sessions. */
/** Light or dark, and 中文 / English: in the top bar, or at the foot of the phone's sidebar. */
export function ViewButtons({ onLanguage }: { onLanguage(): void }) {
  const scheme = useScheme();
  const other = scheme === "dark" ? "light" : "dark";
  return (
    <span className="view-btns">
      <button type="button" className="icon-btn scheme" onClick={(event) => setAppearance(other, origin(event))}
        aria-label={t(`scheme.to.${other}`)} title={t(`scheme.to.${other}`)}>
        <Icon name={other === "dark" ? "moon" : "sun"} />
      </button>
      <button type="button" className="lang" onClick={onLanguage} title={t("nav.languageTitle")} lang={localeTag(nextLocale(getLocale()))}>{t("nav.language")}</button>
    </span>
  );
}

export function Nav({ state, pages, page, mode, selected, session, onSession, onNewProjectSession, connection, onArchive, onShowArchive, onPage, onSelect, onClose, onLanguage }: NavProps) {
  const rename = (conversation: Conversation) => {
    const title = window.prompt(t("nav.rename"), conversation.title);
    if (title && title.trim() && title.trim() !== conversation.title) api.updateConversation(conversation.id, { title }).catch(() => {});
  };
  const { archive, archiving, archiveError, asking, dialogs } = useArchive(onArchive);
  const archiveMenu = (
    <details className="archive-menu" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
    }} onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.currentTarget.open = false;
        event.currentTarget.querySelector("summary")?.focus();
        event.stopPropagation();
      }
    }}>
      <summary className="icon-btn" aria-label={t("archive.menu")} title={t("archive.menu")}>•••</summary>
      <button type="button" aria-haspopup="dialog" onClick={(event) => {
        const menu = event.currentTarget.closest("details");
        if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
        onShowArchive();
      }}><Icon name="archive" />{t("archive.title")}</button>
    </details>
  );
  // Everyday conversations here; development sessions are listed under their projects in the Code group.
  const daily = state.conversations.filter((conversation) => !conversation.projectId && !conversation.automationOnly);
  const groups: Array<[string, PageDef[]]> = [
    [t("nav.g.work"), mode === "dev" ? [] : pages.filter((item) => item.group === "work")],
    [t("nav.g.modules"), mode === "dev" ? [] : pages.filter((item) => item.group === "modules")],
    [t("nav.g.dev"), mode === "daily" ? [] : pages.filter((item) => item.group === "dev")],
    // Settings sits in the top bar; the phone has none, so there it stays here.
    [t("nav.g.system"), mode === "all" ? pages.filter((item) => item.group === "system") : []],
  ];
  const projects = (state.projects ?? []).filter((project) => project.trustedAt);
  const sessionsIn = (projectId: string) => state.conversations.filter((conversation) => conversation.projectId === projectId).slice(0, 4);
  // Projects start folded; the one holding the open session stays unfolded.
  const [unfolded, setUnfolded] = useState(readUnfolded);
  const openSession = session ? state.conversations.find((conversation) => conversation.id === session) : undefined;
  const isOpen = (projectId: string) => unfolded.has(projectId) || openSession?.projectId === projectId;
  const fold = (projectId: string, open: boolean) => setUnfolded((current) => {
    const next = new Set(current);
    if (open) next.add(projectId); else next.delete(projectId);
    writeUnfolded(next);
    return next;
  });

  return (
    <nav className="nav" aria-label={t("nav.label")}>
      {/* Searching is ⌘K's panel and the ask bar; the sheet on a phone only needs its way out. */}
      {onClose && (
        <div className="nav-top">
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}><Icon name="close" /></button>
        </div>
      )}

      {mode !== "dev" && (
        <div className="nav-group nav-above">
          {pages.filter((item) => item.group === "alfred").map((item) => (
            <button type="button" key={item.key} className="nav-item" data-k={item.k} data-page={item.key} aria-current={page === item.key ? "page" : undefined} onClick={() => onPage(item.key)}>
              <Icon name={item.icon} /><span className="label">{item.title}</span>
            </button>
          ))}
        </div>
      )}

      {groups.map(([label, items]) => items.length > 0 && (
        <div className="nav-group" key={label}>
          <div className="nav-section-head"><p className="nav-label">{label}</p>
            {mode === "dev" && items.some((item) => item.group === "dev") && archiveMenu}
          </div>
          {items.map((item) => {
            const count = item.badge?.(state.modules[moduleOf(item)], state);
            return (
              <button type="button" key={item.key} className="nav-item" data-k={item.k} data-page={item.key} aria-current={page === item.key ? "page" : undefined}
                onClick={() => onPage(item.key)}>
                <Icon name={item.icon} /><span className="label">{item.title}</span>
                {count ? <span className="count">{count}</span> : null}
              </button>
            );
          })}
          {items.some((item) => item.group === "dev") && projects.map((project) => (
            <div className="nav-project" key={project.id}>
              <div className="nav-project-head">
                <button type="button" className="nav-project-toggle" aria-expanded={isOpen(project.id)} aria-controls={`nav-project-${project.id}`}
                  title={project.path} onClick={() => fold(project.id, !isOpen(project.id))}>
                  <Icon name="down" />
                  <Icon name="folder" />
                  <span className="nav-project-name">{project.name}</span>
                  {!isOpen(project.id) && <FoldedStatus sessions={sessionsIn(project.id)} />}
                </button>
                <button type="button" className="icon-btn" aria-label={t("nav.newProjectConversation", { name: project.name })}
                  title={t("nav.newProjectConversation", { name: project.name })} onClick={() => { fold(project.id, true); onNewProjectSession(project.id); }}>
                  <Icon name="plus" />
                </button>
              </div>
              <ul className="conv-list" id={`nav-project-${project.id}`} hidden={!isOpen(project.id)}>
                {sessionsIn(project.id).map((conversation) => (
                  <li key={conversation.id}>
                    <button type="button" className="conv" aria-current={session === conversation.id ? "true" : undefined}
                      onClick={() => onSession(conversation.id)} title={conversation.lastGoal ?? conversation.title}>
                      <ConversationStatus conversation={conversation} />
                      <span className="ct">{conversation.title}</span>
                      <span className="time">{conversation.archivePlan ? t(conversation.archivePlan === "stop" ? "archive.stopping" : "archive.planned") : when(conversation.updatedAt)}</span>
                    </button>
                    <button type="button" className="archive" disabled={archiving} aria-label={t("nav.archive", { title: conversation.title })} onClick={() => archive(conversation)}>
                      <Icon name="archive" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}

      <div className="nav-spacer" />

      {mode !== "dev" && <>
      <div className="conv-head">
        <span>{t("nav.conversations")}</span>
        {archiveMenu}
        <button type="button" className="icon-btn" aria-label={t("nav.newConversation")} title={t("nav.newConversation")} onClick={() => onSelect(null)}><Icon name="plus" /></button>
      </div>
      <ul className="conv-list">
        {daily.length === 0 && <li className="quiet small empty-list">{t("nav.noConversations")}</li>}
        {daily.map((conversation) => (
          <li key={conversation.id}>
            <button type="button" className="conv" aria-current={selected === conversation.id ? "true" : undefined}
              onClick={() => onSelect(conversation.id)} onDoubleClick={() => rename(conversation)} title={conversation.lastGoal ?? conversation.title}>
              <ConversationStatus conversation={conversation} />
              <span className="ct">{conversation.title}</span>
              {conversation.attention > 0
                ? <span className="badge attention" aria-label={t("nav.attention", { n: conversation.attention })}>{conversation.attention}</span>
                : <span className="time">{when(conversation.updatedAt)}</span>}
            </button>
            <button type="button" className="archive" disabled={archiving} aria-label={t("nav.archive", { title: conversation.title })} onClick={() => archive(conversation)}>
              <Icon name="archive" />
            </button>
          </li>
        ))}
      </ul>
      </>}

      {archiveError && !asking && <p className="problem" role="alert">{archiveError}</p>}
      <div className="nav-foot">
        <p className="connection" data-state={connection} title={t(CONNECTION[connection])}><span aria-hidden="true" /><b>{t(CONNECTION[connection])}</b></p>
        {/* On a phone, which has no top bar, the theme and language buttons live here. */}
        {onClose && <ViewButtons onLanguage={onLanguage} />}
      </div>
      {dialogs}
    </nav>
  );
}
