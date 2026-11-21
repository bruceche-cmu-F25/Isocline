import { ConversationStatus } from "./ConversationStatus.tsx";
import type { Conversation, StateResponse } from "@alfred/protocol";
import { useState } from "react";
import { ApiError, api, type Connection } from "../api.ts";
import { getLocale, intlLocale, t } from "../i18n/index.ts";
import { origin, setAppearance, useScheme } from "../scheme.ts";
import { Icon } from "./icons.tsx";
import { Pop } from "./Pop.tsx";
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
      <button type="button" className="lang" onClick={onLanguage} title={t("nav.languageTitle")} lang={getLocale() === "zh" ? "en" : "zh"}>{t("nav.language")}</button>
    </span>
  );
}

export function Nav({ state, pages, page, mode, selected, session, onSession, connection, onArchive, onShowArchive, onPage, onSelect, onClose, onLanguage }: NavProps) {
  const rename = (conversation: Conversation) => {
    const title = window.prompt(t("nav.rename"), conversation.title);
    if (title && title.trim() && title.trim() !== conversation.title) api.updateConversation(conversation.id, { title }).catch(() => {});
  };
  // A session whose worktree holds work not committed: archiving it asks whether to keep that folder or drop it.
  const [dirty, setDirty] = useState<{ conversation: Conversation; count: number } | null>(null);
  const [unfinished, setUnfinished] = useState<{ conversation: Conversation; count: number } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  async function archive(conversation: Conversation, worktree?: "keep" | "discard", archiveRuns?: "finish" | "stop") {
    if (archiving) return;
    setArchiving(true);
    setArchiveError("");
    try {
      await onArchive(conversation, worktree, archiveRuns);
      setUnfinished(null);
      setDirty(null);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "git_dirty") {
        setUnfinished(null);
        setDirty({ conversation, count: reason.count ?? 1 });
      } else if (reason instanceof ApiError && reason.code === "archive_busy") {
        setDirty(null);
        setUnfinished({ conversation, count: reason.count ?? Math.max(1, conversation.busy + conversation.attention) });
      } else {
        setArchiveError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setArchiving(false);
    }
  }
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
  const daily = state.conversations.filter((conversation) => !conversation.projectId && !conversation.briefOnly);
  const groups: Array<[string, PageDef[]]> = [
    [t("nav.g.work"), mode === "dev" ? [] : pages.filter((item) => item.group === "work")],
    [t("nav.g.modules"), mode === "dev" ? [] : pages.filter((item) => item.group === "modules")],
    [t("nav.g.dev"), mode === "daily" ? [] : pages.filter((item) => item.group === "dev")],
    // Settings sits in the top bar; the phone has none, so there it stays here.
    [t("nav.g.system"), mode === "all" ? pages.filter((item) => item.group === "system") : []],
  ];
  const projects = (state.projects ?? []).filter((project) => project.trustedAt);
  const sessionsIn = (projectId: string) => state.conversations.filter((conversation) => conversation.projectId === projectId).slice(0, 4);

  return (
    <nav className="nav" aria-label={t("nav.label")}>
      {/* Searching is done in the ask bar (⌘K goes there); the sheet on a phone only needs its way out. */}
      {onClose && (
        <div className="nav-top">
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")} title={t("common.close")}><Icon name="close" /></button>
        </div>
      )}

      {/* 今天 is above the workspaces: alone at the top, whichever workspace the sidebar is showing. */}
      <div className="nav-group nav-above">
        {pages.filter((item) => item.group === "alfred").map((item) => (
          <button type="button" key={item.key} className="nav-item" data-k={item.k} data-page={item.key} aria-current={page === item.key ? "page" : undefined} onClick={() => onPage(item.key)}>
            <Icon name={item.icon} /><span className="label">{item.title}</span>
          </button>
        ))}
      </div>

      {groups.map(([label, items]) => items.length > 0 && (
        <div className="nav-group" key={label}>
          <div className="nav-section-head"><p className="nav-label">{label}</p>
            {mode === "dev" && items.some((item) => item.group === "dev") && archiveMenu}
          </div>
          {items.map((item) => {
            const count = item.badge?.(state.modules[moduleOf(item)], state);
            return (
              <button type="button" key={item.key} className="nav-item" data-k={item.k} aria-current={page === item.key ? "page" : undefined}
                onClick={() => onPage(item.key)}>
                <Icon name={item.icon} /><span className="label">{item.title}</span>
                {count ? <span className="count">{count}</span> : null}
              </button>
            );
          })}
          {items.some((item) => item.group === "dev") && projects.map((project) => (
            <div className="nav-project" key={project.id}>
              <p className="nav-project-name" title={project.path}>{project.name}</p>
              <ul className="conv-list">
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

      {archiveError && !dirty && !unfinished && <p className="problem" role="alert">{archiveError}</p>}
      <div className="nav-foot">
        <p className="connection" data-state={connection} title={t(CONNECTION[connection])}><span aria-hidden="true" /><b>{t(CONNECTION[connection])}</b></p>
        {/* On a phone, which has no top bar, the theme and language buttons live here. */}
        {onClose && <ViewButtons onLanguage={onLanguage} />}
      </div>
      {unfinished && (
        <Pop onClose={() => setUnfinished(null)}>
          <div className="ev-edit" role="alertdialog" aria-modal="true" aria-label={t("archive.unfinished", { n: unfinished.count })}>
            <div className="ev-card-head"><b>{t("archive.unfinished", { n: unfinished.count })}</b><button type="button" className="icon-btn" onClick={() => setUnfinished(null)} aria-label={t("common.close")}>×</button></div>
            <p>{t("archive.waitHint")}</p>
            {archiveError && <p className="problem" role="alert">{archiveError}</p>}
            <div className="ev-foot">
              {unfinished.conversation.archivePlan === "finish" && <button type="button" disabled={archiving} onClick={async () => {
                setArchiving(true);
                try { await api.updateConversation(unfinished.conversation.id, { archived: false }); setUnfinished(null); }
                catch (reason) { setArchiveError(reason instanceof Error ? reason.message : String(reason)); }
                finally { setArchiving(false); }
              }}>{t("archive.withdraw")}</button>}
              <span />
              <button type="button" className="danger" disabled={archiving} onClick={() => archive(unfinished.conversation, undefined, "stop")}>{t("archive.stop")}</button>
              <button type="button" disabled={archiving} autoFocus onClick={() => archive(unfinished.conversation, undefined, "finish")}>{t("archive.finish")}</button>
            </div>
          </div>
        </Pop>
      )}
      {dirty && (
        <Pop onClose={() => setDirty(null)}>
          <div className="ev-edit" role="alertdialog" aria-modal="true" aria-label={t("archive.dirty", { n: dirty.count })}>
            <div className="ev-card-head"><b>{t("archive.dirty", { n: dirty.count })}</b><button type="button" className="icon-btn" onClick={() => setDirty(null)} aria-label={t("common.close")}>×</button></div>
            <p>{t("archive.dirtyWhy", { branch: dirty.conversation.branch ?? "" })}</p>
            {archiveError && <p className="problem" role="alert">{archiveError}</p>}
            <div className="ev-foot">
              <span />
              <button type="button" className="danger" disabled={archiving} onClick={() => archive(dirty.conversation, "discard")}>{t("archive.discard")}</button>
              <button type="button" disabled={archiving} onClick={() => archive(dirty.conversation, "keep")} autoFocus>{t("archive.keep")}</button>
            </div>
          </div>
        </Pop>
      )}
    </nav>
  );
}
