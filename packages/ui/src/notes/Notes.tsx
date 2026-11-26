/** The notes page (docs/design/notes-two-layers.md v0.2, prototype/notes.html v5): only pages. On the left, Recent,
 * the user's pages as a tree, and the pages the assistant keeps. On the right, one page: its icon, its title (the
 * file name), its words written as they look, the pages under it and the pages that mention it. Every page has a
 * history, and a change in it can be taken back. A file changed elsewhere is never written over: the page asks. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { HistoryEntry, NotePage, NotesSnapshot, PageDetail } from "@zirma/module-notes/types";
import { PAGE_ICONS } from "@zirma/module-notes/types";
import { api } from "../api.ts";
import { t } from "../i18n/index.ts";
import { Icon } from "../shell/icons.tsx";
import { when } from "../shell/Nav.tsx";
import { NoteEditor, type EditorHandle, type SaveState } from "./NoteEditor.tsx";
import { PageGlyph } from "./pageIcons.tsx";
import "./notes.css";

type OpAnswer = { error?: string; code?: string; id?: string; ok?: boolean; reason?: string };

async function op(name: string, input: unknown): Promise<OpAnswer> {
  const response = await api.op(name as never, input);
  return (response.result ?? {}) as OpAnswer;
}

const byTime = (a: NotePage, b: NotePage) => b.mtime - a.mtime;
const byName = (a: NotePage, b: NotePage) => a.title.localeCompare(b.title);

function Tree({ pages, under, depth, at, open, onOpen, onToggle, onAdd }: {
  pages: NotePage[]; under: string | null; depth: number; at: string | null; open: ReadonlySet<string>;
  onOpen(id: string): void; onToggle(id: string): void; onAdd?(parent: string): void;
}): ReactNode {
  const here = pages.filter((page) => page.parent === under).sort(byName);
  return here.map((page) => {
    const kids = pages.some((other) => other.parent === page.id);
    const expanded = open.has(page.id);
    return (
      <div key={page.id} role="treeitem" aria-expanded={kids ? expanded : undefined} aria-selected={at === page.id}>
        <div className="nt-node" style={{ "--d": depth } as React.CSSProperties} data-current={at === page.id || undefined}>
          {kids
            ? <button type="button" className="nt-tw" data-open={expanded || undefined} onClick={() => onToggle(page.id)} aria-label={t("notes.expand")}><Icon name="forward" /></button>
            : <span className="nt-tw-space" />}
          <button type="button" className="nt-node-main" onClick={() => onOpen(page.id)}>
            <PageGlyph name={page.icon} />
            <span className="nt-name">{page.title}</span>
          </button>
          {onAdd && <button type="button" className="nt-add" onClick={() => onAdd(page.id)} aria-label={t("notes.newSub")} title={t("notes.newSub")}><Icon name="plus" /></button>}
        </div>
        {kids && expanded && <div role="group"><Tree pages={pages} under={page.id} depth={depth + 1} at={at} open={open} onOpen={onOpen} onToggle={onToggle} onAdd={onAdd} /></div>}
      </div>
    );
  });
}

function historyLine(entry: HistoryEntry): string {
  switch (entry.kind) {
    case "edit": return t("notes.kind.edit");
    case "create": return t("notes.kind.create");
    case "delete": return t("notes.kind.delete");
    case "rename": return t("notes.kind.rename", { from: (entry.extra.from ?? "").split("/").pop() ?? "", to: (entry.extra.to ?? "").split("/").pop() ?? "" });
    case "links": return t("notes.kind.links", { to: (entry.extra.to ?? "").split("/").pop() ?? "" });
  }
}

const UNDO_WHY: Record<string, Parameters<typeof t>[0]> = { changed: "notes.undo.changed", gone: "notes.undo.gone", exists: "notes.undo.exists", not_undoable: "notes.undo.changed" };

export function Notes({ snapshot, item: asked, go, side, todos }: {
  snapshot: NotesSnapshot | undefined; item: string | null; go(page: string, item?: string): void; side?: HTMLElement | null;
  /** The todo list, to show which to-dos of a page are on it. */
  todos?: ReadonlyArray<{ source?: { kind: string; ref: string } }>;
}) {
  const pages = useMemo(() => snapshot?.pages ?? [], [snapshot]);
  // The item is a page, and after `#`, one to-do on it to bring into view (from the todo list).
  const hash = asked ? asked.indexOf("#") : -1;
  const item = asked && hash !== -1 ? asked.slice(0, hash) : asked;
  const focus = asked && hash !== -1 ? asked.slice(hash + 1) : null;
  const at = item && pages.some((page) => page.id === item) ? item : item && !snapshot ? item : null;
  const listed = useMemo(() => new Set((todos ?? []).filter((todo) => todo.source?.kind === "note").map((todo) => todo.source!.ref)), [todos]);
  const exists = (target: string) => {
    const name = target.toLowerCase().replace(/\.md$/, "");
    return pages.some((one) => one.id.toLowerCase() === name || one.title.toLowerCase() === name);
  };
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [menu, setMenu] = useState<"more" | "icon" | null>(null);
  const [sheet, setSheet] = useState<{ path: string; text: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [title, setTitle] = useState("");
  const editor = useRef<EditorHandle>(null);
  const loadedAt = useRef<number>(0);

  const page = at ? pages.find((one) => one.id === at) ?? null : null;
  const yours = pages.filter((one) => !one.zirma);
  const kept = pages.filter((one) => one.zirma);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // The page's words, read when it opens.
  useEffect(() => {
    setDetail(null);
    setSave({ kind: "saved" });
    setMenu(null);
    if (!at) return;
    let live = true;
    api.query<PageDetail & { error?: string }>("note.page", { id: at }).then((found) => {
      if (!live || found.error) return;
      setDetail(found);
      setTitle(found.title);
      loadedAt.current = found.mtime;
    }).catch(() => {});
    // The way to this page is open in the tree.
    setOpen((was) => {
      const next = new Set(was);
      for (let up = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : null; up; up = up.includes("/") ? up.slice(0, up.lastIndexOf("/")) : null) next.add(up);
      return next;
    });
    return () => { live = false; };
  }, [at]);

  // Changed elsewhere (another app, an undo): taken in while nothing here is waiting to be saved.
  useEffect(() => {
    if (!at || !page || !detail || page.mtime <= loadedAt.current) return;
    loadedAt.current = page.mtime;
    api.query<PageDetail>("note.page", { id: at }).then((found) => {
      if (found.fp === editor.current?.fp() || editor.current?.dirty()) return;
      editor.current?.load(found.text, found.fp);
      setDetail(found);
    }).catch(() => {});
  }, [page?.mtime, at, detail]);

  const refreshHistory = () => { if (at) api.query<HistoryEntry[]>("note.history", { id: at }).then(setHistory).catch(() => {}); };
  useEffect(() => { if (historyOpen) refreshHistory(); }, [historyOpen, at, page?.mtime]);

  const openPage = async (id: string | null) => {
    await editor.current?.flush();
    setDrawer(false);
    setHistoryOpen(false);
    if (id) go("note.list", id); else go("note.list");
  };

  const reload = async (id: string) => {
    const found = await api.query<PageDetail>("note.page", { id });
    editor.current?.load(found.text, found.fp);
    setDetail(found);
    loadedAt.current = found.mtime;
  };

  const newPage = async (parent: string | null, text?: string, name?: string) => {
    await editor.current?.flush();
    const made = await op("note.create", { parent, title: name ?? t("notes.untitled") });
    if (!made.id) { setToast({ text: made.error ?? t("notes.failed") }); return; }
    if (text) {
      const found = await api.query<PageDetail>("note.page", { id: made.id });
      await fetch("/api/notes/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ library: found.library, id: made.id, base: found.fp, text }) });
    }
    if (parent) setOpen((was) => new Set(was).add(parent));
    go("note.list", made.id);
  };

  const rename = async () => {
    if (!detail || !page || page.zirma) return;
    const next = title.trim();
    if (!next || next === detail.title) { setTitle(detail.title); return; }
    await editor.current?.flush();
    const moved = await op("note.move", { id: detail.id, title: next });
    if (!moved.id) { setTitle(detail.title); setToast({ text: moved.code === "exists" ? t("notes.renameExists") : moved.error ?? t("notes.failed") }); return; }
    go("note.list", moved.id);
  };

  const setIcon = async (icon: string | null) => {
    if (!detail) return;
    setMenu(null);
    await editor.current?.flush();
    await op("note.icon", { id: detail.id, icon });
    await reload(detail.id);
  };

  const remove = async () => {
    if (!detail) return;
    setMenu(null);
    await editor.current?.flush();
    const id = detail.id, name = detail.title;
    const done = await op("note.delete", { id });
    if (done.error) { setToast({ text: done.error }); return; }
    go("note.list");
    setToast({
      text: t("notes.deleted", { title: name }),
      undo: async () => {
        const entries = await api.query<HistoryEntry[]>("note.history", { id });
        const entry = entries.find((one) => one.kind === "delete" && !one.undone);
        if (entry) await op("note.undo", { entry: entry.id });
        go("note.list", id);
      },
    });
  };

  const flip = async (entry: HistoryEntry) => {
    if (!detail) return;
    await editor.current?.flush();
    const answer = await op("note.undo", { entry: entry.id, redo: entry.undone });
    if (answer.ok === false) setToast({ text: t(UNDO_WHY[answer.reason ?? "changed"] ?? "notes.undo.changed") });
    if (entry.kind === "rename" && answer.ok) { go("note.list", (entry.undone ? entry.extra.to : entry.extra.from) ?? detail.id); return; }
    if (entry.kind === "create" && answer.ok && !entry.undone) { go("note.list"); return; }
    await reload(detail.id).catch(() => {});
    refreshHistory();
  };

  const showMarkdown = async () => {
    if (!detail) return;
    setMenu(null);
    await editor.current?.flush();
    const found = await api.query<PageDetail>("note.page", { id: detail.id });
    setSheet({ path: `${snapshot?.library.root ?? ""}/${detail.id}.md`, text: found.text });
  };

  const toggle = (id: string) => setOpen((was) => { const next = new Set(was); if (!next.delete(id)) next.add(id); return next; });
  const tree = (
    <div className="nt-side-scroll" role="tree">
          <div className="nt-node" data-current={!at || undefined}>
            <span className="nt-tw-space" />
            <button type="button" className="nt-node-main" onClick={() => void openPage(null)}><Icon name="clock" /><span className="nt-name">{t("notes.recent")}</span></button>
          </div>
          <div className="nt-label">{t("notes.yours")}</div>
          {yours.length ? <Tree pages={yours} under={null} depth={0} at={at} open={open} onOpen={(id) => void openPage(id)} onToggle={toggle} onAdd={(parent) => void newPage(parent)} />
            : <p className="nt-hint">{t("notes.empty")}</p>}
          <div className="nt-label"><Icon name="alfred" />{t("notes.zirma")}</div>
          {kept.length ? <Tree pages={kept} under={null} depth={0} at={at} open={open} onOpen={(id) => void openPage(id)} onToggle={toggle} />
            : <p className="nt-hint">{t("notes.zirma.empty")}</p>}
        </div>
  );
  const crumbs = at ? at.split("/") : [];
  const kids = page ? pages.filter((one) => one.parent === page.id).sort(byName) : [];

  return (
    <section className="notes" aria-label={t("page.notes")} data-drawer={drawer || undefined} data-side={side ? "app" : undefined}>
      {!side && (
        <nav className="nt-side" aria-label={t("notes.pages")}>
          <div className="nt-side-head">
            <b>{t("page.notes")}</b>
            <button type="button" className="nt-ib" onClick={() => void newPage(null)} aria-label={t("notes.new")} title={t("notes.new")}><Icon name="plus" /></button>
          </div>
          {tree}
        </nav>
      )}
      {side && createPortal(
        <nav className="nt-side nt-in-app" aria-label={t("notes.pages")}>
          <div className="nt-node nt-new-row"><span className="nt-tw-space" /><button type="button" className="nt-node-main" onClick={() => void newPage(null)}><Icon name="plus" /><span className="nt-name">{t("notes.new")}</span></button></div>
          {tree}
        </nav>,
        side,
      )}
      <button type="button" className="nt-scrim" aria-label={t("common.close")} onClick={() => setDrawer(false)} />
      <div className="nt-main">
        <div className="nt-top">
          {!side && <button type="button" className="nt-ib nt-only-narrow" onClick={() => setDrawer(true)} aria-label={t("notes.pages")}><Icon name="rail" /></button>}
          <div className="nt-crumbs">
            {!at && <span className="nt-crumb-now"><Icon name="clock" />{t("notes.recent")}</span>}
            {crumbs.map((part, i) => {
              const id = crumbs.slice(0, i + 1).join("/");
              const one = pages.find((p) => p.id === id);
              return <span key={id} className="nt-crumb">{i > 0 && <span className="nt-sl">/</span>}<button type="button" onClick={() => void openPage(id)} data-now={i === crumbs.length - 1 || undefined}><PageGlyph name={one?.icon} size={14} /><span>{part === "zirma_notes" ? t("notes.zirma") : part}</span></button></span>;
            })}
          </div>
          {at && <span className="nt-status" aria-live="polite">{save.kind === "saving" ? t("notes.saving") : ""}</span>}
          {at && <button type="button" className="nt-ib" onClick={() => setHistoryOpen((was) => !was)} aria-label={t("notes.history")} title={t("notes.history")} aria-pressed={historyOpen}><Icon name="history" /></button>}
          {at && <div className="nt-menu-wrap">
            <button type="button" className="nt-ib" onClick={() => setMenu(menu === "more" ? null : "more")} aria-label={t("notes.more")} aria-expanded={menu === "more"}><Icon name="more" /></button>
            {menu === "more" && <div className="nt-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void showMarkdown()}>{t("notes.markdown")}</button>
              {page && !page.zirma && <button type="button" role="menuitem" onClick={() => { setMenu(null); void newPage(page.id); }}>{t("notes.newSub")}</button>}
              {page && !page.zirma && <button type="button" role="menuitem" className="nt-bad" onClick={() => void remove()}>{t("notes.delete")}</button>}
            </div>}
          </div>}
        </div>
        {snapshot?.library.error && <p className="nt-banner">{t("notes.libraryMissing", { root: snapshot.library.root })}</p>}
        <div className="nt-scroll">
          {!at && (
            <div className="nt-doc-wrap">
              <h1 className="nt-title-static">{t("notes.recent")}</h1>
              {pages.length ? <div className="nt-recent">{[...pages].filter((one) => one.file).sort(byTime).map((one) => (
                <button type="button" key={one.id} className="nt-row" onClick={() => void openPage(one.id)}>
                  <PageGlyph name={one.icon} size={18} />
                  <span className="nt-row-text"><b>{one.title}</b><span>{one.first || " "}</span></span>
                  <span className="nt-row-meta">{one.zirma && <span className="nt-tag">{t("notes.tag")}</span>}<span>{when(new Date(one.mtime).toISOString())}</span></span>
                </button>
              ))}</div> : <div className="nt-empty"><p>{t("notes.empty")}</p><button type="button" className="nt-btn nt-pri" onClick={() => void newPage(null)}><Icon name="plus" />{t("notes.new")}</button></div>}
            </div>
          )}
          {at && detail && (
            <div className="nt-doc-wrap">
              <div className="nt-head">
                <div className="nt-icon-wrap">
                  {detail.icon
                    ? <button type="button" className="nt-picon" disabled={detail.zirma} onClick={() => setMenu(menu === "icon" ? null : "icon")} aria-label={t("notes.icon.change")}><PageGlyph name={detail.icon} size={38} /></button>
                    : !detail.zirma && <button type="button" className="nt-addicon" onClick={() => setMenu(menu === "icon" ? null : "icon")}><Icon name="plus" />{t("notes.icon.add")}</button>}
                  {menu === "icon" && <div className="nt-menu nt-icons" role="menu">
                    {PAGE_ICONS.map((name) => <button type="button" key={name} role="menuitemradio" aria-checked={detail.icon === name} aria-label={name} title={name} onClick={() => void setIcon(name)}><PageGlyph name={name} size={18} /></button>)}
                    {detail.icon && <button type="button" className="nt-icons-off" onClick={() => void setIcon(null)}>{t("notes.icon.remove")}</button>}
                  </div>}
                </div>
                {detail.zirma
                  ? <h1 className="nt-title-static">{detail.title}</h1>
                  : <input className="nt-title" value={title} aria-label={t("notes.title")} placeholder={t("notes.untitled")} maxLength={120}
                    onChange={(event) => setTitle(event.target.value)} onBlur={() => void rename()}
                    onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); (event.target as HTMLInputElement).blur(); } }} />}
                {detail.zirma && <p className="nt-meta"><Icon name="alfred" />{t("notes.readonly")}</p>}
              </div>
              {save.kind === "changed" && (
                <div className="nt-banner" role="alert">
                  <span>{save.current ? t("notes.changed") : t("notes.gone")}</span>
                  {save.current && <button type="button" className="nt-btn" onClick={() => { editor.current?.load(save.current!.text, save.current!.fp); }}>{t("notes.useTheirs")}</button>}
                  <button type="button" className="nt-btn nt-pri" onClick={() => void newPage(page?.parent ?? null, editor.current?.markdown(), t("notes.copy", { title: detail.title }))}>{t("notes.keepMine")}</button>
                </div>
              )}
              {(save.kind === "unsaved" || save.kind === "library") && (
                <div className="nt-banner" role="alert">
                  <span>{save.kind === "library" ? t("notes.libraryChanged") : t("notes.unsaved")}</span>
                  <button type="button" className="nt-btn nt-pri" onClick={() => void newPage(null, editor.current?.markdown(), t("notes.copy", { title: detail.title }))}>{t("notes.saveAs")}</button>
                </div>
              )}
              {save.kind === "offline" && <p className="nt-banner">{t("notes.offline")}</p>}
              <NoteEditor key={`${detail.library}:${detail.id}`} detail={detail} readOnly={detail.zirma} handle={editor} onState={setSave}
                exists={exists} focus={focus} onError={(message) => setToast({ text: message })}
                tasks={{
                  listed,
                  put: (ref, words) => {
                    void api.op("todo.add", { title: words.slice(0, 500), source: { kind: "note", ref, label: detail.title } })
                      .then(() => setToast({ text: t("notes.putInTodo") }), (error: Error) => setToast({ text: error.message }));
                  },
                }}
                onLink={(target) => {
                  const name = target.split(/[#^]/)[0].trim().toLowerCase();
                  const found = pages.find((one) => one.id.toLowerCase() === name) ?? pages.filter((one) => one.title.toLowerCase() === name).at(0);
                  if (found) void openPage(found.id);
                  else void newPage(null, undefined, target.split(/[#^]/)[0].trim());
                }} />
              {kids.length > 0 && <div className="nt-sec"><h3>{t("notes.subpages")}</h3>{kids.map((one) => (
                <button type="button" key={one.id} className="nt-link-row" onClick={() => void openPage(one.id)}><PageGlyph name={one.icon} /><span>{one.title}</span></button>
              ))}</div>}
              {detail.mentions.length > 0 && <div className="nt-sec"><h3>{t("notes.mentions")}</h3>{detail.mentions.map((one) => (
                <button type="button" key={one.id} className="nt-link-row" onClick={() => void openPage(one.id)}><PageGlyph name={one.icon} /><span>{one.title}</span>{one.zirma && <span className="nt-tag">{t("notes.tag")}</span>}</button>
              ))}</div>}
            </div>
          )}
        </div>
        {historyOpen && at && (
          <aside className="nt-history" aria-label={t("notes.history")}>
            <div className="nt-history-head"><b>{t("notes.history")}</b><button type="button" className="nt-ib" onClick={() => setHistoryOpen(false)} aria-label={t("common.close")}><Icon name="close" /></button></div>
            <div className="nt-history-list">
              {history.length ? history.map((entry) => (
                <div key={entry.id} className="nt-entry" data-undone={entry.undone || undefined}>
                  <div className="nt-entry-who"><b>{entry.actor === "alfred" ? t("notes.by.assistant") : t("notes.by.you")}</b><span>{when(entry.at)}{entry.undone ? ` · ${t("notes.undone")}` : ""}</span></div>
                  <p>{historyLine(entry)}</p>
                  {entry.lines.length > 0 && <div className="nt-lines">{entry.lines.map((line, i) => <div key={i} className={`nt-ln nt-ln-${line.k}`}>{line.text}</div>)}</div>}
                  {entry.undoable && <button type="button" className="nt-btn" onClick={() => void flip(entry)}>{entry.undone ? t("notes.redo") : t("notes.undo")}</button>}
                </div>
              )) : <p className="nt-hint">{t("notes.history.none")}</p>}
            </div>
          </aside>
        )}
        {toast && (
          <div className="nt-toast" role="status">
            <span>{toast.text}</span>
            {toast.undo && <button type="button" onClick={() => { const undo = toast.undo!; setToast(null); undo(); }}>{t("notes.undo")}</button>}
          </div>
        )}
      </div>
      {sheet && (
        <div className="nt-sheet-back" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSheet(null); }}>
          <div className="nt-sheet" role="dialog" aria-label="Markdown">
            <div className="nt-history-head"><code>{sheet.path}</code><button type="button" className="nt-ib" onClick={() => setSheet(null)} aria-label={t("common.close")}><Icon name="close" /></button></div>
            <pre>{sheet.text}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
