import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import type { Place, PlaceFolder } from "@isocline/module-links/types";
import { t } from "./i18n/index.ts";
import { LinkDeleteDialog, onDeleteKey } from "./LinkDeleteDialog.tsx";
import { SiteIcon, useOp } from "./linkControls.tsx";
import "./places.css";

type Entry = Place | PlaceFolder;
type Drop = { onto: string; side: "before" | "after" | "center" | "out" };

const isPlace = (entry: Entry): entry is Place => "url" in entry;
const parentOf = (entry: Entry) => isPlace(entry) ? entry.folderId : undefined;
const ordered = (entries: Entry[]) => entries.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

function mark(place: Place) {
  const words = place.title.trim().split(/\s+/);
  if (words.length > 1) return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join("");
  return /^[\u4e00-\u9fff]/.test(place.title) ? place.title.slice(0, 1) : place.title.slice(0, 2);
}

export function Places({ places, folders, focus, onFocused, onError }: {
  places: Place[]; folders: PlaceFolder[]; focus?: string | null; onFocused?(): void; onError(message: string | null): void;
}) {
  const { busy, run } = useOp(onError);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState<string>();
  const [selected, select] = useState<string>();
  const [deleteId, setDeleteId] = useState<string>();
  const [nameFocus, setNameFocus] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [hint, setHint] = useState<Drop>();
  const section = useRef<HTMLElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const skipClick = useRef(false);
  const entries = [...places, ...folders];
  const entryById = (id?: string) => entries.find((entry) => entry.id === id);
  const siblings = (folderId?: string) => ordered(entries.filter((entry) => parentOf(entry) === folderId));
  const folder = folders.find((item) => item.id === open);
  const active = entryById(selected);
  const deleting = entryById(deleteId);
  const peers = active ? siblings(parentOf(active)) : [];
  const index = active ? peers.findIndex((entry) => entry.id === active.id) : -1;

  useEffect(() => {
    if (!focus || !folders.some((item) => item.id === focus)) return;
    setOpen(focus);
    setAdding(false);
    select(undefined);
    section.current?.querySelector<HTMLButtonElement>(`[data-place-id="${CSS.escape(focus)}"]`)?.focus();
    onFocused?.();
  }, [focus, folders, onFocused]);

  useEffect(() => {
    if (!nameFocus || active?.id !== nameFocus || busy || !nameInput.current) return;
    nameInput.current.focus();
    nameInput.current.select();
    setNameFocus(undefined);
  }, [active?.id, nameFocus, busy]);

  const move = (entry: Entry, folderId?: string, beforeId?: string) =>
    run("link.move", { id: entry.id, ...(folderId ? { folderId } : {}), ...(beforeId ? { beforeId } : {}) }, () => select(undefined));

  const group = (entry: Place, target: Place) =>
    run("link.group", { id: entry.id, targetId: target.id, title: t("links.folder.new") }, (result) => {
      const id = (result as { folder: PlaceFolder }).folder.id;
      setOpen(id); select(id); setNameFocus(id);
    });

  const step = (by: -1 | 1) => {
    if (active) void move(active, parentOf(active), peers[index + (by < 0 ? -1 : 2)]?.id);
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim() || busy) return;
    void run("link.pin", { url: url.trim(), ...(name.trim() ? { title: name.trim() } : {}) }, () => { setUrl(""); setName(""); setAdding(false); });
  };

  function click(entry: Entry) {
    if (editing && active && isPlace(active) && active.id !== entry.id) {
      if (!isPlace(entry) && active.folderId !== entry.id) { void move(active, entry.id); return; }
      if (isPlace(entry) && !entry.folderId && !active.folderId) { void group(active, entry); return; }
    }
    if (!isPlace(entry)) {
      const closing = open === entry.id;
      setOpen(closing ? undefined : entry.id);
      select(editing && !closing ? entry.id : undefined);
    } else if (editing) {
      select(selected === entry.id ? undefined : entry.id);
    }
    setNameFocus(undefined); setAdding(false);
  }

  function hit(event: PointerEvent<HTMLButtonElement>, entry: Entry): Drop | undefined {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!target || !section.current?.contains(target)) return;
    if (target.closest("[data-root-drop]") && parentOf(entry)) return { onto: "", side: "out" };
    const button = target.closest<HTMLElement>("[data-place-id]");
    const other = entryById(button?.dataset.placeId);
    if (!button || !other || other.id === entry.id || (!isPlace(entry) && parentOf(other))) return;
    const rect = button.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const canCombine = isPlace(entry) && (!isPlace(other) ? entry.folderId !== other.id : !entry.folderId && !other.folderId);
    if (canCombine && x >= .25 && x <= .75) return { onto: other.id, side: "center" };
    return { onto: other.id, side: x < .5 ? "before" : "after" };
  }

  function drop(entry: Entry, target: Drop) {
    if (target.side === "out") { void move(entry); return; }
    const other = entryById(target.onto);
    if (!other) return;
    if (target.side === "center" && isPlace(entry)) {
      if (isPlace(other)) void group(entry, other);
      else void move(entry, other.id);
      return;
    }
    const rows = siblings(parentOf(other)).filter((peer) => peer.id !== entry.id);
    const before = target.side === "before" ? other.id : rows[rows.findIndex((peer) => peer.id === other.id) + 1]?.id;
    void move(entry, parentOf(other), before);
  }

  function start(event: PointerEvent<HTMLButtonElement>) {
    if (busy || event.button !== 0 || !event.isPrimary) return;
    skipClick.current = false;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function drag(event: PointerEvent<HTMLButtonElement>, entry: Entry) {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    const dx = event.clientX - p.x, dy = event.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < 6) return;
    p.moved = true;
    const button = event.currentTarget;
    button.dataset.dragging = "";
    button.style.setProperty("--place-dx", dx + "px");
    button.style.setProperty("--place-dy", dy + "px");
    const next = hit(event, entry);
    setHint((previous) => previous?.onto === next?.onto && previous?.side === next?.side ? previous : next);
  }

  function end(event: PointerEvent<HTMLButtonElement>, entry: Entry) {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    pointer.current = null;
    const target = p.moved && event.type === "pointerup" ? hit(event, entry) : undefined;
    const button = event.currentTarget;
    delete button.dataset.dragging;
    button.style.removeProperty("--place-dx"); button.style.removeProperty("--place-dy");
    setHint(undefined);
    if (p.moved) skipClick.current = true;
    if (target && !busy) drop(entry, target);
  }

  function tile(entry: Entry) {
    const place = isPlace(entry);
    const icon = place ? <span className="lk-tile" aria-hidden="true" data-icon={entry.icon ? true : undefined}>
      <SiteIcon key={entry.icon} icon={entry.icon} fallback={mark(entry)} />
    </span> : <span className="lk-tile lk-folder-preview" aria-hidden="true">
      {siblings(entry.id).filter(isPlace).slice(0, 9).map((member) =>
        <span key={member.id} className="lk-mini"><SiteIcon key={member.icon} icon={member.icon} fallback={mark(member)} /></span>)}
    </span>;
    const contents = <>{icon}<span className="lk-place-name">{entry.title}</span></>;
    if (!editing && place) return <a className="lk-place" key={entry.id} href={entry.url} target="_blank" rel="noreferrer noopener" title={entry.url}>{contents}</a>;
    const button = <button type="button" className="lk-place" key={entry.id} data-place-id={entry.id} disabled={busy}
      title={entry.title} aria-label={place ? entry.title : t("links.folder.label", { title: entry.title })}
      aria-expanded={place ? undefined : entry.id === open} aria-pressed={editing && place ? selected === entry.id : undefined}
      data-selected={editing && selected === entry.id || undefined} data-drop={hint?.onto === entry.id ? hint.side : undefined}
      aria-keyshortcuts={editing ? "Delete Backspace" : undefined} onKeyDown={editing ? (e) => onDeleteKey(e, () => setDeleteId(entry.id)) : undefined}
      onClick={(event) => { if (!event.detail || !skipClick.current) click(entry); skipClick.current = false; }}
      onPointerDown={editing ? start : undefined} onPointerMove={editing ? (e) => drag(e, entry) : undefined}
      onPointerUp={editing ? (e) => end(e, entry) : undefined} onPointerCancel={(e) => end(e, entry)} onLostPointerCapture={(e) => end(e, entry)}>
      {contents}
    </button>;
    if (!editing) return button;
    return <div key={entry.id} className="lk-edit-tile">
      {button}
      <button type="button" className="lk-minus" aria-label={t("links.deleteNamed", { title: entry.title })} title={t("links.remove")}
        disabled={busy} onClick={() => setDeleteId(entry.id)}><span aria-hidden="true">−</span></button>
    </div>;
  }

  return (
    <section className="lk-band lk-place-band" ref={section} aria-label={t("links.places")} onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      if (adding) {
        setAdding(false);
        addButton.current?.focus();
        return;
      }
      setOpen(undefined); select(undefined);
    }}>
      <h3>{t("links.places")}
        {/* Adding sits beside Edit, not as a tile: on a phone a tile of its own took a row of its own. */}
        {!editing && <button type="button" ref={addButton} className="lk-edit lk-add-place" onClick={() => setAdding(!adding)} aria-expanded={adding}
          aria-label={t(adding ? "common.close" : "links.place.add")} title={t(adding ? "common.close" : "links.place.add")}>{adding ? "×" : "+"}</button>}
        <button type="button" className="lk-edit" aria-pressed={editing} onClick={() => {
          setEditing(!editing); setAdding(false); select(undefined); setNameFocus(undefined);
        }}>{t(editing ? "links.done" : "links.edit")}</button>
      </h3>
      <div className="lk-places lk-organizer" data-organizing={editing || undefined}>
        {siblings().map(tile)}
        {editing && folder && <span data-root-drop="" className="lk-root-drop" data-over={hint?.side === "out" || undefined}>{t("links.folder.dropOut")}</span>}
      </div>
      {folder && <div className="lk-folder-panel" aria-label={t("links.folder.label", { title: folder.title })}>
        <header><strong>{folder.title}</strong><button type="button" className="lk-edit" onClick={() => {
          setOpen(undefined); select(undefined); section.current?.querySelector<HTMLButtonElement>(`[data-place-id="${CSS.escape(folder.id)}"]`)?.focus();
        }}>{t("links.folder.close")}</button></header>
        <div className="lk-places lk-organizer" data-organizing={editing || undefined}>{siblings(folder.id).map(tile)}</div>
      </div>}
      {editing && active && <div className="lk-place-editor" key={active.id}>
        <input ref={nameInput} defaultValue={active.title} maxLength={60} aria-label={t("links.place.name", { title: active.title })} disabled={busy}
          onBlur={(e) => { const title = e.target.value.trim(); if (title && title !== active.title) void run("link.rename", { id: active.id, title }); else e.target.value = active.title; }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }} />
        <button className="lk-btn" type="button" disabled={busy || index <= 0} aria-label={t("links.place.left", { title: active.title })} onClick={() => step(-1)}>←</button>
        <button className="lk-btn" type="button" disabled={busy || index === peers.length - 1} aria-label={t("links.place.right", { title: active.title })} onClick={() => step(1)}>→</button>
        {parentOf(active) && <button className="lk-btn" type="button" disabled={busy} onClick={() => move(active)}>{t("links.folder.out")}</button>}
      </div>}
      {deleting && <LinkDeleteDialog title={deleting.title} folder={!isPlace(deleting)} onCancel={() => setDeleteId(undefined)}
        onDelete={() => {
          setDeleteId(undefined);
          void run(isPlace(deleting) ? "link.remove" : "link.ungroup", { id: deleting.id }, () => {
            if (selected === deleting.id) select(undefined);
            if (open === deleting.id) setOpen(undefined);
          });
        }} />}
      {editing && <p className="lk-organize-tip">{t(active && isPlace(active) && !active.folderId ? "links.folder.pick" : "links.folder.drag")}</p>}
      {adding && !editing && <form className="lk-add" onSubmit={add}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("links.place.url")} aria-label={t("links.place.url")} autoFocus spellCheck={false} maxLength={2000} />
        <input className="short" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("links.place.nameNew")} aria-label={t("links.place.nameNew")} maxLength={60} />
        <button type="submit" disabled={!url.trim() || busy}>{t("links.pin")}</button>
      </form>}
    </section>
  );
}
