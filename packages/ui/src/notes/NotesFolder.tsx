/** Where the notes are kept, in Settings (notes.md 4.1): one line, the folder, and on the Mac the home node runs on, a
 * way to show it in the Finder and to choose another. Choosing another moves nothing: the old folder stays as it is,
 * and the notes are read from the new one. */
import { useState, type FormEvent } from "react";
import type { StateResponse } from "@zirma/protocol";
import { api } from "../api.ts";
import { t } from "../i18n/index.ts";
import { snapshotOf } from "../modules.ts";

export function NotesFolder({ state, local }: { state: StateResponse; local: boolean }) {
  const notes = snapshotOf(state, "note");
  const [typing, setTyping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!notes) return null;
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
      </div>
    </section>
  );
}
