/** Reading a page: the file's text into top-level blocks, each knowing exactly where it was in the text
 * (docs/research/notes-editor.md 3.1). GFM, frontmatter, math and Obsidian links are recognised while reading, so a
 * formula or an alias link is one piece kept as written, never words that a later edit would write back wrong. What
 * the editor cannot draw becomes a `raw` block: shown as its source, written back exactly as shown. */
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import type { List, ListItem, Nodes, Paragraph, PhrasingContent, RootContent, Table } from "mdast";
import { normalizeInline, type Align, type Block, type Inline, type ListKind, type Mark } from "./model.ts";
import { splitWikiLink, wikiLinkFromMarkdown, wikiLinkSyntax, type WikiLinkNode } from "./wikilink.ts";

/** A block as read: what it is, and where its text starts and ends in the body. */
export interface SourceBlock {
  block: Block;
  start: number;
  end: number;
  /** For a list item: the white space before its marker on its line, and the marker itself (`- `, `1. `, `- [ ] `). */
  indent?: string;
  marker?: string;
}

export interface Frontmatter {
  /** Where the properties end in the body (after the closing `---`). */
  end: number;
  /** The simple `key: value` lines, as written (quotes taken off). Other lines are kept, not read. */
  props: Record<string, string>;
}

export interface ParsedPage {
  /** The text without its byte order mark; every offset is into this. */
  body: string;
  bom: boolean;
  eol: "\n" | "\r\n";
  front: Frontmatter | null;
  blocks: SourceBlock[];
}

const OPTIONS = {
  extensions: [frontmatter(["yaml"]), gfm(), math(), wikiLinkSyntax],
  mdastExtensions: [frontmatterFromMarkdown(["yaml"]), gfmFromMarkdown(), mathFromMarkdown(), wikiLinkFromMarkdown],
};

const startOf = (node: { position?: { start: { offset?: number } } }) => node.position!.start.offset!;
const endOf = (node: { position?: { end: { offset?: number } } }) => node.position!.end.offset!;

/** `%%comment%%` inside words: Obsidian's, not CommonMark's, so it is one piece kept as written. */
const COMMENT = /%%[\s\S]*?%%/g;

function textRuns(value: string, source: string, marks: Mark[], href?: string): Inline[] {
  const run = (text: string): Inline => ({ t: "text", text, ...(marks.length ? { marks: [...marks] } : {}), ...(href !== undefined ? { href } : {}) });
  // Only where the words are written as they read: with escapes in them, offsets in the two would differ.
  if (value !== source || !value.includes("%%")) return [run(value)];
  const out: Inline[] = [];
  let at = 0;
  for (const found of value.matchAll(COMMENT)) {
    if (found.index > at) out.push(run(value.slice(at, found.index)));
    out.push({ t: "atom", raw: found[0] });
    at = found.index + found[0].length;
  }
  if (at < value.length) out.push(run(value.slice(at)));
  return out;
}

function inlineOf(nodes: readonly (PhrasingContent | WikiLinkNode)[], body: string, marks: Mark[] = [], href?: string): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    const raw = body.slice(startOf(node), endOf(node));
    switch (node.type) {
      case "text": out.push(...textRuns(node.value, raw, marks, href)); break;
      case "strong": out.push(...inlineOf(node.children, body, [...marks, "strong"], href)); break;
      case "emphasis": out.push(...inlineOf(node.children, body, [...marks, "em"], href)); break;
      case "delete": out.push(...inlineOf(node.children, body, [...marks, "strike"], href)); break;
      case "inlineCode": out.push({ t: "text", text: node.value, marks: [...marks, "code"], ...(href !== undefined ? { href } : {}) }); break;
      case "link":
        // A plain `[words](url)` is words with a link on them; a bare address, `<url>` or a link with a title is
        // kept as written, so it is not rewritten into another form.
        if (href === undefined && raw.startsWith("[") && raw.endsWith(")") && !node.title) out.push(...inlineOf(node.children, body, marks, node.url));
        else out.push({ t: "atom", raw });
        break;
      case "wikiLink": {
        const { target, alias } = splitWikiLink(node.value);
        out.push({ t: "wiki", target, ...(alias !== undefined ? { alias } : {}), ...(node.embed ? { embed: true } : {}), raw });
        break;
      }
      default: out.push({ t: "atom", raw }); break;
    }
  }
  return normalizeInline(out);
}

function lineIndent(body: string, at: number): string {
  return body.slice(body.lastIndexOf("\n", at - 1) + 1, at);
}

function listItems(list: List, depth: number, body: string, out: SourceBlock[]): void {
  list.children.forEach((item: ListItem, i: number) => {
    const [first, ...rest] = item.children;
    const simple = (!first || first.type === "paragraph") && rest.every((child) => child.type === "list");
    const start = startOf(item);
    if (!simple) {
      out.push({ block: { kind: "raw", text: body.slice(start, endOf(item)) }, start, end: endOf(item) });
      return;
    }
    const kind: ListKind = typeof item.checked === "boolean" ? "task" : list.ordered ? "ordered" : "bullet";
    const end = first ? endOf(first) : endOf(item);
    const marker = first ? body.slice(start, startOf(first)) : body.slice(start, end);
    out.push({
      block: {
        kind: "item", list: kind, depth,
        ...(kind === "task" ? { checked: !!item.checked } : {}),
        ...(list.ordered ? { number: (list.start ?? 1) + i } : {}),
        content: first ? inlineOf((first as Paragraph).children, body) : [],
      },
      start, end, indent: lineIndent(body, start), marker,
    });
    for (const child of rest) listItems(child as List, depth + 1, body, out);
  });
}

/** A callout (`> [!note]`) or a quote of more than one paragraph is kept as written. */
function simpleQuote(node: RootContent, body: string): Paragraph | null {
  if (node.type !== "blockquote" || node.children.length !== 1 || node.children[0].type !== "paragraph") return null;
  const raw = body.slice(startOf(node), endOf(node));
  if (/^>\s*\[!/.test(raw)) return null;
  // Every line marked: a lazy line (no `>`) would not be written back the same way.
  if (raw.split(/\r?\n/).some((line) => !/^\s*>/.test(line))) return null;
  return node.children[0];
}

function parseProps(raw: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const found = /^([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!found) continue;
    let value = found[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    props[found[1]] = value;
  }
  return props;
}

const CALLOUT = /^>[ \t]*\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/;

/** A callout of one paragraph: its type, fold, title (the rest of its first line) and its words after that line. A
 * callout with more than one paragraph, a list or a nested quote stays as written. */
function callout(node: RootContent, body: string): Block | null {
  if (node.type !== "blockquote" || node.children.length !== 1 || node.children[0].type !== "paragraph") return null;
  const raw = body.slice(startOf(node), endOf(node));
  const lines = raw.split(/\r?\n/);
  const head = CALLOUT.exec(lines[0]);
  if (!head || lines.some((line) => !/^\s*>/.test(line))) return null;
  const runs = inlineOf(node.children[0].children, body);
  // The first line of the paragraph is the header; the words start after its line break.
  const content: Inline[] = [];
  let past = false;
  for (const run of runs) {
    if (past) { content.push(run); continue; }
    if (run.t !== "text") continue;
    const at = run.text.indexOf("\n");
    if (at === -1) continue;
    past = true;
    const rest = run.text.slice(at + 1);
    if (rest) content.push({ ...run, text: rest });
  }
  if (!past && lines.length > 1) return null;
  return { kind: "callout", type: head[1], fold: head[2] as "" | "+" | "-", title: head[3].trim(), content: normalizeInline(content) };
}

function table(node: Table, body: string): Block {
  const align: Align[] = (node.align ?? []).map((one) => (one === "left" || one === "right" || one === "center" ? one : null));
  const width = Math.max(align.length, ...node.children.map((row) => row.children.length));
  const rows = node.children.map((row) => Array.from({ length: width }, (_, i) => (row.children[i] ? inlineOf(row.children[i].children, body) : [])));
  return { kind: "table", align: Array.from({ length: width }, (_, i) => align[i] ?? null), rows };
}

export function parsePage(text: string): ParsedPage {
  const bom = text.startsWith("﻿");
  const body = bom ? text.slice(1) : text;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const root = fromMarkdown(body, OPTIONS as never);
  const blocks: SourceBlock[] = [];
  let front: Frontmatter | null = null;
  for (const node of root.children as RootContent[]) {
    const start = startOf(node), end = endOf(node);
    const raw = (): SourceBlock => ({ block: { kind: "raw", text: body.slice(start, end) }, start, end });
    switch (node.type) {
      case "yaml":
        if (start === 0) front = { end, props: parseProps(node.value) };
        else blocks.push(raw());
        break;
      case "paragraph": blocks.push({ block: { kind: "paragraph", content: inlineOf(node.children, body) }, start, end }); break;
      case "heading": blocks.push({ block: { kind: "heading", level: node.depth, content: inlineOf(node.children, body) }, start, end }); break;
      case "thematicBreak": blocks.push({ block: { kind: "rule" }, start, end }); break;
      case "code":
        // Words after the language (`js title="a"`) would be lost if the block were written again: kept as written.
        blocks.push(node.meta ? raw() : { block: { kind: "code", lang: node.lang ?? "", text: node.value }, start, end });
        break;
      case "table": blocks.push({ block: table(node, body), start, end }); break;
      case "blockquote": {
        const box = callout(node, body);
        if (box) { blocks.push({ block: box, start, end }); break; }
        const paragraph = simpleQuote(node, body);
        blocks.push(paragraph ? { block: { kind: "quote", content: inlineOf(paragraph.children, body) }, start, end } : raw());
        break;
      }
      case "list": listItems(node, 0, body, blocks); break;
      default: blocks.push(raw()); break;
    }
  }
  return { body, bom, eol, front, blocks };
}

/** The blocks alone. */
export function readBlocks(text: string): Block[] {
  return parsePage(text).blocks.map((source) => source.block);
}

export type { Nodes };
