/** What a page shows that is not words: pictures and files put in it (`![[图.png]]`, `![](a.png)`), links that open
 * when clicked, links to pages that do not exist yet (dashed), and on each to-do a way to put it on the todo list
 * (research 3.5). The file keeps them as written; this is only how they look and what a click does. */
import type { Node as PmNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView, type NodeView } from "prosemirror-view";
import { readableBlock, wordsKey } from "@zirma/module-notes/markdown";
import { nodeToBlock, schema } from "./schema.ts";
import { t } from "../i18n/index.ts";

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
/** A file, not a page: a name with an extension other than `.md`. */
const FILE = /\.(?!md$)[A-Za-z0-9]{1,8}$/;
const IMAGE_MD = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)$/;
const URL_RAW = /^<?(https?:\/\/[^\s<>]+)>?$/i;
const BREAK = /^(?: {2,}|\\)\r?\n$/;
const CLIP = "M14.5 9.5 9.6 14.4a3 3 0 0 1-4.2-4.2l5.6-5.6a2 2 0 0 1 2.8 2.8L8.3 12.9a1 1 0 0 1-1.4-1.4l4.6-4.6";

export interface PageContext {
  /** The page being shown (its id): pictures are found from its folder. */
  page: string;
  library: string;
  /** Whether a page of this name or path is in the library. */
  exists(target: string): boolean;
}

export const fileUrl = (name: string, page: string) => `/api/notes/file?name=${encodeURIComponent(name)}&from=${encodeURIComponent(page)}`;
const pathUrl = (path: string, page: string) => `/api/notes/file?path=${encodeURIComponent(path)}&from=${encodeURIComponent(page)}`;
export const linkName = (target: string) => target.split(/[#^]/)[0].trim();
export const isFileName = (name: string) => FILE.test(name);

function picture(src: string, alt: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "nt-embed";
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  img.loading = "lazy";
  img.draggable = false;
  img.addEventListener("error", () => { wrap.classList.add("nt-broken"); wrap.textContent = alt; });
  wrap.append(img);
  return wrap;
}

function fileChip(href: string, name: string): HTMLElement {
  const chip = document.createElement("a");
  chip.className = "nt-file";
  chip.href = href;
  chip.target = "_blank";
  chip.rel = "noopener noreferrer";
  chip.title = t("notes.openFile");
  chip.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${CLIP}"/></svg>`;
  const label = document.createElement("span");
  label.textContent = name;
  chip.append(label);
  return chip;
}

/** `[[page]]`, `[[page|alias]]`, `![[picture.png]]`, `![[file.pdf]]`. */
export class WikiView implements NodeView {
  dom: HTMLElement;
  constructor(node: PmNode, context: PageContext) {
    const { target, alias, embed } = node.attrs as { target: string; alias: string | null; embed: boolean };
    const name = linkName(target);
    if (embed && IMAGE.test(name)) this.dom = picture(fileUrl(name, context.page), alias ?? name);
    else if (FILE.test(name)) this.dom = fileChip(fileUrl(name, context.page), alias ?? name);
    else {
      const link = document.createElement("a");
      link.className = `nt-wiki${embed ? " nt-embed-page" : ""}${context.exists(name) ? "" : " nt-missing"}`;
      link.dataset.target = target;
      link.textContent = alias ?? target;
      this.dom = link;
    }
  }
  ignoreMutation() { return true; }
}

/** Something kept as written: a picture (`![](…)`), a bare address (a link), a line break, or the source itself. */
export class AtomView implements NodeView {
  dom: HTMLElement;
  constructor(node: PmNode, context: PageContext) {
    const raw = node.attrs.raw as string;
    const image = IMAGE_MD.exec(raw);
    const address = URL_RAW.exec(raw);
    if (image) this.dom = picture(/^https?:\/\//i.test(image[2]) ? image[2] : pathUrl(image[2], context.page), image[1] || image[2]);
    else if (address) {
      const link = document.createElement("a");
      link.className = "nt-link";
      link.href = address[1];
      link.rel = "noopener noreferrer";
      link.textContent = address[1];
      this.dom = link;
    } else if (BREAK.test(raw)) this.dom = document.createElement("br");
    else {
      const span = document.createElement("span");
      span.className = "nt-atom";
      span.title = raw;
      span.textContent = raw.replace(/\r?\n/g, " ");
      this.dom = span;
    }
  }
  ignoreMutation() { return true; }
}

/* ── To-dos onto the todo list ── */

export const tasksKey = new PluginKey<ReadonlySet<string>>("note-tasks");

/** Each to-do in the page with its todo `ref` (`taskRef` in the module: the same words, which of them). */
export function eachTask(doc: PmNode, context: { library: string; page: string }, visit: (ref: string, words: string, offset: number, node: PmNode) => void): void {
  const counts = new Map<string, number>();
  doc.forEach((node, offset) => {
    if (node.type !== schema.nodes.item || node.attrs.list !== "task") return;
    const words = readableBlock(nodeToBlock(node)!);
    const key = wordsKey(words);
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    if (words.trim()) visit(`note:${context.library}:${context.page}#${key}:${nth}`, words, offset, node);
  });
}

/** At the end of each to-do: "to todos", or "on your todos" once it is there. */
export function tasksPlugin(context: () => PageContext & { put(ref: string, words: string): void }): Plugin {
  return new Plugin<ReadonlySet<string>>({
    key: tasksKey,
    state: { init: () => new Set<string>(), apply: (tr, value) => (tr.getMeta(tasksKey) as ReadonlySet<string> | undefined) ?? value },
    props: {
      decorations(state) {
        const listed = tasksKey.getState(state) ?? new Set<string>();
        const now = context();
        const marks: Decoration[] = [];
        eachTask(state.doc, now, (ref, words, offset, node) => {
          const there = listed.has(ref);
          marks.push(Decoration.widget(offset + node.nodeSize - 1, () => {
            const el = document.createElement(there ? "span" : "button");
            el.className = there ? "nt-in-todo" : "nt-to-todo";
            el.contentEditable = "false";
            el.textContent = there ? t("notes.inTodo") : t("notes.toTodo");
            if (!there) {
              (el as HTMLButtonElement).type = "button";
              el.addEventListener("mousedown", (event) => event.preventDefault());
              el.addEventListener("click", () => context().put(ref, words));
            }
            return el;
          }, { side: 1, key: `${ref}|${there}`, ignoreSelection: true, stopEvent: () => true }));
        });
        return DecorationSet.create(state.doc, marks);
      },
    },
  });
}

/** Scrolls to one to-do of the page and shows which (from the todo list's "open the note"). */
export function showTask(view: EditorView, context: { library: string; page: string }, key: string, nth: number): boolean {
  let found = -1;
  eachTask(view.state.doc, context, (ref, _words, offset) => { if (found === -1 && ref.endsWith(`#${key}:${nth}`)) found = offset; });
  if (found === -1) return false;
  const dom = view.nodeDOM(found) as HTMLElement | null;
  if (!dom) return false;
  dom.scrollIntoView({ block: "center" });
  dom.classList.remove("nt-flash");
  void dom.offsetWidth;
  dom.classList.add("nt-flash");
  return true;
}

/* ── Files put in a page ── */

export async function uploadFile(file: File, page: string): Promise<{ name: string; image: boolean }> {
  const response = await fetch(`/api/notes/attach?page=${encodeURIComponent(page)}&name=${encodeURIComponent(file.name || "file")}`, { method: "POST", body: file });
  const body = await response.json().catch(() => ({})) as { name?: string; image?: boolean; error?: string };
  if (!response.ok || !body.name) throw new Error(body.error ?? t("notes.failed"));
  return { name: body.name, image: !!body.image };
}

/** The files of a paste or a drop, put in the page where they landed, one after another, as `![[name]]`. */
export async function putFiles(view: EditorView, files: File[], at: number, page: string, onError: (message: string) => void): Promise<void> {
  let pos = at;
  for (const file of files) {
    try {
      const { name } = await uploadFile(file, page);
      const node = schema.nodes.wiki.create({ target: name, embed: true, raw: "" });
      const bounded = Math.min(pos, view.state.doc.content.size);
      const tr = view.state.tr.insert(bounded, node);
      view.dispatch(tr);
      pos = tr.mapping.map(bounded);
    } catch (error) {
      onError(t("notes.uploadFailed", { why: (error as Error).message }));
    }
  }
}
