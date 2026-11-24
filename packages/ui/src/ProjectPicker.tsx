import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { Project } from "@zirma/protocol";
import { ApiError, api } from "./api.ts";
import { desktop } from "./desktop.ts";
import { t } from "./i18n/index.ts";
import { Icon } from "./shell/icons.tsx";

interface ProjectPickerProps {
  projects: Project[];
  chosen: string | null;
  onChoose(id: string): void;
  onClose(): void;
}

export function ProjectPicker({ projects, chosen, onChoose, onClose }: ProjectPickerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(projects.length === 0);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const search = query.trim().toLowerCase();
  const matches = projects.filter((project) => project.name.toLowerCase().includes(search) || project.path.toLowerCase().includes(search));

  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useLayoutEffect(() => { field.current?.focus(); }, [adding]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!path.trim() || pending) return;
    setPending(true);
    setError("");
    try {
      const project = await api.addProject(path.trim());
      if (dialog.current?.open) onChoose(project.id);
    } catch (reason) {
      setError(reason instanceof ApiError && reason.code === "local_only" ? t("dev.addLocal")
        : reason instanceof ApiError && reason.code === "invalid" ? t("dev.invalidFolder")
        : reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  const browse = async () => {
    try {
      const folder = await desktop?.pickFolder?.();
      if (folder) { setPath(folder); setError(""); }
      field.current?.focus();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const navigate = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (adding || event.nativeEvent.isComposing) return;
    const options = Array.from(list.current?.querySelectorAll("button") ?? []);
    const inSearch = event.target === field.current;
    const index = options.indexOf(event.target as HTMLButtonElement);
    if (!inSearch && index < 0) return;
    if (inSearch && event.key === "Enter" && matches.length) {
      event.preventDefault();
      onChoose(matches[0].id);
    } else if (event.key === "ArrowDown" && options.length) {
      event.preventDefault();
      options[Math.min(index + 1, options.length - 1)].focus();
    } else if (event.key === "ArrowUp" && index >= 0) {
      event.preventDefault();
      (options[index - 1] ?? field.current)?.focus();
    }
  };

  const title = t(adding ? "dev.add" : "dev.projects");
  return (
    <dialog className="project-picker" aria-label={title} ref={dialog} onKeyDown={navigate}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="project-picker-card">
        <header className="project-picker-head">
          {adding && projects.length > 0 && (
            <button type="button" className="icon-btn" disabled={pending} aria-label={t("dev.backToProjects")}
              onClick={() => { setError(""); setAdding(false); }}><Icon name="back" /></button>
          )}
          <h3>{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}><Icon name="close" /></button>
        </header>
        {adding ? (
          <form className="project-path" onSubmit={add}>
            <label htmlFor="project-path">{t("dev.addPath")}</label>
            <input id="project-path" ref={field} value={path} onChange={(event) => { setPath(event.target.value); setError(""); }}
              placeholder="/Users/you/code/app" autoComplete="off" spellCheck={false} disabled={pending} />
            {error && <p className="problem" role="alert">{error}</p>}
            <div className="project-path-actions">
              {desktop?.pickFolder && <button type="button" className="ghost" disabled={pending} onClick={browse}>{t("dev.browse")}</button>}
              <button type="submit" disabled={!path.trim() || pending}>{t("dev.addButton")}</button>
            </div>
          </form>
        ) : (
          <>
            <label className="project-search">
              <Icon name="search" />
              <input ref={field} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("dev.searchProjects")}
                aria-label={t("dev.searchProjects")} autoComplete="off" spellCheck={false} />
            </label>
            <div className="project-list" ref={list}>
              {matches.map((project) => (
                <button type="button" key={project.id} className="project-option" aria-pressed={chosen === project.id}
                  title={project.path} onClick={() => onChoose(project.id)}>
                  <Icon name="folder" />
                  <span className="project-details"><b>{project.name}</b><small>{project.path}</small></span>
                  {!project.trustedAt && <span className="project-trust">{t("dev.untrusted")}</span>}
                  {chosen === project.id && <Icon name="check" />}
                </button>
              ))}
              {!matches.length && <p className="project-empty" role="status">{t("dev.noMatches")}</p>}
            </div>
            <footer className="project-picker-foot">
              <button type="button" className="project-add"
                onClick={() => { if (query.trim().startsWith("/")) setPath(query.trim()); setAdding(true); }}>
                <Icon name="plus" />{t("dev.add")}
              </button>
            </footer>
          </>
        )}
      </div>
    </dialog>
  );
}
