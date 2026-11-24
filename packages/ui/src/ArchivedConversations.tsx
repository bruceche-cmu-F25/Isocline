import type { ArchivedConversation, Project } from "@zirma/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { intlLocale, t } from "./i18n/index.ts";
import { Icon } from "./shell/icons.tsx";
import type { Zirma } from "./useZirma.ts";
import "./archived-conversations.css";

interface ArchivedConversationsProps {
  projects: Project[];
  onClose(): void;
  onRestore(conversation: ArchivedConversation): Promise<void>;
  onEvent: Zirma["onEvent"];
}

export function ArchivedConversations({ projects, onClose, onRestore, onEvent }: ArchivedConversationsProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [rows, setRows] = useState<ArchivedConversation[] | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const dateFormat = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "short" });
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => onEvent((event) => {
    if (event.kind === "conversation.archived" || event.kind === "conversation.restored") {
      setRevision((value) => value + 1);
    }
  }), [onEvent]);

  useEffect(() => {
    let current = true;
    setLoadError("");
    api.archivedConversations().then(({ conversations }) => {
      if (current) setRows(conversations);
    }).catch((reason: Error) => {
      if (current) setLoadError(reason.message);
    });
    return () => { current = false; };
  }, [revision]);

  async function restore(conversation: ArchivedConversation, button: HTMLButtonElement) {
    if (pending !== null) return;
    setPending(conversation.id);
    setRestored(null);
    setRestoreError("");
    const row = button.closest("li");
    const neighbor = row?.nextElementSibling ?? row?.previousElementSibling;
    try {
      await onRestore(conversation);
      if (!dialog.current?.open) return;
      if (document.activeElement === button || !dialog.current.contains(document.activeElement)) {
        (neighbor?.querySelector("button") ?? closeButton.current)?.focus();
      }
      setRows((current) => current?.filter((item) => item.id !== conversation.id) ?? null);
      setRestored(conversation.title);
    } catch (reason) {
      setRestoreError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(null);
    }
  }

  return (
    <dialog className="project-picker archived-conversations" ref={dialog} aria-label={t("archive.title")}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="project-picker-card">
        <header className="project-picker-head">
          <h3>{t("archive.title")}</h3>
          <button type="button" className="icon-btn" ref={closeButton} aria-label={t("common.close")} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {loadError && <div className="archive-load-error">
          <p className="problem" role="alert">{loadError}</p>
          <button type="button" className="archive-action ghost" onClick={() => setRevision((value) => value + 1)}>{t("archive.retry")}</button>
        </div>}
        {!loadError && !rows?.length && <p role="status" className="project-empty">{t(rows ? "archive.empty" : "archive.loading")}</p>}
        {rows && rows.length > 0 && (
          <ul className="archived-list">
            {rows.map((conversation) => {
              const project = conversation.projectId && (projectNames.get(conversation.projectId) ?? t("nav.g.dev"));
              return (
                <li key={conversation.id}>
                  <div className="archived-details">
                    <b>{conversation.title}</b>
                    <small>{project && <>{project} · </>}<time dateTime={conversation.archivedAt}>{dateFormat.format(new Date(conversation.archivedAt))}</time></small>
                  </div>
                  <button type="button" className="archive-action ghost" aria-disabled={pending !== null}
                    aria-label={t("archive.restoreNamed", { title: conversation.title })}
                    onClick={(event) => { void restore(conversation, event.currentTarget); }}>
                    {t(pending === conversation.id ? "archive.restoring" : "archive.restore")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {restoreError && <p className="archive-feedback problem" role="alert">{restoreError}</p>}
        <p className="archive-feedback" role="status">{restored !== null && t("archive.restored", { title: restored })}</p>
      </div>
    </dialog>
  );
}
