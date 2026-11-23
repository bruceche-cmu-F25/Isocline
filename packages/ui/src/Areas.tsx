/** Settings → General → Areas: the parts of life todos and link topics belong to, the user's own list
 * (docs/design/user-defined.md §2). One row each: its colour, its name (edited in place), up and down, remove. Removing
 * one that has things in it says how many, and where they go: to no area, or to another.
 */
import { useState, type FormEvent } from "react";
import type { Area, StateResponse } from "@alfred/protocol";
import { api } from "./api.ts";
import { t } from "./i18n/index.ts";
import { Icon } from "./shell/icons.tsx";
import { Select } from "./shell/Select.tsx";
import type { LinksSnapshot } from "@alfred/module-links/types";
import type { TodoSnapshot } from "@alfred/module-todo/types";

/** The colour slots an area can take (core AREA_COLOURS), gray last. */
const COLOURS = ["blue", "green", "violet", "orange", "teal", "yellow", "pink", "gray"] as const;

export function Areas({ state }: { state: StateResponse }) {
  const areas = state.areas ?? [];
  const todos = (state.modules.todo as TodoSnapshot | undefined)?.todos ?? [];
  const topics = (state.modules.link as LinksSnapshot | undefined)?.topics ?? [];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [painting, setPainting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; moveTo: string } | null>(null);
  const [fresh, setFresh] = useState("");

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await work(); return true; } catch (reason) { setError((reason as Error).message); return false; } finally { setBusy(false); }
  };
  const rename = (area: Area) => {
    const name = (draft[area.id] ?? area.name).trim();
    setDraft(({ [area.id]: _, ...rest }) => rest);
    if (name && name !== area.name) void act(() => api.updateArea(area.id, { name }));
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (fresh.trim() && await act(() => api.addArea(fresh.trim()))) setFresh("");
  };
  const inArea = (id: string) => {
    const counts = { todos: todos.filter((todo) => todo.area === id && !todo.archivedAt).length, topics: topics.filter((topic) => topic.area === id).length };
    const said = [counts.todos ? t("areas.todos", { n: counts.todos }) : "", counts.topics ? t("areas.topics", { n: counts.topics }) : ""].filter(Boolean).join(" · ");
    return { ...counts, said };
  };

  return (
    <section className="set-section areas" aria-busy={busy}>
      <h2>{t("areas.title")}</h2>
      <p className="areas-note">{t("areas.note")}</p>
      {error && <p className="problem small" role="alert">{error}</p>}
      <ul className="set-rows area-rows">
        {areas.map((area, index) => {
          const held = inArea(area.id);
          const asking = removing?.id === area.id;
          return (
            <li key={area.id} className="area-row" data-k={area.k}>
              <div className="area-line">
                <button type="button" className="area-dot" aria-label={t("areas.colour", { name: area.name })} aria-expanded={painting === area.id}
                  onClick={() => setPainting(painting === area.id ? null : area.id)} disabled={busy} />
                <input className="area-name" value={draft[area.id] ?? area.name} maxLength={40} aria-label={t("areas.name")} disabled={busy}
                  onChange={(event) => setDraft((current) => ({ ...current, [area.id]: event.target.value }))}
                  onBlur={() => rename(area)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(({ [area.id]: _, ...rest }) => rest); } }} />
                <span className="area-count">{held.said}</span>
                <span className="area-tools">
                  <button type="button" className="area-tool" aria-label={t("areas.up", { name: area.name })} disabled={busy || index === 0}
                    onClick={() => void act(() => api.moveArea(area.id, index - 1))}><span className="flip"><Icon name="down" /></span></button>
                  <button type="button" className="area-tool" aria-label={t("areas.down", { name: area.name })} disabled={busy || index === areas.length - 1}
                    onClick={() => void act(() => api.moveArea(area.id, index + 1))}><Icon name="down" /></button>
                  <button type="button" className="area-tool" aria-label={t("areas.remove", { name: area.name })} disabled={busy}
                    onClick={() => (held.todos || held.topics ? setRemoving(asking ? null : { id: area.id, moveTo: "" }) : void act(() => api.removeArea(area.id, null)))}><Icon name="trash" /></button>
                </span>
              </div>
              {painting === area.id && (
                <div className="area-swatches" role="radiogroup" aria-label={t("areas.colour", { name: area.name })}>
                  {COLOURS.map((k) => (
                    <button type="button" key={k} data-k={k} className="area-dot" role="radio" aria-checked={area.k === k} aria-label={t(`areas.k.${k}`)} disabled={busy}
                      onClick={() => { setPainting(null); if (k !== area.k) void act(() => api.updateArea(area.id, { k })); }} />
                  ))}
                </div>
              )}
              {asking && (
                <div className="area-remove">
                  <span>{t("areas.removeWhere", { what: held.said })}</span>
                  <Select className="tag field-select" label={t("areas.moveTo")} value={removing.moveTo} disabled={busy}
                    onChange={(moveTo) => setRemoving({ id: area.id, moveTo })}
                    options={[{ value: "", label: t("areas.toNone") }, ...areas.filter((other) => other.id !== area.id).map((other) => ({ value: other.id, label: other.name }))]} />
                  <button type="button" className="set-button" disabled={busy}
                    onClick={() => void act(() => api.removeArea(area.id, removing.moveTo || null)).then((done) => { if (done) setRemoving(null); })}>{t("areas.removeConfirm")}</button>
                  <button type="button" className="set-button ghost" disabled={busy} onClick={() => setRemoving(null)}>{t("common.cancel")}</button>
                </div>
              )}
            </li>
          );
        })}
        <li className="area-row">
          <form className="area-line" onSubmit={add}>
            <span className="area-dot" data-k="gray" aria-hidden />
            <input className="area-name" value={fresh} maxLength={40} placeholder={t("areas.new")} aria-label={t("areas.new")} disabled={busy}
              onChange={(event) => setFresh(event.target.value)} />
            <span className="area-tools">
              <button type="submit" className="set-button" disabled={busy || !fresh.trim()}>{t("areas.add")}</button>
            </span>
          </form>
        </li>
      </ul>
    </section>
  );
}
