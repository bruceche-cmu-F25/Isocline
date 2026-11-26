/** The editor's document (docs/research/notes-editor.md 3.2): one node per top-level block of the page, the same
 * blocks the home node reads (@zirma/module-notes/markdown). A list item is a block with its kind and depth, not a
 * nested list, so each item is written back on its own. What the editor cannot draw is a `raw` block, edited as its
 * source; links to pages and pieces kept as written are single inline nodes. Nothing here knows about saving. */
import { Schema, type Mark as PmMark, type Node as PmNode } from "prosemirror-model";
import { normalizeInline, type Block, type Inline, type Mark } from "@zirma/module-notes/markdown";

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
    },
    quote: { group: "block", content: "inline*", defining: true, parseDOM: [{ tag: "blockquote" }], toDOM: () => ["blockquote", 0] },
    code_block: {
      group: "block", content: "text*", marks: "", code: true, defining: true, attrs: { lang: { default: "" } },
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }], toDOM: (node) => ["pre", { "data-lang": node.attrs.lang || undefined }, ["code", 0]],
    },
    rule: { group: "block", parseDOM: [{ tag: "hr" }], toDOM: () => ["div", { class: "nt-rule" }, ["hr"]] },
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
      toDOM: (node) => ["span", { class: "nt-atom", title: node.attrs.raw }, (node.attrs.raw as string).replace(/\r?\n/g, " ")],
    },
  },
  marks: {
    strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
    strike: { parseDOM: [{ tag: "s" }, { tag: "del" }], toDOM: () => ["s", 0] },
    code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0], excludes: "_" },
    link: { attrs: { href: {} }, inclusive: false, toDOM: (mark) => ["a", { href: mark.attrs.href, class: "nt-link", rel: "noopener noreferrer", target: "_blank" }, 0] },
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

/** The page's blocks as the editor's document. */
export function blocksToDoc(blocks: readonly Block[]): PmNode {
  const nodes = blocks.map((block): PmNode => {
    switch (block.kind) {
      case "paragraph": return schema.nodes.paragraph.create(null, inlineToPm(block.content));
      case "heading": return schema.nodes.heading.create({ level: block.level }, inlineToPm(block.content));
      case "item": return schema.nodes.item.create({ list: block.list, depth: block.depth, checked: !!block.checked, number: block.number ?? 1 }, inlineToPm(block.content));
      case "quote": return schema.nodes.quote.create(null, inlineToPm(block.content));
      case "code": return schema.nodes.code_block.create({ lang: block.lang }, block.text ? schema.text(block.text) : null);
      case "rule": return schema.nodes.rule.create();
      case "raw": return schema.nodes.raw.create(null, block.text ? schema.text(block.text) : null);
    }
  });
  return schema.nodes.doc.create(null, nodes.length ? nodes : [schema.nodes.paragraph.create()]);
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
    case "raw": return { kind: "raw", text: node.textContent };
    default: return null;
  }
}

/** The editor's document as the page's blocks. An empty document is an empty page. */
export function docToBlocks(doc: PmNode): Block[] {
  const blocks: Block[] = [];
  doc.forEach((node) => { const block = nodeToBlock(node); if (block) blocks.push(block); });
  // An empty line is space on the screen, not a block: Markdown has no empty paragraph (it would read back as nothing).
  return blocks.filter((block) => !((block.kind === "paragraph" || block.kind === "quote") && !block.content.some((run) => run.t !== "text" || run.text.trim())));
}
