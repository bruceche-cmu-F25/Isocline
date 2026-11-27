/** Writing blocks as you would in Notion (notes.md 4.5, research 3.2): a `/` menu to make a block, a handle beside
 * each block to drag it or add one under it, a small bar over selected words, and tables and callouts edited in place.
 * The file stays plain Markdown: these only change the blocks the editor holds. */
import { useEffect, useRef, useState } from "react";
import { setBlockType, toggleMark } from "prosemirror-commands";
import type { Node as PmNode, NodeType } from "prosemirror-model";
import { NodeSelection, TextSelection, type Command, type EditorState } from "prosemirror-state";
import type { EditorView, NodeView } from "prosemirror-view";
import { schema } from "./schema.ts";
import { t, type Key } from "../i18n/index.ts";

/* ── Tables ── */

/** Where the cursor is in a table: the table's position, and the row and column. */
export function cellAt(state: EditorState): { table: number; node: PmNode; row: number; col: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === schema.nodes.table_cell) {
      return { table: $from.before(depth - 2), node: $from.node(depth - 2), row: $from.index(depth - 2), col: $from.index(depth - 1) };
    }
  }
  return null;
}

/** The position inside a cell (row, col) of the table at `table`. */
function cellStart(doc: PmNode, table: number, row: number, col: number): number {
  const node = doc.nodeAt(table)!;
  let pos = table + 1;
  for (let r = 0; r < row; r++) pos += node.child(r).nodeSize;
  pos += 1;
  for (let c = 0; c < col; c++) pos += node.child(row).child(c).nodeSize;
  return pos + 1;
}

const emptyRow = (width: number) => schema.nodes.table_row.create(null, Array.from({ length: width }, () => schema.nodes.table_cell.create()));

function rebuild(state: EditorState, at: { table: number; node: PmNode }, rows: PmNode[][], align: unknown[]): import("prosemirror-state").Transaction {
  const table = schema.nodes.table.create({ align }, rows.map((cells) => schema.nodes.table_row.create(null, cells)));
  return state.tr.replaceWith(at.table, at.table + at.node.nodeSize, table);
}

const cellsOf = (table: PmNode) => { const rows: PmNode[][] = []; table.forEach((row) => { const cells: PmNode[] = []; row.forEach((cell) => cells.push(cell)); rows.push(cells); }); return rows; };

export const tableCommands = {
  /** Tab: the next cell; past the last, a new row. Shift-Tab: the cell before. */
  move(by: 1 | -1): Command {
    return (state, dispatch) => {
      const at = cellAt(state);
      if (!at) return false;
      const width = at.node.child(0).childCount, height = at.node.childCount;
      let row = at.row, col = at.col + by;
      if (col >= width) { col = 0; row++; }
      if (col < 0) { col = width - 1; row--; }
      if (row < 0) return true;
      if (!dispatch) return true;
      let tr = state.tr;
      if (row >= height) tr = tr.insert(at.table + at.node.nodeSize - 1, emptyRow(width));
      dispatch(tr.setSelection(TextSelection.create(tr.doc, cellStart(tr.doc, at.table, row, col))).scrollIntoView());
      return true;
    };
  },
  /** Enter: the cell below; past the last row, a new row. */
  down: ((state, dispatch) => {
    const at = cellAt(state);
    if (!at) return false;
    if (!dispatch) return true;
    let tr = state.tr;
    if (at.row + 1 >= at.node.childCount) tr = tr.insert(at.table + at.node.nodeSize - 1, emptyRow(at.node.child(0).childCount));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, cellStart(tr.doc, at.table, at.row + 1, at.col))).scrollIntoView());
    return true;
  }) as Command,
  addRow: ((state, dispatch) => {
    const at = cellAt(state);
    if (!at) return false;
    const rows = cellsOf(at.node);
    rows.splice(at.row + 1, 0, Array.from({ length: rows[0].length }, () => schema.nodes.table_cell.create()));
    if (dispatch) { const tr = rebuild(state, at, rows, at.node.attrs.align as unknown[]); dispatch(tr.setSelection(TextSelection.create(tr.doc, cellStart(tr.doc, at.table, at.row + 1, at.col)))); }
    return true;
  }) as Command,
  addColumn: ((state, dispatch) => {
    const at = cellAt(state);
    if (!at) return false;
    const rows = cellsOf(at.node).map((cells) => { const next = [...cells]; next.splice(at.col + 1, 0, schema.nodes.table_cell.create()); return next; });
    const align = [...(at.node.attrs.align as unknown[])];
    align.splice(at.col + 1, 0, null);
    if (dispatch) { const tr = rebuild(state, at, rows, align); dispatch(tr.setSelection(TextSelection.create(tr.doc, cellStart(tr.doc, at.table, at.row, at.col + 1)))); }
    return true;
  }) as Command,
  deleteRow: ((state, dispatch) => {
    const at = cellAt(state);
    if (!at) return false;
    const rows = cellsOf(at.node);
    if (rows.length <= 1) { dispatch?.(state.tr.delete(at.table, at.table + at.node.nodeSize)); return true; }
    rows.splice(at.row, 1);
    if (dispatch) { const tr = rebuild(state, at, rows, at.node.attrs.align as unknown[]); dispatch(tr.setSelection(TextSelection.create(tr.doc, cellStart(tr.doc, at.table, Math.min(at.row, rows.length - 1), at.col)))); }
    return true;
  }) as Command,
  deleteColumn: ((state, dispatch) => {
    const at = cellAt(state);
    if (!at) return false;
    const rows = cellsOf(at.node);
    if (rows[0].length <= 1) { dispatch?.(state.tr.delete(at.table, at.table + at.node.nodeSize)); return true; }
    const next = rows.map((cells) => cells.filter((_, i) => i !== at.col));
    const align = (at.node.attrs.align as unknown[]).filter((_, i) => i !== at.col);
    if (dispatch) { const tr = rebuild(state, at, next, align); dispatch(tr.setSelection(TextSelection.create(tr.doc, cellStart(tr.doc, at.table, at.row, Math.min(at.col, next[0].length - 1))))); }
    return true;
  }) as Command,
};

/* ── Callouts ── */

export const CALLOUT_TYPES = ["note", "tip", "info", "warning", "danger", "question"] as const;

/** A callout: a header with its kind (click to change) and its title, then its words. */
export class CalloutView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PmNode;
  private kind: HTMLButtonElement;
  private title: HTMLInputElement;
  constructor(node: PmNode, view: EditorView, getPos: () => number | undefined, editable: boolean) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "nt-callout";
    const head = document.createElement("div");
    head.className = "nt-callout-head";
    head.contentEditable = "false";
    this.kind = document.createElement("button");
    this.kind.type = "button";
    this.kind.className = "nt-callout-kind";
    this.kind.disabled = !editable;
    this.kind.title = t("notes.callout.change");
    this.kind.addEventListener("mousedown", (event) => event.preventDefault());
    this.kind.addEventListener("click", () => {
      const pos = getPos();
      if (pos === undefined) return;
      const at = CALLOUT_TYPES.indexOf(this.node.attrs.type as (typeof CALLOUT_TYPES)[number]);
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, type: CALLOUT_TYPES[(at + 1) % CALLOUT_TYPES.length] }));
    });
    this.title = document.createElement("input");
    this.title.className = "nt-callout-title";
    this.title.placeholder = t("notes.callout.title");
    this.title.readOnly = !editable;
    const commit = () => {
      const pos = getPos();
      if (pos === undefined || this.title.value === this.node.attrs.title) return;
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, title: this.title.value.replace(/\s+/g, " ").trim() }));
    };
    this.title.addEventListener("change", commit);
    this.title.addEventListener("blur", commit);
    this.title.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        commit();
        const pos = getPos();
        if (pos !== undefined) { view.focus(); view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1))); }
      }
    });
    head.append(this.kind, this.title);
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "nt-callout-body";
    this.dom.append(head, this.contentDOM);
    this.paint();
  }
  private paint() {
    const type = String(this.node.attrs.type).toLowerCase();
    this.dom.dataset.type = type;
    this.kind.textContent = (CALLOUT_TYPES as readonly string[]).includes(type) ? t(`notes.callout.${type}` as Key) : type;
    if (document.activeElement !== this.title) this.title.value = this.node.attrs.title as string;
  }
  update(node: PmNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.paint();
    return true;
  }
  stopEvent(event: Event) { return (event.target as Node) === this.title || (event.target as Node) === this.kind; }
  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
    return mutation.type === "selection" ? false : !this.contentDOM.contains(mutation.target as Node);
  }
}

/* ── The / menu ── */

export interface SlashContext {
  /** Makes a page under this one and answers its path, to link to. */
  newSubpage(): Promise<string | null>;
  /** Asks for files and puts them where the cursor is. */
  pickFiles(): void;
}

interface SlashItem { id: string; label: Key; words: string; mark: string; run(view: EditorView, context: SlashContext): void }

const turnInto = (type: NodeType, attrs?: Record<string, unknown>) => (view: EditorView) => { setBlockType(type, attrs)(view.state, view.dispatch); };

/** A block put after the cursor's block (or in place of it, when that line is empty), the cursor in its first text. */
function insertBlock(view: EditorView, node: PmNode) {
  const { $from } = view.state.selection;
  const block = $from.before(1), end = $from.after(1);
  const empty = !$from.parent.content.size && $from.parent.type === schema.nodes.paragraph;
  let tr = empty ? view.state.tr.replaceWith(block, end, node) : view.state.tr.insert(end, node);
  const at = empty ? block : end;
  if (at + node.nodeSize >= tr.doc.content.size) tr = tr.insert(tr.doc.content.size, schema.nodes.paragraph.create());
  const inside = node.type === schema.nodes.rule ? at + node.nodeSize + 1 : at + (node.type === schema.nodes.table ? 3 : 1);
  view.dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(inside, tr.doc.content.size)))).scrollIntoView());
}

export const SLASH_ITEMS: SlashItem[] = [
  { id: "text", label: "notes.slash.text", words: "text paragraph 正文 文字", mark: "T", run: turnInto(schema.nodes.paragraph) },
  { id: "h1", label: "notes.help.h1", words: "h1 heading title 标题 大标题", mark: "H1", run: turnInto(schema.nodes.heading, { level: 1 }) },
  { id: "h2", label: "notes.help.h2", words: "h2 heading 标题 中标题", mark: "H2", run: turnInto(schema.nodes.heading, { level: 2 }) },
  { id: "h3", label: "notes.help.h3", words: "h3 heading 标题 小标题", mark: "H3", run: turnInto(schema.nodes.heading, { level: 3 }) },
  { id: "bullet", label: "notes.help.bullet", words: "bullet list 列表 无序", mark: "•", run: turnInto(schema.nodes.item, { list: "bullet", depth: 0 }) },
  { id: "ordered", label: "notes.help.ordered", words: "number ordered list 编号 有序", mark: "1.", run: turnInto(schema.nodes.item, { list: "ordered", depth: 0, number: 1 }) },
  { id: "task", label: "notes.help.task", words: "todo task checkbox 待办 任务", mark: "[ ]", run: turnInto(schema.nodes.item, { list: "task", depth: 0, checked: false }) },
  { id: "quote", label: "notes.help.quote", words: "quote 引用", mark: "“", run: turnInto(schema.nodes.quote) },
  { id: "callout", label: "notes.slash.callout", words: "callout note tip 提示 提示框 标注", mark: "!", run: turnInto(schema.nodes.callout, { type: "note", fold: "", title: "" }) },
  { id: "code", label: "notes.slash.code", words: "code 代码", mark: "</>", run: turnInto(schema.nodes.code_block) },
  { id: "table", label: "notes.slash.table", words: "table 表格", mark: "#", run: (view) => insertBlock(view, schema.nodes.table.create({ align: [null, null, null] }, [emptyRow(3), emptyRow(3)])) },
  { id: "rule", label: "notes.help.rule", words: "divider rule line 分割线 分隔", mark: "—", run: (view) => insertBlock(view, schema.nodes.rule.create()) },
  { id: "page", label: "notes.slash.page", words: "page subpage 子页面 页面", mark: "[[ ]]", run: (view, context) => {
    // Linked by its path (another page may have the same name), shown by its name.
    void context.newSubpage().then((id) => { if (id) view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.wiki.create({ target: id, alias: id.split("/").pop(), raw: "" }), false)); });
  } },
  { id: "file", label: "notes.slash.file", words: "image picture file 图片 文件 附件", mark: "+", run: (_view, context) => context.pickFiles() },
];

/** The words typed after `/` in the cursor's line, with where they are; null when there is no menu to show. */
export function slashQuery(state: EditorState): { from: number; to: number; query: string } | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type === schema.nodes.code_block || $from.parent.type === schema.nodes.raw || $from.parent.type === schema.nodes.table_cell) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const found = /(?:^|\s)\/([^\s/]{0,20})$/.exec(before);
  if (!found) return null;
  return { from: $from.pos - found[1].length - 1, to: $from.pos, query: found[1].toLowerCase() };
}

/** The items for what was typed after `/`, best first: a name that starts with it, a word that starts with it, then
 * anything that has it ("表" puts 表格 before 列表). */
export function slashItems(query: string): SlashItem[] {
  if (!query) return SLASH_ITEMS;
  const rank = (item: SlashItem) => {
    const label = t(item.label).toLowerCase(), words = item.words.split(" ");
    if (label.startsWith(query)) return 0;
    if (words.some((word) => word.startsWith(query))) return 1;
    if (label.includes(query) || item.words.includes(query)) return 2;
    return 3;
  };
  return SLASH_ITEMS.map((item) => ({ item, rank: rank(item) })).filter((one) => one.rank < 3).sort((a, b) => a.rank - b.rank).map((one) => one.item);
}

/** The chosen item: the `/words` go, the block becomes what was chosen. */
export function runSlash(view: EditorView, at: { from: number; to: number }, item: SlashItem, context: SlashContext) {
  view.dispatch(view.state.tr.delete(at.from, at.to));
  item.run(view, context);
  view.focus();
}

/* ── What floats over the editor ── */

interface Place { left: number; top: number }

/** The `/` menu, the bar over selected words, the table's bar and the block handle, drawn over the editor where they
 * belong. `tick` changes with every change to the editor, so positions are worked out again. */
export function Overlays({ view, host, tick, slash, context }: {
  view: EditorView | null; host: HTMLElement | null; tick: number;
  slash: { at: { from: number; to: number; query: string }; index: number; setIndex(n: number): void; close(): void } | null;
  context: SlashContext;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [handle, setHandle] = useState<{ pos: number; top: number } | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  /** The words a link is being written for (the editor may lose its selection while the field has the keys). */
  const linkRange = useRef<{ from: number; to: number } | null>(null);

  // The handle follows the pointer from block to block (not on a phone: there, / and the selection bar are enough).
  useEffect(() => {
    if (!view || !host || !view.editable) return;
    const move = (event: MouseEvent) => {
      const box = view.dom.getBoundingClientRect();
      if (event.clientY < box.top || event.clientY > box.bottom) { setHandle(null); return; }
      const found = view.posAtCoords({ left: box.left + 8, top: event.clientY });
      if (!found) return;
      const $pos = view.state.doc.resolve(Math.min(found.inside >= 0 ? found.inside : found.pos, view.state.doc.content.size));
      if ($pos.depth < 1 && found.inside < 0) return;
      const pos = $pos.depth >= 1 ? $pos.before(1) : found.inside;
      const dom = view.nodeDOM(pos) as HTMLElement | null;
      if (!dom || !dom.getBoundingClientRect) return;
      setHandle({ pos, top: dom.getBoundingClientRect().top - host.getBoundingClientRect().top });
    };
    const leave = (event: MouseEvent) => { if (!host.contains(event.relatedTarget as Node)) setHandle(null); };
    host.addEventListener("mousemove", move);
    host.addEventListener("mouseleave", leave);
    return () => { host.removeEventListener("mousemove", move); host.removeEventListener("mouseleave", leave); };
  }, [view, host]);

  if (!view || !host) return null;
  const origin = host.getBoundingClientRect();
  const place = (pos: number, below = true): Place => {
    const at = view.coordsAtPos(Math.min(pos, view.state.doc.content.size));
    return { left: at.left - origin.left, top: (below ? at.bottom : at.top) - origin.top };
  };
  const { state } = view;
  const sel = state.selection;
  const words = link !== null || !sel.empty && sel instanceof TextSelection && sel.$from.parent.inlineContent && sel.$from.parent.type !== schema.nodes.code_block && sel.$from.parent.type !== schema.nodes.raw && view.editable;
  const inTable = cellAt(state);
  const items = slash ? slashItems(slash.at.query) : [];
  void tick;

  const mark = (name: "strong" | "em" | "strike" | "code") => { toggleMark(schema.marks[name])(view.state, view.dispatch); view.focus(); };
  const active = (name: string) => { const type = schema.marks[name]; let on = false; state.doc.nodesBetween(sel.from, sel.to, (node) => { if (type.isInSet(node.marks)) on = true; }); return on; };
  const applyLink = (href: string) => {
    const { from, to } = linkRange.current ?? view.state.selection;
    linkRange.current = null;
    let tr = view.state.tr.removeMark(from, to, schema.marks.link);
    if (/^(https?:\/\/|mailto:)/i.test(href.trim())) tr = tr.addMark(from, to, schema.marks.link.create({ href: href.trim() }));
    view.dispatch(tr);
    setLink(null);
    view.focus();
  };

  return (
    <>
      {slash && items.length > 0 && (() => {
        const at = place(slash.at.from);
        return (
          <div className="nt-slash" role="listbox" aria-label={t("notes.slash.title")} style={{ left: Math.max(0, at.left - 8), top: at.top + 6 }}>
            {items.map((item, i) => (
              <button type="button" key={item.id} role="option" aria-selected={i === slash.index} onMouseEnter={() => slash.setIndex(i)}
                onMouseDown={(event) => { event.preventDefault(); runSlash(view, slash.at, item, context); slash.close(); }}>
                <span className="nt-slash-mark">{item.mark}</span><span>{t(item.label)}</span>
              </button>
            ))}
          </div>
        );
      })()}
      {words && (() => {
        const range = linkRange.current ?? sel;
        const start = place(range.from, false), end = place(range.to, false);
        const left = Math.max(0, Math.min(start.left, end.left));
        return (
          <div className="nt-bar" role="toolbar" aria-label={t("notes.bar.title")} style={{ left, top: Math.min(start.top, end.top) - 42 }} onMouseDown={(event) => { if ((event.target as HTMLElement).tagName !== "INPUT") event.preventDefault(); }}>
            {link === null ? (
              <>
                <button type="button" aria-pressed={active("strong")} onClick={() => mark("strong")} title={t("notes.help.bold")}><b>B</b></button>
                <button type="button" aria-pressed={active("em")} onClick={() => mark("em")} title={t("notes.help.italic")}><i>I</i></button>
                <button type="button" aria-pressed={active("strike")} onClick={() => mark("strike")} title={t("notes.help.strike")}><s>S</s></button>
                <button type="button" aria-pressed={active("code")} onClick={() => mark("code")} title={t("notes.help.inlineCode")}><code>{"</>"}</code></button>
                <button type="button" aria-pressed={active("link")} onClick={() => { linkRange.current = { from: sel.from, to: sel.to }; setLink(""); }} title={t("notes.bar.link")}>{t("notes.bar.link")}</button>
              </>
            ) : (
              <form onSubmit={(event) => { event.preventDefault(); applyLink(link); }}>
                <input ref={linkInput} autoFocus value={link} placeholder="https://" aria-label={t("notes.bar.link")} onChange={(event) => setLink(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") { setLink(null); view.focus(); } }} />
              </form>
            )}
          </div>
        );
      })()}
      {inTable && view.editable && (() => {
        const dom = view.nodeDOM(inTable.table) as HTMLElement | null;
        if (!dom) return null;
        const box = dom.getBoundingClientRect();
        const run = (command: Command) => (event: React.MouseEvent) => { event.preventDefault(); command(view.state, view.dispatch); view.focus(); };
        return (
          <div className="nt-table-bar" role="toolbar" aria-label={t("notes.slash.table")} style={{ left: box.left - origin.left, top: box.top - origin.top - 30 }}>
            <button type="button" onMouseDown={run(tableCommands.addRow)}>{t("notes.table.addRow")}</button>
            <button type="button" onMouseDown={run(tableCommands.addColumn)}>{t("notes.table.addColumn")}</button>
            <button type="button" onMouseDown={run(tableCommands.deleteRow)}>{t("notes.table.deleteRow")}</button>
            <button type="button" onMouseDown={run(tableCommands.deleteColumn)}>{t("notes.table.deleteColumn")}</button>
          </div>
        );
      })()}
      {handle && view.editable && (
        <div className="nt-handle" style={{ top: handle.top }}>
          <button type="button" aria-label={t("notes.handle.add")} title={t("notes.handle.add")} onMouseDown={(event) => {
            event.preventDefault();
            const node = view.state.doc.nodeAt(handle.pos);
            if (!node) return;
            const after = handle.pos + node.nodeSize;
            const tr = view.state.tr.insert(after, schema.nodes.paragraph.create(null, schema.text("/")));
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 2)));
            view.focus();
          }}>+</button>
          <span className="nt-grip" draggable aria-label={t("notes.handle.drag")} title={t("notes.handle.drag")}
            onDragStart={(event) => {
              const node = view.state.doc.nodeAt(handle.pos);
              if (!node) return;
              const selection = NodeSelection.create(view.state.doc, handle.pos);
              view.dispatch(view.state.tr.setSelection(selection));
              event.dataTransfer.setData("text/plain", node.textContent);
              event.dataTransfer.effectAllowed = "move";
              const dom = view.nodeDOM(handle.pos) as HTMLElement | null;
              if (dom) event.dataTransfer.setDragImage(dom, 0, 0);
              // ProseMirror moves what it is dragging when it is dropped in the editor.
              (view as unknown as { dragging: { slice: unknown; move: boolean } | null }).dragging = { slice: selection.content(), move: true };
            }}><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="7.5" cy="5" r="1.2" /><circle cx="12.5" cy="5" r="1.2" /><circle cx="7.5" cy="10" r="1.2" /><circle cx="12.5" cy="10" r="1.2" /><circle cx="7.5" cy="15" r="1.2" /><circle cx="12.5" cy="15" r="1.2" /></svg></span>
        </div>
      )}
    </>
  );
}
