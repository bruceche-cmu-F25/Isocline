/** Settings → General → Preferences: what the user has said about how they like things (core preferences.ts;
 * ARCHITECTURE.md §8's USER.md). Isocline reads every line at the start of each run. A line Isocline wrote down from
 * something the user said is marked so; every line is the user's to change or remove, in place.
 */
import { useState, type FormEvent } from "react";
import type { Preference, StateResponse } from "@isocline/protocol";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";
import { Icon } from "./shell/icons.tsx";

const MAX = 300;

export function Preferences({ state }: { state: StateResponse }) {
  const preferences = state.preferences ?? [];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [fresh, setFresh] = useState("");

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await work(); return true; } catch (reason) { setError((reason as Error).message); return false; } finally { setBusy(false); }
  };
  const save = (preference: Preference) => {
    const text = (draft[preference.id] ?? preference.text).trim();
    setDraft(({ [preference.id]: _, ...rest }) => rest);
    if (!text) void act(() => api.removePreference(preference.id));
    else if (text !== preference.text) void act(() => api.updatePreference(preference.id, text));
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (fresh.trim() && await act(() => api.addPreference(fresh.trim()))) setFresh("");
  };
  return (
    <section className="set-section areas preferences" aria-busy={busy}>
      <h2>{t("prefs.title")}</h2>
      <p className="areas-note">{t("prefs.note")}</p>
      {error && <p className="problem small" role="alert">{error}</p>}
      <ul className="set-rows area-rows">
        {preferences.map((preference) => (
          <li key={preference.id} className="area-row">
            <div className="area-line pref-line">
              <textarea className="area-name pref-text" rows={1} value={draft[preference.id] ?? preference.text} maxLength={MAX} aria-label={t("prefs.one")} disabled={busy}
                onChange={(event) => setDraft((current) => ({ ...current, [preference.id]: event.target.value }))}
                onBlur={() => save(preference)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); }
                  if (event.key === "Escape") setDraft(({ [preference.id]: _, ...rest }) => rest);
                }} />
              <span className="area-count">{preference.by === "alfred" ? t("prefs.byIsocline") : ""}</span>
              <span className="area-tools">
                <button type="button" className="area-tool" aria-label={t("prefs.remove", { text: preference.text.slice(0, 40) })} disabled={busy}
                  onClick={() => void act(() => api.removePreference(preference.id))}><Icon name="trash" /></button>
              </span>
            </div>
          </li>
        ))}
        <li className="area-row">
          <form className="area-line pref-line" onSubmit={add}>
            <textarea className="area-name pref-text" rows={1} value={fresh} maxLength={MAX} placeholder={t("prefs.new")} aria-label={t("prefs.new")} disabled={busy}
              onChange={(event) => setFresh(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
            <span />
            <span className="area-tools">
              <button type="submit" className="set-button" disabled={busy || !fresh.trim()}>{t("areas.add")}</button>
            </span>
          </form>
        </li>
      </ul>
    </section>
  );
}
