/** One page, written as it looks (docs/research/notes-editor.md 3.2): ProseMirror, with our own keys and Markdown
 * shortcuts. It saves a moment after you stop typing: the blocks you did not change are copied from the file, the
 * ones you changed are written, and the result must read back as what you see, or it is not saved (3.1). One save
 * is on its way at a time, each from the version the last one left (3.4); a file changed elsewhere is never
 * written over: you choose. */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { baseKeymap, setBlockType, splitBlock, splitBlockAs, toggleMark, chainCommands, exitCode } from "prosemirror-commands";
import { dropCursor } from "prosemirror-dropcursor";
import { history, redo, undo } from "prosemirror-history";
import { InputRule, inputRules, textblockTypeInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { Node as PmNode } from "prosemirror-model";
import { EditorState, Plugin, TextSelection, type Command } from "prosemirror-state";
import { EditorView, type NodeView } from "prosemirror-view";
import { assignSources, blanksBefore, compose, parsePage, writeBlocks, type ParsedPage } from "@zirma/module-notes/markdown";
import type { PageDetail } from "@zirma/module-notes/types";
import { blocksToDoc, docToBlocks, flattenLists, schema } from "./schema.ts";
import { Fragment, Slice } from "prosemirror-model";
import { AtomView, fileUrl, isFileName, linkName, putFiles, showTask, tasksKey, tasksPlugin, WikiView, type PageContext } from "./embeds.ts";
import { t } from "../i18n/index.ts";

export type SaveState =
  | { kind: "saved" }
  | { kind: "saving" }
  /** The words would not read back as shown: not saved; they are still here, and can go to a new page. */
  | { kind: "unsaved" }
  /** The file changed elsewhere since: what is there now (null: the page is gone). */
  | { kind: "changed"; current: { text: string; fp: string } | null }
  /** The notes moved to another folder while this page was open. */
  | { kind: "library" }
  | { kind: "offline" };

export interface EditorHandle {
  /** Saves now (before leaving the page, changing its icon). Resolves when nothing is waiting. */
  flush(): Promise<void>;
  /** Takes the file's version and shows it (after "changed elsewhere": use theirs). */
  load(text: string, fp: string | null): void;
  /** The page as Markdown, for "save as a new page" when this one cannot be saved. */
  markdown(): string;
  /** The version of the file this page last read or saved. */
  fp(): string | null;
  /** Whether there are words not saved yet. */
  dirty(): boolean;
}

type SaveAnswer =
  | { ok: true; fp: string }
  | { ok: false; reason: "library" | "zirma" }
  | { ok: false; reason: "changed"; current: { text: string; fp: string } | null };

async function save(body: { library: string; id: string; base: string | null; text: string }): Promise<SaveAnswer | "offline"> {
  try {
    const response = await fetch("/api/notes/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status !== 200 && response.status !== 409) return "offline";
    return await response.json() as SaveAnswer;
  } catch {
    return "offline";
  }
}

/* ── Keys ── */

const isTextish = (node: PmNode) => node.type === schema.nodes.code_block || node.type === schema.nodes.raw;

const enter: Command = (state, dispatch) => {
  const { $from } = state.selection;
  const node = $from.parent;
  if (isTextish(node)) { dispatch?.(state.tr.insertText("\n").scrollIntoView()); return true; }
  if (node.type === schema.nodes.item) {
    // An empty item ends the list.
    if (!node.content.size) return setBlockType(schema.nodes.paragraph)(state, dispatch);
    return splitBlockAs(() => ({ type: schema.nodes.item, attrs: { ...node.attrs, checked: false, number: (node.attrs.number as number) + 1 } }))(state, dispatch);
  }
  return splitBlock(state, dispatch);
};

/** At the start of a heading, item, quote or code: it becomes words first, then joins the block above. */
const backspace: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0 || $from.parent.type === schema.nodes.paragraph) return false;
  return setBlockType(schema.nodes.paragraph)(state, dispatch);
};

function indent(by: 1 | -1): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const node = $from.parent;
    if (node.type !== schema.nodes.item) return by === 1 ? false : false;
    const index = $from.index(0);
    const above = index > 0 ? state.doc.child(index - 1) : null;
    const most = above?.type === schema.nodes.item ? (above.attrs.depth as number) + 1 : 0;
    const depth = Math.max(0, Math.min(most, (node.attrs.depth as number) + by));
    if (depth === node.attrs.depth) return true;
    dispatch?.(state.tr.setNodeMarkup($from.before(1), undefined, { ...node.attrs, depth }));
    return true;
  };
}

const keys = keymap({
  Enter: enter,
  "Shift-Enter": chainCommands(exitCode, (state, dispatch) => { dispatch?.(state.tr.insertText("\n")); return true; }),
  Backspace: backspace,
  Tab: indent(1),
  "Shift-Tab": indent(-1),
  "Mod-b": toggleMark(schema.marks.strong),
  "Mod-i": toggleMark(schema.marks.em),
  "Mod-e": toggleMark(schema.marks.code),
  "Mod-Shift-x": toggleMark(schema.marks.strike),
  "Mod-z": undo,
  "Shift-Mod-z": redo,
  "Mod-y": redo,
});

/* ── Markdown as you type, at the start of a line ── */

function toItem(pattern: RegExp, attrs: (match: RegExpMatchArray) => Record<string, unknown>) {
  return textblockTypeInputRule(pattern, schema.nodes.item, attrs);
}

const rules = inputRules({
  rules: [
    textblockTypeInputRule(/^(#{1,3})\s$/, schema.nodes.heading, (match) => ({ level: match[1].length })),
    toItem(/^\[( |x)?\]\s$/, (match) => ({ list: "task", depth: 0, checked: match[1] === "x" })),
    toItem(/^[-*+]\s$/, () => ({ list: "bullet", depth: 0 })),
    toItem(/^(\d+)\.\s$/, (match) => ({ list: "ordered", depth: 0, number: Number(match[1]) })),
    textblockTypeInputRule(/^>\s$/, schema.nodes.quote),
    textblockTypeInputRule(/^```$/, schema.nodes.code_block),
    // `---` on a line of its own: a rule, and the cursor in a new line under it.
    new InputRule(/^---$/, (state, _match, start, end) => {
      const $start = state.doc.resolve(start);
      if ($start.parent.type !== schema.nodes.paragraph || $start.parent.content.size !== end - start) return null;
      const before = $start.before();
      const tr = state.tr.replaceWith(before, $start.after(), [schema.nodes.rule.create(), schema.nodes.paragraph.create()]);
      return tr.setSelection(TextSelection.create(tr.doc, before + 2));
    }, { undoable: true }),
    // `[[name]]`: a link to a page, one piece.
    new InputRule(/\[\[([^[\]\n|]+)(?:\|([^[\]\n]+))?\]\]$/, (state, match, start, end) => {
      if (isTextish(state.doc.resolve(start).parent)) return null;
      return state.tr.replaceWith(start, end, schema.nodes.wiki.create({ target: match[1].trim(), alias: match[2] ?? null, raw: "" }));
    }),
    new InputRule(/\*\*([^*\n]+)\*\*$/, (state, match, start, end) => state.tr.replaceWith(start, end, schema.text(match[1], [schema.marks.strong.create()]))),
    new InputRule(/(?:^|[^`])`([^`\n]+)`$/, (state, match, _start, end) => {
      // The match may begin with the character before the opening backtick; only the backtick and the words go.
      const from = end - match[1].length - 1;
      return state.tr.replaceWith(from, end, schema.text(match[1], [schema.marks.code.create()]));
    }),
  ],
});

/** Only one block may claim the space of an empty line at the end: a click below the last block lands in a new
 * empty line there, never in a code block or a kept-as-written block. */
const trailing = new Plugin({
  appendTransaction(_transactions, _old, state) {
    const last = state.doc.lastChild;
    if (last && last.type === schema.nodes.paragraph) return null;
    return state.tr.insert(state.doc.content.size, schema.nodes.paragraph.create()).setMeta("addToHistory", false);
  },
});

/* ── How some blocks look ── */

class ItemView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private node: PmNode;
  constructor(node: PmNode, view: EditorView, getPos: () => number | undefined, editable: boolean) {
    this.node = node;
    this.dom = document.createElement("div");
    const marker = document.createElement(node.attrs.list === "task" ? "button" : "span");
    marker.className = "nt-marker";
    marker.contentEditable = "false";
    if (node.attrs.list === "task") {
      const box = marker as HTMLButtonElement;
      box.type = "button";
      box.setAttribute("role", "checkbox");
      box.setAttribute("aria-label", t("notes.done"));
      box.disabled = !editable;
      box.addEventListener("mousedown", (event) => event.preventDefault());
      box.addEventListener("click", () => {
        const pos = getPos();
        if (pos === undefined) return;
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, checked: !this.node.attrs.checked }));
      });
    }
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "nt-item-text";
    this.dom.append(marker, this.contentDOM);
    this.paint();
  }
  private paint() {
    const { list, depth, checked, number } = this.node.attrs as { list: string; depth: number; checked: boolean; number: number };
    this.dom.className = `nt-item nt-${list}${checked ? " nt-checked" : ""}`;
    this.dom.style.setProperty("--depth", String(depth));
    const marker = this.dom.firstElementChild as HTMLElement;
    if (list === "task") marker.setAttribute("aria-checked", String(!!checked));
    else marker.textContent = list === "ordered" ? `${number}.` : "";
  }
  update(node: PmNode) {
    if (node.type !== this.node.type || node.attrs.list !== this.node.attrs.list) return false;
    this.node = node;
    this.paint();
    return true;
  }
  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }) {
    return mutation.type !== "selection" && !this.contentDOM.contains(mutation.target as Node);
  }
}

export function NoteEditor({ detail, readOnly, onLink, onState, handle, exists, tasks, focus, onError, onEdit }: {
  detail: PageDetail;
  readOnly: boolean;
  /** A link to a page was clicked. */
  onLink(target: string): void;
  onState(state: SaveState): void;
  handle?: Ref<EditorHandle>;
  /** Whether a page by this name is in the library (a link to one that is not is dashed). */
  exists(target: string): boolean;
  /** The to-dos of this page already on the todo list (by ref), and how to put one there. */
  tasks?: { listed: ReadonlySet<string>; put(ref: string, words: string): void };
  /** One to-do to bring into view when the page opens: `<words key>:<which>`. */
  focus?: string | null;
  /** Something the user did could not be done (a file not put in). */
  onError(message: string): void;
  /** The words changed here (typed, pasted, a to-do ticked). */
  onEdit?(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const page = useRef<{ parsed: ParsedPage; text: string; fp: string | null; busy: boolean; again: boolean; stuck: boolean }>({
    parsed: parsePage(detail.text), text: detail.text, fp: detail.fp, busy: false, again: false, stuck: false,
  });
  const timer = useRef<number | undefined>(undefined);
  const settled = useRef<Array<() => void>>([]);
  const [, setTick] = useState(0);
  const report = useRef(onState);
  report.current = onState;
  const linkTo = useRef(onLink);
  linkTo.current = onLink;
  const latest = useRef({ exists, tasks, onError, onEdit });
  latest.current = { exists, tasks, onError, onEdit };
  const context = (): PageContext => ({ page: detail.id, library: detail.library, exists: (target) => latest.current.exists(target) });

  const flush = async (): Promise<void> => {
    window.clearTimeout(timer.current);
    const current = page.current;
    const editor = view.current;
    if (!editor || readOnly || current.stuck) return;
    if (current.busy) { current.again = true; return new Promise((resolve) => settled.current.push(resolve)); }
    const blocks = docToBlocks(editor.state.doc);
    const composed = compose(current.parsed, assignSources(current.parsed, blocks));
    if (!composed.ok) { report.current({ kind: "unsaved" }); return; }
    if (composed.text === current.text) { report.current({ kind: "saved" }); return; }
    current.busy = true;
    report.current({ kind: "saving" });
    const answer = await save({ library: detail.library, id: detail.id, base: current.fp, text: composed.text });
    current.busy = false;
    if (answer === "offline") report.current({ kind: "offline" });
    else if (answer.ok) {
      current.fp = answer.fp;
      current.text = composed.text;
      current.parsed = parsePage(composed.text);
      report.current({ kind: "saved" });
    } else {
      // Not written: nothing more is tried until the user chooses.
      current.stuck = true;
      report.current(answer.reason === "changed" ? { kind: "changed", current: answer.current } : { kind: answer.reason === "library" ? "library" : "unsaved" });
    }
    if (current.again && !current.stuck) { current.again = false; await flush(); }
    for (const resolve of settled.current.splice(0)) resolve();
  };

  useImperativeHandle(handle, () => ({
    flush,
    load(text, fp) {
      const parsed = parsePage(text);
      page.current = { parsed, text, fp, busy: false, again: false, stuck: false };
      const editor = view.current;
      if (editor) editor.updateState(stateFor(parsed));
      report.current({ kind: "saved" });
      setTick((n) => n + 1);
    },
    markdown() {
      return view.current ? writeBlocks(docToBlocks(view.current.state.doc)) : page.current.text;
    },
    fp: () => page.current.fp,
    dirty() {
      const editor = view.current;
      if (!editor || readOnly) return false;
      const composed = compose(page.current.parsed, assignSources(page.current.parsed, docToBlocks(editor.state.doc)));
      return !composed.ok || composed.text !== page.current.text;
    },
  }));

  const stateFor = (parsed: ParsedPage) => EditorState.create({
    doc: blocksToDoc(parsed.blocks.map((source) => source.block), blanksBefore(parsed)),
    plugins: readOnly ? [] : [rules, keys, keymap(baseKeymap), history(), dropCursor({ color: "var(--alf)" }), trailing,
      tasksPlugin(() => ({ ...context(), put: (ref, words) => latest.current.tasks?.put(ref, words) }))],
  });

  useEffect(() => {
    const editable = !readOnly;
    const editor = new EditorView(host.current!, {
      state: stateFor(page.current.parsed),
      editable: () => editable,
      attributes: { class: "nt-doc", spellcheck: "false", "aria-label": t("notes.body") },
      nodeViews: {
        item: (node, v, getPos) => new ItemView(node, v, getPos, editable),
        wiki: (node) => new WikiView(node, context()),
        atom: (node) => new AtomView(node, context()),
      },
      handleClickOn(_view, _pos, node) {
        if (node.type !== schema.nodes.wiki) return false;
        const name = linkName(node.attrs.target as string);
        // A picture is selected by a click; a file opens; a page is gone to.
        if (isFileName(name)) {
          if (!node.attrs.embed || !/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name)) window.open(fileUrl(name, detail.id), "_blank", "noopener,noreferrer");
          return !node.attrs.embed || !/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name);
        }
        linkTo.current(node.attrs.target as string);
        return true;
      },
      handleDOMEvents: {
        // A link in the words opens, in a new tab, as it does on a page you read.
        click(_view, event) {
          const link = (event.target as Element).closest?.("a.nt-link, a.nt-file") as HTMLAnchorElement | null;
          if (!link) return false;
          event.preventDefault();
          window.open(link.href, "_blank", "noopener,noreferrer");
          return true;
        },
      },
      handlePaste(view, event) {
        if (!editable) return false;
        const files = [...(event.clipboardData?.files ?? [])];
        if (files.length) {
          void putFiles(view, files, view.state.selection.from, detail.id, (message) => latest.current.onError(message));
          return true;
        }
        // An address pasted: a link on the words picked, or the address itself, which opens when clicked.
        const text = event.clipboardData?.getData("text/plain")?.trim() ?? "";
        if (!/^https?:\/\/\S+$/i.test(text)) return false;
        const { from, to, empty } = view.state.selection;
        if (!empty && view.state.doc.resolve(from).parent.inlineContent && !isTextish(view.state.doc.resolve(from).parent)) {
          view.dispatch(view.state.tr.addMark(from, to, schema.marks.link.create({ href: text })));
          return true;
        }
        if (isTextish(view.state.selection.$from.parent)) return false;
        view.dispatch(view.state.tr.replaceSelectionWith(schema.nodes.atom.create({ raw: text }), false));
        return true;
      },
      // Lists from a web page stay lists (one block per item, with its depth).
      transformPastedHTML: (html) => flattenLists(html),
      // Plain text: one block per line, as words only; the formatting at the cursor is not put on it.
      clipboardTextParser(text) {
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        const blocks = lines.filter((line) => line.trim()).map((line) => schema.nodes.paragraph.create(null, schema.text(line)));
        return new Slice(Fragment.from(blocks.length ? blocks : [schema.nodes.paragraph.create()]), 1, 1);
      },
      handleDrop(view, event) {
        if (!editable) return false;
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (!files.length) return false;
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos ?? view.state.selection.from;
        event.preventDefault();
        void putFiles(view, files, at, detail.id, (message) => latest.current.onError(message));
        return true;
      },
      dispatchTransaction(transaction) {
        editor.updateState(editor.state.apply(transaction));
        if (transaction.docChanged && editable) {
          latest.current.onEdit?.();
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void flush(), 700);
        }
      },
    });
    view.current = editor;
    if (editable) editor.dispatch(editor.state.tr.setMeta(tasksKey, latest.current.tasks?.listed ?? new Set()).setMeta("addToHistory", false));
    if (focus) {
      const [key, nth] = focus.split(":");
      requestAnimationFrame(() => showTask(editor, { library: detail.library, page: detail.id }, key, Number(nth)));
    }
    // A new page opens with the cursor in its first line.
    if (editable && !detail.text.trim()) editor.dispatch(editor.state.tr.setSelection(TextSelection.atStart(editor.state.doc)));
    const leave = () => void flush();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      void flush();
      editor.destroy();
      view.current = null;
    };
    // One editor per page: the page's id and library pick it; later changes to the detail are loaded on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, detail.library, readOnly]);

  // The todo list changed (a to-do was put there): the marks at the to-dos follow.
  useEffect(() => {
    const editor = view.current;
    if (editor && !readOnly && tasks) editor.dispatch(editor.state.tr.setMeta(tasksKey, tasks.listed).setMeta("addToHistory", false));
  }, [tasks?.listed, readOnly]);

  return <div className="nt-editor" ref={host} data-readonly={readOnly || undefined} />;
}
