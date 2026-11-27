/** The editor's document (docs/research/notes-editor.md 3.2): one node per top-level block of the page, the same
 * blocks the home node reads (@zirma/module-notes/markdown). A list item is a block with its kind and depth, not a
 * nested list, so each item is written back on its own. What the editor cannot draw is a `raw` block, edited as its
 * source; links to pages and pieces kept as written are single inline nodes. Nothing here knows about saving. */
import { Schema, type Mark as PmMark, type Node as PmNode } from "prosemirror-model";
import { normalizeInline, type Block, type EditBlock, type Inline, type Mark } from "@zirma/module-notes/markdown";

export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
    heading: {
      group: "block", content: "inline*", attrs: { level: { default: 1 } }, defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
      toDOM: (node) => [`h${Math.min(3, node.attrs.level as number) + 1}`, { "data-level": node.attrs.level }, 0],
    },
    item: {
      group: "block", content: "inline*", defining: true,
      attrs: { list: { default: "bullet" }, depth: { default: 0 }, checked: { default: false }, number: { default: 1 } },
      toDOM: (node) => ["div", { class: `nt-item nt-${node.attrs.list}`, "data-depth": node.attrs.depth }, ["div", { class: "nt-item-text" }, 0]],
      // A pasted list arrives flattened (flattenLists): one element per item, with its kind and depth.
      parseDOM: [{
        tag: "div[data-nt-item]",
        getAttrs: (dom) => ({
          list: (dom as HTMLElement).dataset.ntItem, depth: Number((dom as HTMLElement).dataset.depth ?? 0),
          checked: (dom as HTMLElement).dataset.checked === "true", number: Number((dom as HTMLElement).dataset.number ?? 1),
        }),
      }, { tag: "li" }],
    },
    quote: { group: "block", content: "inline*", defining: true, parseDOM: [{ tag: "blockquote" }], toDOM: () => ["blockquote", 0] },
    code_block: {
      group: "block", content: "text*", marks: "", code: true, defining: true, attrs: { lang: { default: "" } },
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }], toDOM: (node) => ["pre", { "data-lang": node.attrs.lang || undefined }, ["code", 0]],
    },
    rule: { group: "block", parseDOM: [{ tag: "hr" }], toDOM: () => ["div", { class: "nt-rule" }, ["hr"]] },
    // A GFM table: rows of cells of words; the first row is the header. `align` per column.
    table: {
      group: "block", content: "table_row+", isolating: true, attrs: { align: { default: [] } },
      parseDOM: [{ tag: "table" }],
      toDOM: () => ["div", { class: "nt-table" }, ["table", ["tbody", 0]]],
    },
    table_row: { content: "table_cell+", parseDOM: [{ tag: "tr" }], toDOM: () => ["tr", 0] },
    table_cell: { content: "inline*", isolating: true, parseDOM: [{ tag: "td" }, { tag: "th" }], toDOM: () => ["td", 0] },
    // An Obsidian callout of one paragraph: its type and title are attributes, its words the content.
    callout: {
      group: "block", content: "inline*", defining: true, attrs: { type: { default: "note" }, fold: { default: "" }, title: { default: "" } },
      toDOM: (node) => ["div", { class: "nt-callout", "data-type": node.attrs.type }, ["div", { class: "nt-callout-body" }, 0]],
    },
    raw: {
      group: "block", content: "text*", marks: "", code: true, defining: true,
      toDOM: () => ["pre", { class: "nt-raw" }, ["code", 0]],
    },
    text: { group: "inline" },
    wiki: {
      group: "inline", inline: true, atom: true, selectable: true,
      attrs: { target: {}, alias: { default: null }, embed: { default: false }, raw: { default: "" } },
      toDOM: (node) => ["a", { class: `nt-wiki${node.attrs.embed ? " nt-embed" : ""}`, "data-target": node.attrs.target }, (node.attrs.alias as string | null) ?? (node.attrs.target as string)],
    },
    atom: {
      group: "inline", inline: true, atom: true, selectable: true, attrs: { raw: {} },
      // A picture pasted from a page on the web: kept as `![alt](address)`.
      parseDOM: [{ tag: "img[src]", getAttrs: (dom) => { const src = (dom as HTMLElement).getAttribute("src") ?? ""; return /^https?:/i.test(src) ? { raw: `![${((dom as HTMLElement).getAttribute("alt") ?? "").replace(/[[\]]/g, "")}](${src.replace(/[()\s]/g, encodeURIComponent)})` } : false; } }],
      toDOM: (node) => ["span", { class: "nt-atom", title: node.attrs.raw }, (node.attrs.raw as string).replace(/\r?\n/g, " ")],
    },
  },
  marks: {
    strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
    strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: () => ["s", 0] },
    code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0], excludes: "_" },
    link: {
      attrs: { href: {} }, inclusive: false,
      // Only addresses that open a page or a mail: a pasted `javascript:` link is kept as its words.
      parseDOM: [{ tag: "a[href]", getAttrs: (dom) => { const href = (dom as HTMLElement).getAttribute("href") ?? ""; return /^(https?:|mailto:)/i.test(href) ? { href } : false; } }],
      toDOM: (mark) => ["a", { href: mark.attrs.href, class: "nt-link", rel: "noopener noreferrer", target: "_blank" }, 0],
    },
  },
});

const MARK_ORDER: readonly Mark[] = ["strong", "em", "strike", "code"];

function inlineToPm(content: readonly Inline[]): PmNode[] {
  return content.flatMap((run): PmNode[] => {
    if (run.t === "wiki") return [schema.nodes.wiki.create({ target: run.target, alias: run.alias ?? null, embed: !!run.embed, raw: run.raw })];
    if (run.t === "atom") return [schema.nodes.atom.create({ raw: run.raw })];
    if (!run.text) return [];
    const marks: PmMark[] = (run.marks ?? []).map((name) => schema.marks[name].create());
    if (run.href !== undefined) marks.push(schema.marks.link.create({ href: run.href }));
    return [schema.text(run.text, marks)];
  });
}

/** The page's blocks as the editor's document; `blanks[i]` empty lines are shown above block i (the file's extra blank
 * lines, as in Obsidian's source view). */
export function blocksToDoc(blocks: readonly Block[], blanks: readonly number[] = []): PmNode {
  const nodes = blocks.flatMap((block, i): PmNode[] => [...Array.from({ length: blanks[i] ?? 0 }, () => schema.nodes.paragraph.create()), toNode(block)]);
  return schema.nodes.doc.create(null, nodes.length ? nodes : [schema.nodes.paragraph.create()]);
}

function toNode(block: Block): PmNode {
  switch (block.kind) {
    case "paragraph": return schema.nodes.paragraph.create(null, inlineToPm(block.content));
    case "heading": return schema.nodes.heading.create({ level: block.level }, inlineToPm(block.content));
    case "item": return schema.nodes.item.create({ list: block.list, depth: block.depth, checked: !!block.checked, number: block.number ?? 1 }, inlineToPm(block.content));
    case "quote": return schema.nodes.quote.create(null, inlineToPm(block.content));
    case "code": return schema.nodes.code_block.create({ lang: block.lang }, block.text ? schema.text(block.text) : null);
    case "rule": return schema.nodes.rule.create();
    case "table": return schema.nodes.table.create({ align: block.align }, block.rows.map((row) => schema.nodes.table_row.create(null, row.map((cell) => schema.nodes.table_cell.create(null, inlineToPm(cell))))));
    case "callout": return schema.nodes.callout.create({ type: block.type, fold: block.fold, title: block.title }, inlineToPm(block.content));
    case "raw": return schema.nodes.raw.create(null, block.text ? schema.text(block.text) : null);
  }
}

function pmToInline(node: PmNode): Inline[] {
  const out: Inline[] = [];
  node.forEach((child) => {
    if (child.type === schema.nodes.wiki) {
      const { target, alias, embed, raw } = child.attrs as { target: string; alias: string | null; embed: boolean; raw: string };
      // A link made in the editor has no source text yet; it is written as `[[target|alias]]`.
      out.push({ t: "wiki", target, ...(alias !== null ? { alias } : {}), ...(embed ? { embed: true } : {}), raw: raw || `${embed ? "!" : ""}[[${target}${alias !== null ? `|${alias}` : ""}]]` });
    } else if (child.type === schema.nodes.atom) out.push({ t: "atom", raw: child.attrs.raw as string });
    else if (child.isText) {
      const marks = MARK_ORDER.filter((name) => child.marks.some((mark) => mark.type.name === name));
      const link = child.marks.find((mark) => mark.type === schema.marks.link);
      out.push({ t: "text", text: child.text!, ...(marks.length ? { marks } : {}), ...(link ? { href: link.attrs.href as string } : {}) });
    }
  });
  return normalizeInline(out);
}

/** One of the editor's blocks as a page block. */
export function nodeToBlock(node: PmNode): Block | null {
  switch (node.type.name) {
    case "paragraph": return { kind: "paragraph", content: pmToInline(node) };
    case "heading": return { kind: "heading", level: node.attrs.level as number, content: pmToInline(node) };
    case "item": {
      const { list, depth, checked, number } = node.attrs as { list: "bullet" | "ordered" | "task"; depth: number; checked: boolean; number: number };
      return { kind: "item", list, depth, ...(list === "task" ? { checked } : {}), ...(list === "ordered" ? { number } : {}), content: pmToInline(node) };
    }
    case "quote": return { kind: "quote", content: pmToInline(node) };
    case "code_block": return { kind: "code", lang: node.attrs.lang as string, text: node.textContent };
    case "rule": return { kind: "rule" };
    case "table": {
      const rows: Inline[][][] = [];
      node.forEach((row) => { const cells: Inline[][] = []; row.forEach((cell) => cells.push(pmToInline(cell))); rows.push(cells); });
      const width = Math.max(0, ...rows.map((row) => row.length));
      const align = (node.attrs.align as Array<"left" | "right" | "center" | null>) ?? [];
      return { kind: "table", align: Array.from({ length: width }, (_, i) => align[i] ?? null), rows };
    }
    case "callout": return { kind: "callout", type: node.attrs.type as string, fold: node.attrs.fold as "" | "+" | "-", title: node.attrs.title as string, content: pmToInline(node) };
    case "raw": return { kind: "raw", text: node.textContent };
    default: return null;
  }
}

const isEmptyLine = (block: Block) => (block.kind === "paragraph" || block.kind === "quote") && !block.content.some((run) => run.t !== "text" || run.text.trim());

/** The editor's document as the page's blocks. An empty line is not a block (Markdown has no empty paragraph): the
 * empty lines above a block are counted on it (`blankBefore`) and written as blank lines; those at the end go. */
export function docToBlocks(doc: PmNode): EditBlock[] {
  const blocks: EditBlock[] = [];
  let empty = 0;
  doc.forEach((node) => {
    const block = nodeToBlock(node);
    if (!block) return;
    if (isEmptyLine(block)) { empty++; return; }
    blocks.push(blocks.length ? { ...block, blankBefore: empty } : block);
    empty = 0;
  });
  return blocks;
}

/** Pasted HTML with its lists flattened into what the editor holds: one block per item, with its kind (bullet,
 * numbered, to-do), its depth, and, for a to-do, whether it is done. Nested lists inside an item come after it. */
export function flattenLists(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const flatten = (list: Element, depth: number): Element[] => {
    const ordered = list.tagName === "OL";
    let number = Number(list.getAttribute("start") ?? 1) || 1;
    const out: Element[] = [];
    for (const li of [...list.children].filter((child) => child.tagName === "LI")) {
      const box = li.querySelector(":scope > input[type=checkbox], :scope > p > input[type=checkbox]") as HTMLInputElement | null;
      const item = doc.createElement("div");
      item.dataset.ntItem = box ? "task" : ordered ? "ordered" : "bullet";
      item.dataset.depth = String(depth);
      item.dataset.number = String(number++);
      if (box) { item.dataset.checked = String(box.checked || box.hasAttribute("checked")); box.remove(); }
      const nested: Element[] = [];
      for (const child of [...li.childNodes]) {
        if (child instanceof Element && (child.tagName === "UL" || child.tagName === "OL")) nested.push(...flatten(child, depth + 1));
        else if (child instanceof Element && child.tagName === "P") item.append(...child.childNodes, " ");
        else item.append(child);
      }
      out.push(item, ...nested);
    }
    return out;
  };
  for (const list of [...doc.body.querySelectorAll("ul, ol")].filter((list) => !list.parentElement?.closest("ul, ol"))) list.replaceWith(...flatten(list, 0));
  return doc.body.innerHTML;
}
