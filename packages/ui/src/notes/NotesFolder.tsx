/** The notes in Settings (notes.md 4.1, notes-two-layers.md 4.5, 4.8, 5): where they are kept (on the Mac the home
 * node runs on, a way to show the folder and to choose another; choosing another moves nothing), and whether the
 * assistant keeps its own pages from them, which sends their words to the model, and when its daily pass is. */
import { useState, type FormEvent } from "react";
import type { StateResponse } from "@zirma/protocol";
import { api } from "../api.ts";
import { t } from "../i18n/index.ts";
import { snapshotOf } from "../modules.ts";

export function NotesFolder({ state, local }: { state: StateResponse; local: boolean }) {
  const notes = snapshotOf(state, "note");
  const [typing, setTyping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  if (!notes) return null;
  const compile = notes.compile ?? { enabled: true, daily: "07:30", running: false };
  const setCompile = async (input: { enabled?: boolean; daily?: string; now?: boolean }) => {
    setSaid(null);
    const answer = await api.op("note.compile", input).catch((reason: Error) => ({ result: { error: reason.message } }));
    const result = answer.result as { error?: string } | null;
    if (result?.error) setError(result.error);
    else if (input.now) setSaid(t("notes.compile.started"));
  };
  const root = notes.library.root;
  const change = async (next: string) => {
    setError(null);
    const answer = (await api.op("note.library", { root: next }).catch((reason: Error) => ({ result: { error: reason.message } }))).result as { error?: string } | null;
    if (answer?.error) setError(answer.error);
    else setTyping(null);
  };
  const choose = async () => {
    const picked = await window.alfredDesktop?.pickFolder?.();
    if (picked) await change(picked);
    else if (!window.alfredDesktop?.pickFolder) setTyping(root);
  };
  const reveal = () => void fetch("/api/notes/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const submit = (event: FormEvent) => { event.preventDefault(); if (typing?.trim()) void change(typing.trim()); };
  return (
    <section className="set-group" aria-labelledby="settings-notes">
      <header className="set-group-head"><h3 id="settings-notes">{t("page.notes")}</h3></header>
      <div className="set-rows">
        <div className="set-row set-notes-folder">
          <span className="set-name">{t("notes.folder")}</span>
          <span className="set-note set-path" title={root}>{root}</span>
          {local && (
            <span className="set-end">
              <button type="button" className="set-button ghost" onClick={reveal}>{t("notes.reveal")}</button>
              <button type="button" className="set-button" onClick={() => void choose()}>{t("notes.folder.change")}</button>
            </span>
          )}
        </div>
        {typing !== null && (
          <form className="set-row" onSubmit={submit}>
            <label className="set-name" htmlFor="notes-folder">{t("notes.folder.path")}</label>
            <span className="set-end">
              <input id="notes-folder" value={typing} onChange={(event) => setTyping(event.target.value)} spellCheck={false} autoComplete="off" />
              <button type="submit" className="set-button">{t("settings.save")}</button>
            </span>
          </form>
        )}
        <p className="set-note" role={error ? "alert" : undefined}>{error ?? t("notes.folder.note")}</p>
        <div className="set-row">
          <span className="set-name">{t("notes.compile")}</span>
          <span className="set-end">
            <button type="button" className="set-switch" role="switch" aria-checked={compile.enabled} aria-label={t("notes.compile")} onClick={() => void setCompile({ enabled: !compile.enabled })} />
          </span>
        </div>
        {compile.enabled && (
          <div className="set-row">
            <label className="set-name" htmlFor="notes-daily">{t("notes.compile.daily")}</label>
            <span className="set-end">
              <input id="notes-daily" type="time" value={compile.daily} onChange={(event) => { if (/^\d\d:\d\d$/.test(event.target.value)) void setCompile({ daily: event.target.value }); }} />
              <button type="button" className="set-button ghost" disabled={compile.running} onClick={() => void setCompile({ now: true })}>{t("notes.compile.now")}</button>
            </span>
          </div>
        )}
        <p className="set-note" aria-live="polite">{said ?? t("notes.compile.note")}</p>
        {compile.enabled && <p className="set-note">{t("notes.about.note")}</p>}
      </div>
    </section>
  );
}
