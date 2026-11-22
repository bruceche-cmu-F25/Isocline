/** What a development session's panel does with its work (docs/design/dev-mode.md D5): commit the changes, push them
 * with a pull request, and the background processes (dev servers) Alfred or the user started in it.
 *
 * Committing is local and uses the files and diff selected in the commit card. Pushing and opening a pull request leave the computer and
 * cannot be taken back, so the card says exactly what will be sent where, every time, before it is sent.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { SessionBranch, SessionChanges, SessionProcess, SessionPullRequest } from "@alfred/protocol";
import { ApiError, api } from "./api.ts";
import { t } from "./i18n/index.ts";
import { Icon } from "./shell/icons.tsx";
import { Pop } from "./shell/Pop.tsx";

const errorOf = (reason: unknown) => (reason instanceof ApiError && reason.code && reason.code.startsWith("git_") && reason.code !== "git_failed"
  ? t(`git.${reason.code.slice(4)}` as Parameters<typeof t>[0]) : reason instanceof Error ? reason.message : String(reason));

/** Commit and pull request: two buttons under the changes, and a line on where the branch stands. */
export function Ship({ id, title, changes, onChanged }: { id: string; title: string; changes: SessionChanges | null; onChanged(): void }) {
  const [branch, setBranch] = useState<SessionBranch | null>(null);
  const [pr, setPr] = useState<SessionPullRequest["pr"] | undefined>(undefined);
  const [card, setCard] = useState<"commit" | "publish" | null>(null);
  const files = changes?.files.length ?? 0;
  const load = useCallback(() => {
    api.branch(id).then((next) => {
      setBranch(next);
      // GitHub is asked only where a pull request could be: a pushed branch that is not the main one.
      if (next.branch && next.branch !== next.main && next.upstream) api.pullRequest(id).then((found) => setPr(found.pr), () => setPr(null));
      else setPr(null);
    }, () => setBranch(null));
  }, [id]);
  useEffect(load, [load, changes?.base]);

  if (!changes || changes.gone || !changes.branch) return null;
  const onMain = !!branch && branch.branch === branch.main;
  const canPublish = !!branch?.branch && !onMain && branch.remote && (branch.ahead > 0 || !branch.upstream);
  return (
    <>
      <div className="dev-ship">
        <button type="button" className="dev-ship-btn" disabled={files === 0} onClick={() => setCard("commit")}><Icon name="check" />{t("ship.commit")}</button>
        <button type="button" className="dev-ship-btn" disabled={!canPublish} onClick={() => setCard("publish")}
          title={onMain ? t("ship.onMain", { branch: branch?.branch ?? "" }) : !branch?.remote ? t("git.no_remote") : undefined}>
          <Icon name="branch" />{pr?.state === "OPEN" ? t("ship.push") : t("ship.pr")}
        </button>
      </div>
      {branch && (
        <p className="small quiet dev-ship-state">
          {branch.ahead > 0 && <span>{t(branch.upstream ? "ship.ahead" : "ship.local", { n: branch.ahead })}</span>}
          {pr && <a className="dev-link" href={pr.url} target="_blank" rel="noopener noreferrer">PR #{pr.number}{pr.state !== "OPEN" ? ` · ${pr.state.toLowerCase()}` : ""} ↗</a>}
          {onMain && <span>{t("ship.onMain", { branch: branch.branch ?? "" })}</span>}
          {!onMain && !branch.remote && <span>{t("ship.noRemote")}</span>}
        </p>
      )}
      {card === "commit" && <CommitCard id={id} title={title} changes={changes} onClose={() => setCard(null)} onDone={() => { setCard(null); onChanged(); load(); }} />}
      {card === "publish" && branch?.branch && (
        <PublishCard id={id} title={title} branch={branch.branch} main={branch.main} pr={pr ?? null} onClose={() => setCard(null)} onDone={(next) => { setCard(null); setPr(next); load(); }} />
      )}
    </>
  );
}

function CommitCard({ id, title, changes, onClose, onDone }: { id: string; title: string; changes: SessionChanges; onClose(): void; onDone(): void }) {
  const [message, setMessage] = useState(title);
  const [files, setFiles] = useState(changes.files);
  const [paths, setPaths] = useState(changes.suggested ?? []);
  const [review, setReview] = useState<{ paths: string[]; token: string; patch: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = review?.paths === paths ? review : null;
  useEffect(() => {
    if (!paths.length) return;
    let live = true;
    api.commitPreview(id, paths).then((result) => { if (live) setReview({ ...result, paths }); },
      (reason) => { if (live) setError(errorOf(reason)); });
    return () => { live = false; };
  }, [id, paths]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim() || !current || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.commit(id, message.trim(), paths, current.token);
      onDone();
    } catch (reason) {
      setError(errorOf(reason));
      if (reason instanceof ApiError && (reason.code === "git_changed" || reason.code === "git_nothing")) {
        setReview(null);
        try {
          const next = await api.changes(id);
          setFiles(next.files);
          setPaths(paths.filter((path) => next.files.some((file) => file.path === path)));
        } catch (refreshError) { setError(errorOf(refreshError)); }
      }
      setBusy(false);
    }
  };
  return (
    <Pop onClose={onClose}>
      <form className="ev-edit ship-card" role="dialog" aria-modal="true" aria-label={t("ship.commit")} onSubmit={submit}>
        <div className="ev-card-head"><b>{t("ship.commitTitle", { n: paths.length })}</b><button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>×</button></div>
        <ul className="ship-files">{files.map((file) => <li key={file.path}><label>
          <input type="checkbox" disabled={busy} checked={paths.includes(file.path)} onChange={(event) => {
            setError(null);
            setPaths(event.target.checked ? [...paths, file.path] : paths.filter((path) => path !== file.path));
          }} /><span className="p" title={file.path}>{file.path}</span>
        </label></li>)}</ul>
        {current && <pre className="diff ship-patch" tabIndex={0} aria-label={t("ship.preview")}>{current.patch}</pre>}
        <textarea className="ev-field" value={message} onChange={(event) => setMessage(event.target.value)} rows={2} maxLength={5000} aria-label={t("ship.message")} placeholder={t("ship.message")} autoFocus />
        <div className="ev-foot">
          <span className={error ? "ev-error" : "quiet"} role={error ? "alert" : undefined}>{error ?? t("ship.commitNote")}</span>
          <button type="button" className="ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" disabled={!message.trim() || busy || !current}>{busy ? t("ship.committing") : t("ship.commit")}</button>
        </div>
      </form>
    </Pop>
  );
}

function PublishCard({ id, title, branch, main, pr, onClose, onDone }: {
  id: string; title: string; branch: string; main: string | null; pr: SessionPullRequest["pr"]; onClose(): void; onDone(pr: SessionPullRequest["pr"]): void;
}) {
  const update = pr?.state === "OPEN";
  const [name, setName] = useState(title);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    api.publish(id, name.trim(), body).then((done) => {
      onDone(done.url ? { url: done.url, number: Number(/\/pull\/(\d+)/.exec(done.url)?.[1] ?? pr?.number ?? 0), state: "OPEN" } : pr);
      if (done.url) window.open(done.url, "_blank", "noopener");
    }, (reason) => { setError(errorOf(reason)); setBusy(false); });
  };
  return (
    <Pop onClose={onClose}>
      <form className="ev-edit ship-card" role="dialog" aria-modal="true" aria-label={t("ship.pr")} onSubmit={submit}>
        <div className="ev-card-head"><b>{update ? t("ship.pushTitle", { n: pr!.number }) : t("ship.prTitle")}</b><button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>×</button></div>
        {/* What leaves the computer, said before it does. */}
        <p className="ship-out">{update ? t("ship.pushWhat", { branch }) : t("ship.prWhat", { branch, main: main ?? "main" })}</p>
        {!update && (
          <>
            <input className="ev-field" value={name} onChange={(event) => setName(event.target.value)} maxLength={256} aria-label={t("ship.prName")} placeholder={t("ship.prName")} autoFocus />
            <textarea className="ev-field" value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={20_000} aria-label={t("ship.prBody")} placeholder={t("ship.prBody")} />
          </>
        )}
        <div className="ev-foot">
          <span className={error ? "ev-error" : "quiet"} role={error ? "alert" : undefined}>{error ?? t("ship.outward")}</span>
          <button type="button" className="ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" disabled={!name.trim() || busy}>{busy ? t("ship.sending") : update ? t("ship.push") : t("ship.prSend")}</button>
        </div>
      </form>
    </Pop>
  );
}

/** A session's background processes, read again every few seconds while the session is open. */
export function useProcesses(id: string): { list: SessionProcess[]; reload(): void } {
  const [list, setList] = useState<SessionProcess[]>([]);
  const reload = useCallback(() => { api.processes(id).then((next) => setList(next.processes), () => {}); }, [id]);
  useEffect(() => {
    reload();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") reload(); }, 3000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { list, reload };
}

/** The panel's section: each process with its state, its address (opened in the browser pane when there is one), its
 * output, and a stop; under them, a command to start one (the user's own, on the Mac Alfred runs on). */
export function Processes({ id, mode, processes, onOpen, onLogs }: {
  id: string; mode: string; processes: { list: SessionProcess[]; reload(): void }; onOpen(url: string): void; onLogs(process: SessionProcess): void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const start = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim()) return;
    setError(null);
    api.startProcess(id, draft.trim()).then(() => { setDraft(""); processes.reload(); }, (reason) => {
      setError(reason instanceof ApiError && reason.code === "local_only" ? t("proc.localOnly") : reason instanceof Error ? reason.message : String(reason));
    });
  };
  const stop = (process: SessionProcess) => { api.stopProcess(id, process.id).then(processes.reload, () => {}); };
  return (
    <>
      {processes.list.length === 0 ? <p className="small quiet">{t(mode === "plan" ? "proc.nonePlan" : "proc.none")}</p> : (
        <ul className="dev-procs">
          {processes.list.map((process) => (
            <li key={process.id} data-ended={process.exit !== null || undefined}>
              <span className="st" aria-hidden="true">{process.exit === null ? <span className="pulse" /> : <span className="mark" data-k={process.exit === 0 ? undefined : "warm"} />}</span>
              <button type="button" className="dev-proc-name" onClick={() => onLogs(process)} title={`$ ${process.command}`}>
                <b>{process.name}</b>
                <span>{process.exit === null ? t(process.by === "alfred" ? "proc.byAlfred" : "proc.byYou") : t("proc.exited", { code: process.exit })}</span>
              </button>
              {process.url && process.exit === null && <button type="button" className="dev-proc-url" onClick={() => onOpen(process.url!)} title={process.url}>{process.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</button>}
              <button type="button" className="icon-btn" onClick={() => stop(process)} aria-label={t(process.exit === null ? "proc.stop" : "proc.forget", { name: process.name })} title={t(process.exit === null ? "proc.stop" : "proc.forget", { name: process.name })}>
                {process.exit === null ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 6.5h7v7h-7z" /></svg> : "×"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="dev-proc-add" onSubmit={start}>
        <Icon name="play" />
        <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("proc.placeholder")} aria-label={t("proc.start")} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      </form>
      {error && <p className="problem small" role="alert">{error}</p>}
    </>
  );
}

/** What a process printed, in the session's drawer; read again while it runs and the window is in view, and only
 * taken when there is something new. Once it has ended and nothing more comes, it is not asked again. */
export function ProcessLogs({ id, process }: { id: string; process: SessionProcess }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    /** How much it had printed at the last reading (a home node that does not say reads it all each time). */
    let seen: number | undefined;
    const load = () => api.processLogs(id, process.id, seen).then((next) => {
      if (!alive) return;
      if (!next.unchanged) setText(next.text);
      seen = next.printed;
      // Ended, and a reading after that found nothing new: what is shown is all there will be.
      if (next.process.exit !== null && next.unchanged) window.clearInterval(timer);
    }, () => { seen = undefined; if (alive) setText(""); });
    load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") load(); }, 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [id, process.id]);
  return (
    <>
      <p className="small quiet mono dev-proc-cmd">$ {process.command}</p>
      <pre className="dev-logs">{text === null ? "…" : text || t("proc.silent")}</pre>
    </>
  );
}
