import { ConversationStatus } from "./shell/ConversationStatus.tsx";
/** The Code page: development sessions in the user's projects (docs/design/dev-mode.md).
 *
 * With no session open it is the new-session screen: one composer, with the project and the permission mode chosen
 * under it (adding and trusting a folder happen here, on the home node's machine only); the first message opens the
 * session. With one open it is that session, full page: the same conversation component as everyday ones, without a
 * page to ask from. Behind both moves a field of characters (shell/AsciiField.tsx): this is where code is written.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import type { Conversation as ConversationRow, CoreEvent, Project, SessionChanges, SessionMode, StateResponse } from "@alfred/protocol";
import { ApiError, api } from "./api.ts";
import { Conversation } from "./Conversation.tsx";
import { desktop } from "./desktop.ts";
import { Diff } from "./Diff.tsx";
import { t, type Key } from "./i18n/index.ts";
import { AsciiField } from "./shell/AsciiField.tsx";
import { Figure } from "./shell/Figure.tsx";
import { ChoicePicker } from "./shell/ChoicePicker.tsx";
import { Icon } from "./shell/icons.tsx";
import { MicButton } from "./voice/MicButton.tsx";
import { appendDictation } from "./voice/wav.ts";
import { AttachButton, AttachChips, useAttachments } from "./attach.tsx";
import { sends } from "./prefs.ts";
import { Terminal } from "./Terminal.tsx";
import { BrowserPane } from "./BrowserPane.tsx";
import { when } from "./shell/Nav.tsx";
import { ProcessLogs, Processes, Ship, useProcesses } from "./DevWork.tsx";
import { ProjectPicker } from "./ProjectPicker.tsx";
import { RequestDevAccess } from "./RequestDevAccess.tsx";
import type { SessionProcess } from "@alfred/protocol";

export interface DevProps {
  state: StateResponse;
  /** The open session, or null for the new-session screen. */
  session: string | null;
  onSession(id: string | null): void;
  refresh(): void;
  live: Readonly<Record<string, string>>;
  highlighted: ReadonlySet<string>;
  onEvent(listener: (event: CoreEvent) => void): () => void;
  pageTitle(view: string): string | undefined;
  automationTitle(id: string): string | undefined;
}

/** Development sessions, most recently active first. */
export const sessionsOf = (state: StateResponse, projectId?: string) =>
  state.conversations.filter((conversation) => conversation.projectId && (!projectId || conversation.projectId === projectId));

export function Dev(props: DevProps) {
  const { state, session } = props;
  const open = session ? state.conversations.find((conversation) => conversation.id === session) : undefined;
  const restricted = state.devAccess === "off" || state.devAccess === "pending";
  const request = restricted ? (
    <div className="set-flow">
      {state.devAccess === "off" && <p>{t("dev.accessNeeded")}</p>}
      <RequestDevAccess pending={state.devAccess === "pending"} onRequested={props.refresh} />
    </div>
  ) : null;
  let content: ReactElement;
  if (!session) {
    content = <NewSession state={state} onSession={props.onSession} accessRequest={request} />;
  } else if (request) {
    content = (
      <div className="dev-new">
        <div className="dev-new-in">
          <header className="dev-new-head"><h2>{open?.title || t("devices.dev")}</h2></header>
          {request}
          <div><button type="button" className="set-button ghost" onClick={() => props.onSession(null)}>{t("dev.back")}</button></div>
        </div>
      </div>
    );
  } else {
    content = <Session key={session} {...props} id={session} conversation={open} />;
  }
  return (
    <div className="dev-stage" data-in={session ? "session" : "new"}>
      <AsciiField />
      {!session && <div className="dev-drag" aria-hidden="true" />}
      {content}
    </div>
  );
}

const noView = () => {};

const MODES: SessionMode[] = ["plan", "ask", "edits"];
const PANEL_KEY = "alfred.devPanel";

function Session({ id, conversation, state, onSession, live, highlighted, onEvent, pageTitle, automationTitle }: DevProps & { id: string; conversation?: ConversationRow }) {
  const project = state.projects?.find((candidate) => candidate.id === conversation?.projectId);
  // Open by default where there is room beside the session; on a narrow screen it opens over it, when asked.
  const [panel, setPanel] = useState(() => { try { return matchMedia("(min-width: 1001px)").matches && localStorage.getItem(PANEL_KEY) !== "closed"; } catch { return false; } });
  const [changes, setChanges] = useState<SessionChanges | null>(null);
  const [open, setOpen] = useState<{ path: string; diff: string | null } | null>(null);
  // A background process's output, in the same drawer as a diff.
  const [logs, setLogs] = useState<SessionProcess | null>(null);
  const processes = useProcesses(id);
  // The user's own terminal, under the conversation. Hiding it leaves its shell running.
  const [term, setTerm] = useState(false);
  // The Mac app's browser pane takes the place of the details panel while it is open.
  const [browser, setBrowser] = useState(false);
  const canBrowse = !!desktop?.browser;
  const togglePanel = () => setPanel((value) => { try { localStorage.setItem(PANEL_KEY, value ? "closed" : "open"); } catch { /* not remembered */ } return !value; });

  // The changed files, read again whenever this session's runs change something or finish.
  const timer = useRef<number | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => api.changes(id).then((next) => { if (alive) setChanges(next); }).catch(() => {});
    void load();
    const off = onEvent((event) => {
      if (event.kind !== "file.changed" && event.kind !== "run.completed" && event.kind !== "run.failed") return;
      if (event.kind !== "file.changed") processes.reload();
      if (timer.current === null) timer.current = window.setTimeout(() => { timer.current = null; void load(); }, 300);
    });
    return () => {
      alive = false;
      off();
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [id, onEvent, reloads]);
  const show = (path: string) => {
    const selection = { path, diff: null };
    setLogs(null);
    setOpen(selection);
    const loaded = (diff: string) => setOpen((current) => current === selection ? { path, diff } : current);
    api.diff(id, path).then(({ diff }) => loaded(diff ?? ""), () => loaded(""));
  };
  // A dev server's address: in the browser pane where there is one, else a tab of its own.
  const openUrl = (address: string) => {
    if (desktop?.browser) { setBrowser(true); desktop.browser.go(address); } else window.open(address, "_blank", "noopener");
  };

  const files = changes?.files ?? [];
  const added = files.reduce((sum, file) => sum + file.added, 0), removed = files.reduce((sum, file) => sum + file.removed, 0);
  const mode = conversation?.mode ?? "plan";
  const allowed = conversation?.commands ?? [];
  return (
    <div className="dev-layout" data-panel={(panel && !browser) || undefined} data-browser={browser || undefined}>
      <section className="dev-session">
        <Conversation key={id} id={id} live={live} highlighted={highlighted} suggestions={[]} pageTitle={pageTitle} automationTitle={automationTitle}
          onEvent={onEvent} onView={noView} onStarted={noView}
          sessionToolbar={(title, usage) => (
            <header className="dev-bar">
              <button type="button" className="icon-btn" onClick={() => onSession(null)} aria-label={t("dev.back")} title={t("dev.back")}><Icon name="back" /></button>
              <div className="dev-identity">
                {project && <span className="dev-where" title={[conversation?.worktree ?? project.path, changes?.branch, t(conversation?.worktree ? "dev.isolated" : "dev.shared")].filter(Boolean).join(" · ")}><Icon name={conversation?.worktree ? "layers" : "folder"} /><small>{t(conversation?.worktree ? "dev.isolated" : "dev.shared")}</small><span>{project.name}{changes?.branch ? ` · ${changes.branch}` : ""}</span></span>}
                <h1 title={title}>{title}</h1>
              </div>
              {usage}
              <div className="dev-tools">
                <button type="button" className="icon-btn dev-term-toggle" onClick={() => setTerm(!term)} aria-pressed={term} aria-label={t("term.title")} title={t("term.title")}><Icon name="terminal" /></button>
                {canBrowse && <button type="button" className="icon-btn dev-browser-toggle" onClick={() => setBrowser(!browser)} aria-pressed={browser} aria-label={t("browser.title")} title={t("browser.title")}><Icon name="globe" /></button>}
                <button type="button" className="icon-btn dev-panel-toggle" onClick={togglePanel} aria-pressed={panel} aria-label={t("dev.panel")} title={t("dev.panel")}><Icon name="panel" /></button>
              </div>
            </header>
          )} />
        {term && <Terminal session={id} onClose={() => setTerm(false)} />}
        {open && (
          <div className="dev-drawer" role="dialog" aria-label={open.path}>
            <header><button type="button" className="icon-btn" onClick={() => setOpen(null)} aria-label={t("common.close")}><Icon name="back" /></button><span className="p">{open.path}</span></header>
            {open.diff === null ? <p className="quiet small">…</p> : open.diff ? <Diff patch={open.diff} /> : <p className="quiet small">{t("dev.noDiff")}</p>}
          </div>
        )}
        {logs && (
          <div className="dev-drawer" role="dialog" aria-label={logs.name}>
            <header><button type="button" className="icon-btn" onClick={() => setLogs(null)} aria-label={t("common.close")}><Icon name="back" /></button><span className="p">{logs.name}</span></header>
            <ProcessLogs id={id} process={logs} />
          </div>
        )}
      </section>
      {browser && <BrowserPane onClose={() => setBrowser(false)} />}
      {panel && !browser && (
        <aside className="dev-panel" aria-label={t("dev.panel")}>
          <section>
            <h3>{t("dev.env")}</h3>
            {project && <p className="kv" title={project.path}><Icon name="folder" /><span className="mono">{project.path}</span></p>}
            {conversation?.worktree && <p className="kv" title={conversation.worktree}><Icon name="layers" /><span>{t("dev.worktreeAt")}</span></p>}
            <p className="kv"><Icon name="branch" /><span className="mono">{changes?.branch ?? t("dev.noGit")}</span></p>
            {changes?.gone && <p className="small problem">{t("dev.gone")}</p>}
          </section>
          <section>
            <h3>{t("mode.title")}</h3>
            <div className="dev-modes" role="radiogroup" aria-label={t("mode.title")}>
              {MODES.map((candidate) => (
                <button type="button" key={candidate} role="radio" aria-checked={mode === candidate} data-mode={candidate}
                  onClick={() => { if (candidate !== mode) api.updateConversation(id, { mode: candidate }).catch(() => {}); }}>
                  <b>{t(`mode.${candidate}` as Key)}</b><span>{t(`mode.${candidate}.hint` as Key)}</span>
                </button>
              ))}
            </div>
            <p className="small quiet">{t("mode.outside")}</p>
          </section>
          <section>
            <h3>{t("dev.commands")}</h3>
            {allowed.length === 0 ? <p className="small quiet">{t(mode === "plan" ? "dev.commandsPlan" : "dev.commandsAsk")}</p> : (
              <>
                <ul className="dev-commands">
                  {allowed.map((command) => (
                    <li key={command}>
                      <code title={command}>{command}</code>
                      <button type="button" className="icon-btn" onClick={() => { api.updateConversation(id, { forgetCommand: command }).catch(() => {}); }}
                        aria-label={t("dev.commandForget", { command })} title={t("dev.commandForget", { command })}>×</button>
                    </li>
                  ))}
                </ul>
                <p className="small quiet">{t("dev.commandsAllowed")}</p>
              </>
            )}
          </section>
          <section>
            <h3>{t("dev.changes")}{files.length > 0 && <span className="mono"><span className="add">+{added}</span> <span className="del">−{removed}</span></span>}</h3>
            {files.length === 0 ? <p className="small quiet">{t("dev.noChanges")}</p> : (
              <ul className="dev-files">
                {files.map((file) => (
                  <li key={file.path}>
                    <button type="button" onClick={() => show(file.path)} title={file.path} aria-current={open?.path === file.path || undefined}>
                      <span className="p">{file.path}</span>
                      {file.created && <span className="new">{t("dev.new1")}</span>}
                      <span className="add">+{file.added}</span>{file.removed > 0 && <span className="del">−{file.removed}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {changes?.base && <p className="small quiet">{t("dev.since", { base: changes.base.slice(0, 7) })}</p>}
            <Ship id={id} title={conversation?.title ?? ""} changes={changes} onChanged={() => setReloads((n) => n + 1)} />
          </section>
          <section>
            <h3>{t("proc.title")}{processes.list.some((process) => process.exit === null) && <span className="mono">{processes.list.filter((process) => process.exit === null).length}</span>}</h3>
            <Processes id={id} mode={mode} processes={processes} onOpen={openUrl} onLogs={(process) => { setOpen(null); setLogs(process); }} />
          </section>
        </aside>
      )}
    </div>
  );
}

function NewSession({ state, onSession, accessRequest }: { state: StateResponse; onSession(id: string): void; accessRequest: ReactElement | null }) {
  const projects = state.projects ?? [];
  const [chosen, setChosen] = useState<string | null>(() => projects.find((project) => project.trustedAt)?.id ?? null);
  const [mode, setMode] = useState<SessionMode>("ask");
  // A worktree of its own: a separate folder on a new branch, so the project's own folder is left as it is.
  const [worktreeChoice, setWorktreeChoice] = useState<{ projectId: string; enabled: boolean } | null>(null);
  const project = projects.find((candidate) => candidate.id === chosen);
  const concurrent = !!project?.gitRoot && mode !== "plan" && state.conversations.some((session) =>
    session.projectId === chosen && !session.archivedAt && session.base && session.mode !== "plan");
  const worktree = project?.gitRoot !== false && (worktreeChoice && worktreeChoice.projectId === chosen ? worktreeChoice.enabled : concurrent);
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useAttachments();
  const fail = (reason: unknown) => setError(reason instanceof ApiError && reason.code === "local_only" ? t("dev.addLocal")
    : reason instanceof ApiError && reason.code === "needs_dev" ? t("dev.needsScope")
    : reason instanceof ApiError && (reason.code === "git_not_git" || reason.code === "git_no_commit" || reason.code === "git_subproject") ? t(`git.${reason.code.slice(4)}` as Key)
    : reason instanceof Error ? reason.message : String(reason));

  const trust = (target: Project) => { setError(null); api.trustProject(target.id).catch(fail); };

  const start = (event?: FormEvent) => {
    event?.preventDefault();
    const files = attachments.ids;
    const text = draft.trim() || (files.length ? t("attach.look") : "");
    if (accessRequest || !text || !project?.trustedAt || busy || attachments.busy) return;
    setBusy(true);
    setError(null);
    api.startSession(project.id, text, mode, worktree)
      .then(async (conversation) => { await api.submit(text, conversation.id, undefined, files); attachments.clear(); onSession(conversation.id); })
      .catch((reason) => { fail(reason); setBusy(false); });
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (sends(event)) start(event);
  };
  const recent = sessionsOf(state).slice(0, 5);
  const nameOf = (projectId: string | null) => projects.find((candidate) => candidate.id === projectId)?.name ?? "";

  return (
    <div className="dev-new">
      <div className="dev-new-in">
        <header className="dev-new-head">
          <Figure state="hello" size={40} />
          <h2>{t("dev.new")}</h2>
        </header>

        <form className="composer dev-composer" onSubmit={start} onPaste={attachments.onPaste} onDrop={attachments.onDrop} onDragOver={attachments.onDragOver}>
          <AttachChips attachments={attachments} />
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKey}
            rows={Math.min(6, Math.max(2, draft.split("\n").length))} maxLength={8000} aria-label={t("composer.label")}
            placeholder={project?.trustedAt ? t("dev.ask", { name: project.name }) : t("dev.pick")} disabled={!project?.trustedAt} />
          <div className="composer-bar">
            <button type="button" className="pick project-trigger" aria-haspopup="dialog" aria-expanded={picking}
              aria-label={project ? t("dev.switchProject", { name: project.name }) : t("dev.projects")} title={project?.path ?? t("dev.projects")}
              onClick={(event) => { event.currentTarget.focus(); setPicking(true); }}>
              <Icon name="folder" /><span>{project?.name ?? t("dev.projects")}</span><Icon name="down" />
            </button>
            <ChoicePicker label={t("mode.title")} value={mode} mode={mode} icon={<Icon name="shield" />}
              options={MODES.map((value) => ({ value, label: t(`mode.${value}` as Key) }))}
              onChange={(value) => setMode(value as SessionMode)} />
            <button type="button" className="pick toggle" aria-pressed={worktree} onClick={() => { if (chosen) setWorktreeChoice({ projectId: chosen, enabled: !worktree }); }} disabled={!project?.trustedAt || project.gitRoot === false} title={t(project?.gitRoot === false ? "git.subproject" : "dev.worktreeHint")}>
              <Icon name="branch" /><span>{t("dev.worktree")}</span>
            </button>
            <span className="grow" />
            <AttachButton attachments={attachments} disabled={!project?.trustedAt} />
            <MicButton disabled={!project?.trustedAt} onText={(words) => setDraft((now) => appendDictation(now, words))} />
            <button type="submit" className="send" disabled={!!accessRequest || (!draft.trim() && !attachments.ids.length) || !project?.trustedAt || busy || attachments.busy} aria-label={t("composer.send")}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 5l5 5-5 5" /></svg>
            </button>
          </div>
        </form>
        {accessRequest}
        {/* What the two choices under the composer mean, in one line. */}
        <p className="dev-note">{project && <span className="mono" title={project.path}>{project.path}</span>}<span>{worktree ? `${t("dev.worktreeHint")} · ` : ""}{t(`mode.${mode}.hint` as Key)}</span></p>
        {picking && (
          <ProjectPicker projects={projects} chosen={chosen} onClose={() => setPicking(false)}
            onChoose={(id) => { setChosen(id); setError(null); setPicking(false); }} />
        )}
        {error && <p className="problem small" role="alert">{error}</p>}

        {project && !project.trustedAt && (
          <div className="dev-trust" role="group" aria-label={t("dev.trustTitle", { name: project.name })}>
            <p><b>{t("dev.trustTitle", { name: project.name })}</b></p>
            <ul><li>{t("dev.trust1")}</li><li>{t("dev.trust2")}</li><li>{t("dev.trust3")}</li></ul>
            <div className="dev-actions">
              <button type="button" onClick={() => trust(project)}>{t("dev.trust")}</button>
              <button type="button" className="ghost" onClick={() => setChosen(projects.find((candidate) => candidate.trustedAt)?.id ?? null)}>{t("dev.trustNo")}</button>
            </div>
          </div>
        )}

        {recent.length > 0 && (
          <div className="dev-box">
            <p className="dev-box-label">{t("dev.recent")}</p>
            {recent.map((conversation) => (
              <button type="button" key={conversation.id} className="dev-recent" onClick={() => onSession(conversation.id)}>
                <ConversationStatus conversation={conversation} />
                <span className="t">{conversation.title}</span>
                <span className="p">{nameOf(conversation.projectId)}</span>
                <span className="time">{when(conversation.updatedAt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
