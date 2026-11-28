/** The notes page (docs/design/notes-two-layers.md v0.2, prototype/notes.html v5): only pages. On the left, Recent,
 * the user's pages as a tree, and the pages the assistant keeps. On the right, one page: its icon, its title (the
 * file name), its words written as they look, the pages under it and the pages that mention it. Every page has a
 * history, and a change in it can be taken back. A file changed elsewhere is never written over: the page asks. */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { HistoryEntry, NotePage, NotesSnapshot, PageDetail, Suggestion } from "@zirma/module-notes/types";
import { PAGE_ICONS } from "@zirma/module-notes/types";
import { api } from "../api.ts";
import { intlLocale, t } from "../i18n/index.ts";
import { Icon } from "../shell/icons.tsx";
import { when } from "../shell/Nav.tsx";
import { NoteEditor, type EditorHandle, type SaveState } from "./NoteEditor.tsx";
import { PageGlyph } from "./pageIcons.tsx";
import { CheatSheet } from "./CheatSheet.tsx";
import { KeptView } from "./KeptView.tsx";
import "../side-tree.css";
import "./notes.css";

type OpAnswer = { error?: string; code?: string; id?: string; ok?: boolean; reason?: string; entry?: string | null };

async function op(name: string, input: unknown): Promise<OpAnswer> {
  const response = await api.op(name as never, input);
  return (response.result ?? {}) as OpAnswer;
}

const byTime = (a: NotePage, b: NotePage) => b.mtime - a.mtime;

/** Recent's groups (prototype/notes-home.html B): which day a page was last changed, and the time or date beside it. */
type Day = "today" | "yesterday" | "earlier";
function dayOf(mtime: number, now = new Date()): { day: Day; at: string } {
  const at = new Date(mtime);
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(now) - start(at)) / 86_400_000);
  if (days <= 1) return { day: days <= 0 ? "today" : "yesterday", at: `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}` };
  return { day: "earlier", at: at.toLocaleDateString(intlLocale(), { month: "short", day: "numeric", ...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }) };
}
const DAYS: Day[] = ["today", "yesterday", "earlier"];
/** On the Mac the home node runs on, things can be shown in its Finder. */
const onThisMac = typeof location !== "undefined" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
/** Where the user dragged it among the pages beside it, then by name: pages never placed come after (notes.md 4.5). */
export const byPlace = (a: NotePage, b: NotePage) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.title.localeCompare(b.title);

const DRAG_NOTE = "application/x-zirma-note";
export type Where = "before" | "after" | "inside";
/** The tree's drag: which page is held and where it would land. Only the user's pages can be dragged. */
export interface TreeDrag {
  held: string | null;
  over: { id: string; where: Where } | null;
  start(id: string): void;
  hover(target: { id: string; where: Where } | null): void;
  drop(): void;
  end(): void;
}

function Tree({ pages, under, depth, at, open, marked, onOpen, onToggle, onAdd, drag }: {
  pages: NotePage[]; under: string | null; depth: number; at: string | null; open: ReadonlySet<string>;
  /** Pages with the assistant's suggestions waiting: a small dot. */
  marked?: ReadonlySet<string>;
  onOpen(id: string): void; onToggle(id: string): void; onAdd?(parent: string): void;
  drag?: TreeDrag;
}): ReactNode {
  const here = pages.filter((page) => page.parent === under).sort(byPlace);
  return here.map((page) => {
    const kids = pages.some((other) => other.parent === page.id);
    const expanded = open.has(page.id);
    // A page cannot go into itself or a page under it.
    const blocked = !drag?.held || drag.held === page.id || page.id.startsWith(`${drag.held}/`);
    const where = (event: React.DragEvent<HTMLElement>): Where => {
      const box = event.currentTarget.getBoundingClientRect();
      const y = (event.clientY - box.top) / box.height;
      // Below an open page with pages under it is its first place inside, so the bottom edge means inside there.
      return y < 0.28 ? "before" : y > 0.72 && !(kids && expanded) ? "after" : "inside";
    };
    const dropping = drag?.over?.id === page.id ? drag.over.where : undefined;
    return (
      <div key={page.id} role="treeitem" aria-expanded={kids ? expanded : undefined} aria-selected={at === page.id}>
        <div className="nt-node" style={{ "--d": depth } as React.CSSProperties} data-current={at === page.id || undefined}
          data-drop={dropping} data-held={drag?.held === page.id || undefined} draggable={!!drag}
          onDragStart={drag && ((event) => {
            event.dataTransfer.setData(DRAG_NOTE, page.id);
            event.dataTransfer.effectAllowed = "move";
            drag.start(page.id);
          })}
          onDragOver={drag && ((event) => {
            if (blocked || !event.dataTransfer.types.includes(DRAG_NOTE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const next = where(event);
            if (dropping !== next) drag.hover({ id: page.id, where: next });
          })}
          onDragLeave={drag && ((event) => {
            if (dropping && !event.currentTarget.contains(event.relatedTarget as Node | null)) drag.hover(null);
          })}
          onDrop={drag && ((event) => { if (blocked) return; event.preventDefault(); drag.drop(); })}
          onDragEnd={drag?.end}>
          {kids
            ? <button type="button" className="nt-tw" data-open={expanded || undefined} onClick={() => onToggle(page.id)} aria-label={t("notes.expand")}><Icon name="forward" /></button>
            : <span className="nt-tw-space" />}
          <button type="button" className="nt-node-main" onClick={() => onOpen(page.id)}>
            <PageGlyph name={page.icon} />
            <span className="nt-name">{page.title}</span>
            {marked?.has(page.id) && <span className="nt-dot" aria-label={t("notes.sug.label")} />}
          </button>
          {onAdd && <button type="button" className="nt-add" onClick={() => onAdd(page.id)} aria-label={t("notes.newSub")} title={t("notes.newSub")}><Icon name="plus" /></button>}
        </div>
        {kids && expanded && <div role="group"><Tree pages={pages} under={page.id} depth={depth + 1} at={at} open={open} marked={marked} onOpen={onOpen} onToggle={onToggle} onAdd={onAdd} drag={drag} /></div>}
      </div>
    );
  });
}

const SUMMARY: Record<string, Parameters<typeof t>[0]> = {
  "todo.done": "notes.kind.todoDone", "todo.reopened": "notes.kind.todoReopened", "line.removed": "notes.kind.lineRemoved",
  "suggestion.accepted": "notes.kind.accepted", returned: "notes.kind.returned",
};

function historyLine(entry: HistoryEntry): string {
  // The assistant says in its own words why it changed one of its pages.
  const said = entry.summary && SUMMARY[entry.summary] ? t(SUMMARY[entry.summary]) : entry.actor === "alfred" ? entry.summary || entry.extra.why || "" : "";
  switch (entry.kind) {
    case "edit": return said || t("notes.kind.edit");
    case "adopt": return t("notes.kind.adopt");
    case "create": return said || t("notes.kind.create");
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
  // A page that was open stays open when it vanishes from the library (deleted or renamed elsewhere): its words may
  // not be saved yet, and the page says what happened instead of dropping them.
  const [detail, setDetail] = useState<PageDetail | null>(null);
  const at = item && (pages.some((page) => page.id === item) || !snapshot || detail?.id === item) ? item : null;
  const gone = !!(at && detail && detail.fp !== null && snapshot && !pages.some((page) => page.id === at));
  const listed = useMemo(() => new Set((todos ?? []).filter((todo) => todo.source?.kind === "note").map((todo) => todo.source!.ref)), [todos]);
  const exists = (target: string) => {
    const name = target.toLowerCase().replace(/\.md$/, "");
    return pages.some((one) => one.id.toLowerCase() === name || one.title.toLowerCase() === name);
  };
  const [save, setSave] = useState<SaveState>({ kind: "saved" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [menu, setMenu] = useState<"more" | "icon" | "move" | null>(null);
  const [moveFilter, setMoveFilter] = useState("");
  const [sheet, setSheet] = useState<{ path: string; text: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; undo?: () => void; look?: () => void } | null>(null);
  /** The words to flash in the page being opened (from a source number on one of the assistant's pages). */
  const [flash, setFlash] = useState<{ page: string; words: string } | null>(null);
  const suggestions = useMemo(() => snapshot?.suggestions ?? [], [snapshot]);
  const marked = useMemo(() => new Set(suggestions.map((one) => one.page)), [suggestions]);
  /** The assistant's last change seen here: a newer one is told once, with Look and Undo. */
  const seenKept = useRef<string | null | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [help, setHelp] = useState(false);
  const editor = useRef<EditorHandle>(null);
  const loadedAt = useRef<number>(0);
  /** Pages made here, and those of them touched (anything typed). Made and left untouched, a page is not kept. */
  const made = useRef(new Set<string>());
  const touched = useRef(new Set<string>());
  const [choose, setChoose] = useState<{ name: string; pages: NotePage[] } | null>(null);

  const page = at ? pages.find((one) => one.id === at) ?? null : null;
  // A drop shows its order at once; the page list from the home node takes over once it has it.
  const [placed, setPlaced] = useState<{ parent: string | null; ids: string[] } | null>(null);
  useEffect(() => {
    if (placed && placed.ids.every((id, rank) => pages.find((one) => one.id === id)?.rank === rank)) setPlaced(null);
  }, [pages, placed]);
  const yours = pages.filter((one) => !one.zirma)
    .map((one) => (placed && one.parent === placed.parent && placed.ids.includes(one.id) ? { ...one, rank: placed.ids.indexOf(one.id) } : one));
  const kept = pages.filter((one) => one.zirma);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const kept = snapshot?.kept;
    if (!snapshot) return;
    if (seenKept.current === undefined) { seenKept.current = kept?.entry ?? null; return; }
    if (!kept || kept.entry === seenKept.current) return;
    seenKept.current = kept.entry;
    // Only a change of the last few minutes: an old one is in the page's history.
    if (Date.now() - Date.parse(kept.at) > 5 * 60_000) return;
    const name = kept.page.split("/").pop()!;
    setToast({
      text: t("notes.kept.updated", { title: name }),
      look: () => void openPage(kept.page),
      undo: async () => {
        const answer = await op("note.undo", { entry: kept.entry });
        if (answer.ok === false) setToast({ text: t(UNDO_WHY[answer.reason ?? "changed"] ?? "notes.undo.changed") });
        else if (at === kept.page) await reload(kept.page).catch(() => {});
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.kept?.entry]);

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
    return () => {
      live = false;
      // Leaving a page made here and never touched: it is not kept (the home node checks it is as it was made).
      if (made.current.delete(at) && !touched.current.has(at)) void op("note.discard", { id: at });
    };
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

  const openPage = async (id: string | null, words?: string) => {
    await editor.current?.flush();
    setFlash(id && words ? { page: id, words } : null);
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

  const madeHere = made;
  const newPage = async (parent: string | null, text?: string, name?: string) => {
    await editor.current?.flush();
    const made = await op("note.create", { parent, title: name ?? t("notes.untitled") });
    if (!made.id) { setToast({ text: made.error ?? t("notes.failed") }); return; }
    if (!text) madeHere.current.add(made.id);
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
    // A file name cannot hold some characters: say so when the title had any, instead of changing it quietly.
    const became = moved.id.split("/").pop()!;
    if (became !== next) { setTitle(became); setToast({ text: t("notes.titleCleaned", { title: became }) }); }
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

  /** Moves the page (with the pages under it) under another page, or to the top. Links that would lose it follow. */
  const move = async (parent: string | null) => {
    if (!detail) return;
    setMenu(null);
    await editor.current?.flush();
    const moved = await op("note.move", { id: detail.id, parent });
    if (!moved.id) { setToast({ text: moved.code === "exists" ? t("notes.renameExists") : moved.error ?? t("notes.failed") }); return; }
    setToast({ text: parent ? t("notes.moved", { to: parent.split("/").pop()! }) : t("notes.movedTop") });
    if (parent) setOpen((was) => new Set(was).add(parent));
    go("note.list", moved.id);
  };

  const showMarkdown = async () => {
    if (!detail) return;
    setMenu(null);
    await editor.current?.flush();
    const found = await api.query<PageDetail>("note.page", { id: detail.id });
    setSheet({ path: `${snapshot?.library.root ?? ""}/${detail.id}.md`, text: found.text });
  };

  /** The user's yes or no to one of the assistant's suggestions. A yes can be taken back from the toast. */
  const decide = async (suggestion: Suggestion, accept: boolean) => {
    await editor.current?.flush();
    const answer = await op("note.suggestion", { id: suggestion.id, accept });
    if (answer.ok === false) setToast({ text: t("notes.sug.stale") });
    else if (accept) setToast({ text: t("notes.sug.done"), ...(answer.entry ? { undo: async () => { await op("note.undo", { entry: answer.entry }); if (detail) await reload(answer.id ?? detail.id).catch(() => {}); } } : {}) });
    if (answer.ok && accept && suggestion.kind === "move" && answer.id && answer.id !== detail?.id) { go("note.list", answer.id); return; }
    if (detail) await reload(detail.id).catch(() => {});
  };

  const rejectLine = async (index: number, words: string) => {
    if (!detail) return;
    const answer = await op("note.reject", { id: detail.id, index, words });
    if (answer.ok === false) setToast({ text: t("notes.undo.changed") });
    else setToast({ text: t("notes.kept.removed"), ...(answer.entry ? { undo: async () => { await op("note.undo", { entry: answer.entry }); await reload(detail.id).catch(() => {}); } } : {}) });
    await reload(detail.id).catch(() => {});
  };

  const adopt = async () => {
    if (!detail) return;
    setMenu(null);
    const answer = await op("note.adopt", { id: detail.id });
    if (!answer.id) { setToast({ text: answer.error ?? t("notes.failed") }); return; }
    setToast({ text: t("notes.kept.adopted", { title: detail.title }), ...(answer.entry ? { undo: async () => { await op("note.undo", { entry: answer.entry }); go("note.list", detail.id); } } : {}) });
    go("note.list", answer.id);
  };

  const giveBack = async () => {
    if (!detail) return;
    const answer = await op("note.return", { id: detail.id });
    if (answer.ok === false) { setToast({ text: answer.error ?? t("notes.failed") }); return; }
    setToast({ text: t("notes.kept.returned") });
    if (answer.id) await reload(detail.id).catch(() => {}); else go("note.list");
  };

  const toggle = (id: string) => setOpen((was) => { const next = new Set(was); if (!next.delete(id)) next.add(id); return next; });

  // Dragging in the tree (notes.md 4.5): a page dropped on another's top or bottom edge goes before or after it, on its
  // middle inside it. Under another parent it moves (its file and the pages under it, links following), then takes
  // its place there.
  const [held, setHeld] = useState<string | null>(null);
  const [over, setOver] = useState<TreeDrag["over"]>(null);
  const dropPage = async () => {
    const id = held, target = over;
    setHeld(null);
    setOver(null);
    const page = pages.find((one) => one.id === id), onto = pages.find((one) => one.id === target?.id);
    if (!id || !target || !page || !onto) return;
    const parent = target.where === "inside" ? onto.id : onto.parent;
    if (target.where === "inside" && parent === page.parent) return;
    const siblings = yours.filter((one) => one.parent === parent && one.id !== id).sort(byPlace).map((one) => one.id);
    let now = id;
    if (parent !== page.parent) {
      const opened = !!at && (at === id || at.startsWith(`${id}/`));
      if (opened) await editor.current?.flush();
      const moved = await op("note.move", { id, parent });
      if (!moved.id) { setToast({ text: moved.code === "exists" ? t("notes.renameExists") : moved.error ?? t("notes.failed") }); return; }
      now = moved.id;
      setToast({ text: parent ? t("notes.moved", { to: parent.split("/").pop()! }) : t("notes.movedTop") });
      if (opened) go("note.list", now + at!.slice(id.length));
    }
    if (target.where === "inside") { setOpen((was) => new Set(was).add(onto.id)); return; }
    siblings.splice(siblings.indexOf(onto.id) + (target.where === "after" ? 1 : 0), 0, now);
    setPlaced({ parent, ids: siblings });
    const answer = await op("note.order", { parent, ids: siblings });
    if (answer.error) { setPlaced(null); setToast({ text: answer.error }); }
  };
  const drag: TreeDrag = {
    held, over,
    start: setHeld,
    hover: setOver,
    drop: () => void dropPage(),
    end: () => { setHeld(null); setOver(null); },
  };
  const tree = (
    <div className="nt-side-scroll" role="tree">
          <div className="nt-node" data-current={!at || undefined}>
            <span className="nt-tw-space" />
            <button type="button" className="nt-node-main" onClick={() => void openPage(null)}><Icon name="clock" /><span className="nt-name">{t("notes.recent")}</span></button>
          </div>
          <div className="nt-label">{t("notes.yours")}</div>
          {yours.length ? <Tree pages={yours} under={null} depth={0} at={at} open={open} marked={marked} onOpen={(id) => void openPage(id)} onToggle={toggle} onAdd={(parent) => void newPage(parent)} drag={drag} />
            : <p className="nt-hint">{t("notes.empty")}</p>}
          <div className="nt-label"><Icon name="alfred" />{t("notes.zirma")}</div>
          {kept.length ? <Tree pages={kept} under={null} depth={0} at={at} open={open} marked={marked} onOpen={(id) => void openPage(id)} onToggle={toggle} />
            : <p className="nt-hint">{t("notes.zirma.empty")}</p>}
        </div>
  );
  // Up top, only the pages above this one: the page's own name is its title just below.
  const crumbs = at ? at.split("/").slice(0, -1) : [];
  const kids = page ? pages.filter((one) => one.parent === page.id).sort(byPlace) : [];

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
        {/* The bar over the page spans the page's column, so its buttons sit at the words' right edge, not the window's. */}
        <div className="nt-top"><div className="nt-top-in">
          {!side && <button type="button" className="nt-ib nt-only-narrow" onClick={() => setDrawer(true)} aria-label={t("notes.pages")}><Icon name="rail" /></button>}
          <div className="nt-crumbs">
            {crumbs.map((part, i) => {
              const id = crumbs.slice(0, i + 1).join("/");
              const one = pages.find((p) => p.id === id);
              return <span key={id} className="nt-crumb">{i > 0 && <span className="nt-sl">/</span>}<button type="button" onClick={() => void openPage(id)}><PageGlyph name={one?.icon} size={14} /><span>{part === "zirma_notes" ? t("notes.zirma") : part}</span></button></span>;
            })}
          </div>
          {at && <span className="nt-status" aria-live="polite">{save.kind === "saving" ? t("notes.saving") : ""}</span>}
          {at && <button type="button" className="nt-ib" onClick={() => setHistoryOpen((was) => !was)} aria-label={t("notes.history")} title={t("notes.history")} aria-pressed={historyOpen}><Icon name="history" /></button>}
          {at && <div className="nt-menu-wrap">
            <button type="button" className="nt-ib" onClick={() => setMenu(menu === "more" ? null : "more")} aria-label={t("notes.more")} aria-expanded={menu === "more"}><Icon name="more" /></button>
            {menu === "more" && <div className="nt-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => void showMarkdown()}>{t("notes.markdown")}</button>
              {page && !page.zirma && <button type="button" role="menuitem" className="nt-help-item" onClick={() => { setMenu(null); setHelp(true); }}>{t("notes.help.open")}</button>}
              {page && !page.zirma && <button type="button" role="menuitem" onClick={() => { setMenu(null); void newPage(page.id); }}>{t("notes.newSub")}</button>}
              {page && !page.zirma && page.file && <button type="button" role="menuitem" onClick={() => setMenu("icon")}>{detail?.icon ? t("notes.icon.change") : t("notes.icon.add")}</button>}
              {page && !page.zirma && <button type="button" role="menuitem" onClick={() => { setMoveFilter(""); setMenu("move"); }}>{t("notes.moveTo")}</button>}
              {onThisMac && <button type="button" role="menuitem" onClick={() => { setMenu(null); void fetch("/api/notes/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: at }) }); }}>{t("notes.reveal")}</button>}
              {page?.zirma && page.file && <button type="button" role="menuitem" onClick={() => void adopt()}>{t("notes.kept.adopt")}</button>}
              {page?.file !== false && page && <button type="button" role="menuitem" className="nt-bad" onClick={() => void remove()}>{t("notes.delete")}</button>}
            </div>}
            {menu === "icon" && detail && (
              <div className="nt-menu nt-icons" role="menu" aria-label={t("notes.icon.change")}>
                {PAGE_ICONS.map((name) => <button type="button" key={name} role="menuitemradio" aria-checked={detail.icon === name} aria-label={name} title={name} onClick={() => void setIcon(name)}><PageGlyph name={name} size={18} /></button>)}
                {detail.icon && <button type="button" className="nt-icons-off" onClick={() => void setIcon(null)}>{t("notes.icon.remove")}</button>}
              </div>
            )}
            {menu === "move" && page && (
              <div className="nt-menu nt-move" role="dialog" aria-label={t("notes.moveTo")}>
                <input autoFocus value={moveFilter} placeholder={t("notes.moveFilter")} aria-label={t("notes.moveFilter")} onChange={(event) => setMoveFilter(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") setMenu(null); }} />
                <div className="nt-move-list">
                  {page.parent !== null && !moveFilter && <button type="button" onClick={() => void move(null)}><Icon name="home" /><span>{t("notes.moveTop")}</span></button>}
                  {yours.filter((one) => one.id !== page.id && !one.id.startsWith(`${page.id}/`) && one.id !== page.parent && one.id.toLowerCase().includes(moveFilter.trim().toLowerCase()))
                    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 50).map((one) => (
                      <button type="button" key={one.id} onClick={() => void move(one.id)}><PageGlyph name={one.icon} /><span>{one.id}</span></button>
                    ))}
                </div>
              </div>
            )}
          </div>}
        </div></div>
        {snapshot?.library.error && <p className="nt-banner">{t("notes.libraryMissing", { root: snapshot.library.root })}</p>}
        <div className="nt-scroll">
          {!at && (
            <div className="nt-doc-wrap">
              <div className="nt-recent-head">
                <h1 className="nt-title-static">{t("notes.recent")}</h1>
                {/* The tree beside it has a New page row; folded into the drawer, the page needs its own. */}
                {pages.length > 0 && !side && <button type="button" className="nt-btn nt-only-narrow" onClick={() => void newPage(null)}><Icon name="plus" />{t("notes.new")}</button>}
              </div>
              {suggestions.length > 0 && (
                <button type="button" className="nt-sug-count" onClick={() => void openPage(suggestions[0].page)}>
                  <span className="nt-dot" />{t("notes.sug.count", { n: suggestions.length })}
                </button>
              )}
              {snapshot?.compile?.running && <p className="nt-hint nt-running"><Icon name="alfred" />{t("notes.kept.running")}</p>}
              {/* One line a page, grouped by day: the page it is in before its name (the tree keeps the shape). */}
              {pages.length ? <div className="nt-recent">{DAYS.map((day) => {
                const rows = [...pages].filter((one) => one.file).sort(byTime).map((one) => ({ one, ...dayOf(one.mtime) })).filter((row) => row.day === day);
                return rows.length > 0 && <section key={day} className="nt-day" aria-label={t(`notes.day.${day}`)}>
                  <h3>{t(`notes.day.${day}`)}</h3>
                  {rows.map(({ one, at: time }) => {
                    const above = one.id.split("/").slice(0, -1).filter((part, i) => !(i === 0 && part === "zirma_notes"));
                    return (
                      <button type="button" key={one.id} className="nt-row" onClick={() => void openPage(one.id)}>
                        <PageGlyph name={one.icon} />
                        <span className="nt-row-name">{above.length > 0 && <span className="nt-row-path">{above.map((part) => <Fragment key={part}>{part}<i>/</i></Fragment>)}</span>}{one.title}</span>
                        {one.zirma && <span className="nt-tag">{t("notes.tag")}</span>}
                        <span className="nt-row-first">{one.first}</span>
                        <span className="nt-row-when">{time}</span>
                      </button>
                    );
                  })}
                </section>;
              })}</div> : <div className="nt-empty"><p>{t("notes.empty")}</p><button type="button" className="nt-btn nt-pri" onClick={() => void newPage(null)}><Icon name="plus" />{t("notes.new")}</button></div>}
            </div>
          )}
          {at && detail && (
            <div className="nt-doc-wrap">
              {/* The page's icon stands beside its title (and its name in the tree); a click on it changes it. The pages under
                  it follow straight after: part of what the page is, not an appendix at its end. */}
              <div className="nt-head">
                <div className="nt-head-row">
                  {detail.icon && (detail.zirma
                    ? <span className="nt-head-icon"><PageGlyph name={detail.icon} size={26} /></span>
                    : <button type="button" className="nt-head-icon" onClick={() => setMenu("icon")} aria-label={t("notes.icon.change")} title={t("notes.icon.change")}><PageGlyph name={detail.icon} size={26} /></button>)}
                  {detail.zirma
                    ? <h1 className="nt-title-static">{detail.title}</h1>
                    : <input className="nt-title" value={title} aria-label={t("notes.title")} placeholder={t("notes.untitled")} maxLength={120}
                      onChange={(event) => { touched.current.add(detail.id); setTitle(event.target.value); }} onBlur={() => void rename()}
                      onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); (event.target as HTMLInputElement).blur(); } }} />}
                </div>
                {detail.zirma && !detail.kept && <p className="nt-meta"><Icon name="alfred" />{t("notes.readonly")}</p>}
                {kids.length > 0 && <div className="nt-kids" role="group" aria-label={t("notes.subpages")}>{kids.map((one) => (
                  <button type="button" key={one.id} className="nt-kid" onClick={() => void openPage(one.id)}><PageGlyph name={one.icon} size={15} /><span>{one.title}</span></button>
                ))}</div>}
              </div>
              {gone && save.kind !== "changed" && (
                <div className="nt-banner" role="alert">
                  <span>{t("notes.goneElsewhere")}</span>
                  <button type="button" className="nt-btn nt-pri" onClick={() => void newPage(null, editor.current?.markdown(), detail.title)}>{t("notes.keepMine")}</button>
                  <button type="button" className="nt-btn" onClick={() => void openPage(null)}>{t("notes.recent")}</button>
                </div>
              )}
              {choose && (
                <div className="nt-banner nt-choose" role="dialog" aria-label={t("notes.choose", { name: choose.name, n: choose.pages.length })}>
                  <span>{t("notes.choose", { name: choose.name, n: choose.pages.length })}</span>
                  {choose.pages.map((one) => <button type="button" key={one.id} className="nt-btn" onClick={() => { setChoose(null); void openPage(one.id); }}>{one.id}</button>)}
                  <button type="button" className="nt-ib" onClick={() => setChoose(null)} aria-label={t("common.close")}><Icon name="close" /></button>
                </div>
              )}
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
              {!detail.zirma && (detail.suggestions ?? []).filter((one) => one.kind === "move").map((one) => (
                <div key={one.id} className="nt-sug nt-sug-card nt-sug-move" role="group" aria-label={t("notes.sug.label")}>
                  <p className="nt-sug-fact">{one.under ? t("notes.sug.move", { to: one.under.split("/").pop()! }) : t("notes.sug.moveTop")}</p>
                  <p className="nt-sug-why">{one.reason}</p>
                  <div className="nt-sug-acts">
                    <button type="button" className="nt-btn" onClick={() => void decide(one, false)}>{t("notes.sug.no")}</button>
                    <button type="button" className="nt-btn nt-pri" onClick={() => void decide(one, true)}>{t("notes.sug.yes")}</button>
                  </div>
                </div>
              ))}
              {detail.zirma && detail.kept ? (
                <KeptView detail={detail} onSource={(id, words) => void openPage(id, words)} onReject={(index, words) => void rejectLine(index, words)}
                  onAdopt={() => void adopt()} onReturn={() => void giveBack()} onDecide={(one, accept) => void decide(one, accept)} />
              ) : <NoteEditor key={`${detail.library}:${detail.id}`} detail={detail} readOnly={detail.zirma} handle={editor} onState={setSave}
                flash={flash?.page === detail.id ? flash.words : null}
                suggestions={detail.zirma ? undefined : (detail.suggestions ?? []).filter((one) => one.kind === "edit")}
                onDecide={(one, accept) => void decide(one, accept)}
                onEdit={() => touched.current.add(detail.id)}
                onSubpage={async () => {
                  const made = await op("note.create", { parent: detail.id, title: t("notes.untitled") });
                  if (!made.id) { setToast({ text: made.error ?? t("notes.failed") }); return null; }
                  setOpen((was) => new Set(was).add(detail.id));
                  return made.id;
                }}
                exists={exists} focus={focus} onError={(message) => setToast({ text: message })}
                tasks={{
                  listed,
                  put: (ref, words) => {
                    void api.op("todo.add", { title: words.slice(0, 500), source: { kind: "note", ref, label: detail.title } })
                      .then(() => setToast({ text: t("notes.putInTodo") }), (error: Error) => setToast({ text: error.message }));
                  },
                }}
                onLink={(target) => {
                  const said = target.split(/[#^]/)[0].trim(), name = said.toLowerCase();
                  const exact = pages.find((one) => one.id.toLowerCase() === name);
                  if (exact) { void openPage(exact.id); return; }
                  const named = pages.filter((one) => one.title.toLowerCase() === name);
                  // Two pages of that name: the one in this page's folder, as the index takes it; else the user picks.
                  const here = named.filter((one) => one.parent === (detail.parent ?? null));
                  if (named.length === 1 || here.length === 1) void openPage((named.length === 1 ? named[0] : here[0]).id);
                  else if (named.length > 1) setChoose({ name: said, pages: named });
                  else void newPage(null, undefined, said);
                }} />}
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
        {/* How to write, from a quiet corner of a page you can write in. */}
        {page && !page.zirma && <button type="button" className="nt-help-btn" onClick={() => setHelp((was) => !was)} aria-expanded={help} aria-label={t("notes.help.open")} title={t("notes.help.open")}>?</button>}
        {help && page && !page.zirma && <CheatSheet onClose={() => setHelp(false)} />}
        {toast && (
          <div className="nt-toast" role="status">
            <span>{toast.text}</span>
            {toast.look && <button type="button" onClick={() => { const look = toast.look!; setToast(null); look(); }}>{t("notes.kept.look")}</button>}
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
