/** Reads the Markdown a model writes in a reply into a small tree a page can draw (Markdown.tsx). Pure: no DOM.
 *
 * It is the part of Markdown replies use: paragraphs, headings, lists, quotes, fenced code, tables, rules; bold,
 * italic, strike, code, links. Three things differ from CommonMark, on purpose:
 * - `**` closes after punctuation with a letter right behind it (`**今天：**内容`), which CommonMark refuses and which
 *   Chinese replies write all the time;
 * - a line break in a paragraph is a line break;
 * - HTML is text, and an image is a link to it: a reply never makes the page fetch an address by itself.
 * Text that is still arriving reads as far as it has come: an open fence is code to the end, an open `**` is itself. */
import { linkParts } from "./links.ts";
import { readRow } from "./sections.ts";

export type Inline =
  | string
  | { kind: "strong" | "em" | "del"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; url: string; children: Inline[] }
  | { kind: "break" };

export type Align = "left" | "center" | "right" | null;
/** `checked` is set on a task (`- [ ]`, `- [x]`). */
export interface ListItem { checked?: boolean; blocks: Block[] }
export type Block =
  | { kind: "p"; children: Inline[] }
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; blocks: Block[] }
  /** `loose`: its items were written with blank lines between them. */
  | { kind: "list"; ordered: boolean; start: number; loose: boolean; items: ListItem[] }
  | { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

// ── Inline ──

/** A run of `*`, `_` or `~` that may start or end emphasis; what is left of it at the end is text. */
interface Delim { ch: string; count: number; canOpen: boolean; canClose: boolean }
type Piece = Inline | Delim;
const isDelim = (piece: Piece): piece is Delim => typeof piece === "object" && "ch" in piece;

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const ENTITY = /&(?:amp|lt|gt|quot|#39|nbsp);/y;
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const ANGLED = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/y;
const BARE = /(?:https?:\/\/|www\.)\S+/iy;
const TITLE = /\s+(?:"[^"]*"|'[^']*'|\([^)]*\))/y;

/** Where a link may lead: the web or a mail address. Anything else (`javascript:`, a file path) is not a link. */
function safeUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

function runLength(text: string, from: number, ch: string): number {
  let end = from;
  while (text[end] === ch) end++;
  return end - from;
}

/** `[label](address "title")` with its `[` at `open`. */
function linkAt(text: string, open: number): { label: string; href: string; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let at = open; at < text.length; at++) {
    const ch = text[at];
    if (ch === "\\") at++;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) { close = at; break; }
  }
  if (close < 0 || text[close + 1] !== "(") return null;
  let at = close + 2;
  while (text[at] === " ") at++;
  let href: string;
  if (text[at] === "<") {
    const end = text.indexOf(">", at);
    if (end < 0) return null;
    href = text.slice(at + 1, end);
    at = end + 1;
  } else {
    const start = at;
    for (let parens = 0; at < text.length; at++) {
      const ch = text[at]!;
      if (ch === "\\") { at++; continue; }
      if (SPACE.test(ch)) break;
      if (ch === "(") parens++;
      else if (ch === ")" && parens-- === 0) break;
    }
    href = text.slice(start, at).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  TITLE.lastIndex = at;
  const title = TITLE.exec(text);
  if (title) at += title[0].length;
  while (text[at] === " ") at++;
  if (text[at] !== ")" || !href) return null;
  return { label: text.slice(open + 1, close), href, end: at + 1 };
}

/** Delimiters become text, and neighbouring text becomes one piece. */
function settle(pieces: Piece[]): Inline[] {
  const out: Inline[] = [];
  for (const piece of pieces) {
    const next = isDelim(piece) ? piece.ch.repeat(piece.count) : piece;
    if (next === "") continue;
    const last = out.at(-1);
    if (typeof next === "string" && typeof last === "string") out[out.length - 1] = last + next;
    else out.push(next);
  }
  return out;
}

/** Pairs each closing run with the nearest opening run of the same mark before it. */
function emphasise(pieces: Piece[]): Inline[] {
  for (let c = 0; c < pieces.length; c++) {
    const closer = pieces[c]!;
    if (!isDelim(closer) || !closer.canClose) continue;
    let o = c - 1;
    for (; o >= 0; o--) {
      const candidate = pieces[o]!;
      if (isDelim(candidate) && candidate.ch === closer.ch && candidate.canOpen) break;
    }
    if (o < 0) continue;
    const opener = pieces[o] as Delim;
    const use = closer.ch === "~" || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
    const kind = closer.ch === "~" ? "del" : use === 2 ? "strong" : "em";
    opener.count -= use;
    closer.count -= use;
    pieces.splice(o + 1, c - o - 1, { kind, children: settle(pieces.slice(o + 1, c)) });
    // Now: opener at o, the new piece at o + 1, closer at o + 2. Spent runs go; a closer with marks left is read again.
    c = o + 2;
    if (closer.count === 0) pieces.splice(c, 1);
    if (opener.count === 0) { pieces.splice(o, 1); c--; }
    c--;
  }
  return settle(pieces);
}

export function parseInline(text: string, inLink = false): Inline[] {
  const pieces: Piece[] = [];
  let plain = "";
  const push = (piece: Piece) => { if (plain) { pieces.push(plain); plain = ""; } pieces.push(piece); };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "\n") { push({ kind: "break" }); i += 2; continue; }
      if (next && PUNCT.test(next)) { plain += next; i += 2; continue; }
    }
    if (ch === "\n") { plain = plain.replace(/ +$/, ""); push({ kind: "break" }); i++; continue; }
    if (ch === "`") {
      const run = runLength(text, i, "`");
      let close = -1;
      for (let at = text.indexOf("`", i + run); at >= 0; at = text.indexOf("`", at)) {
        const length = runLength(text, at, "`");
        if (length === run) { close = at; break; }
        at += length;
      }
      if (close < 0) { plain += "`".repeat(run); i += run; continue; }
      let code = text.slice(i + run, close).replace(/\n/g, " ");
      if (code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      push({ kind: "code", text: code });
      i = close + run;
      continue;
    }
    if (!inLink && (ch === "[" || (ch === "!" && text[i + 1] === "["))) {
      const link = linkAt(text, ch === "!" ? i + 1 : i);
      if (link) {
        const children = parseInline(link.label, true);
        const url = safeUrl(link.href);
        if (url) push({ kind: "link", url, children: children.length ? children : [link.href] });
        else for (const child of children) push(child);
        i = link.end;
        continue;
      }
    }
    if (!inLink && ch === "<") {
      ANGLED.lastIndex = i;
      const match = ANGLED.exec(text);
      const url = match && safeUrl(match[1]!);
      if (match && url) { push({ kind: "link", url, children: [match[1]!] }); i += match[0].length; continue; }
    }
    if (!inLink && (ch === "h" || ch === "H" || ch === "w" || ch === "W") && !/[A-Za-z0-9@.]/.test(text[i - 1] ?? "")) {
      BARE.lastIndex = i;
      const match = BARE.exec(text);
      if (match) {
        // The address stops where Markdown starts again: `**https://a.example**`.
        let candidate = match[0];
        const cut = candidate.search(/\*\*|~~|`/);
        if (cut >= 0) candidate = candidate.slice(0, cut);
        const [first] = linkParts(candidate.replace(/\*+$/, ""));
        if (first && typeof first !== "string") { push({ kind: "link", url: first.url, children: [first.text] }); i += first.text.length; continue; }
      }
    }
    if (ch === "&") {
      ENTITY.lastIndex = i;
      const match = ENTITY.exec(text);
      if (match) { plain += ENTITIES[match[0]]; i += match[0].length; continue; }
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const count = runLength(text, i, ch);
      const before = text[i - 1] ?? " ";
      const after = text[i + count] ?? " ";
      let canOpen = !SPACE.test(after);
      let canClose = !SPACE.test(before);
      // `_` inside a word is part of the word: snake_case_name.
      if (ch === "_") { canOpen &&= !WORD.test(before); canClose &&= !WORD.test(after); }
      if ((ch === "~" && count < 2) || (!canOpen && !canClose)) plain += ch.repeat(count);
      else push({ ch, count, canOpen, canClose });
      i += count;
      continue;
    }
    plain += ch;
    i++;
  }
  if (plain) pieces.push(plain);
  return emphasise(pieces);
}

// ── Blocks ──

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
/** indent, marker, the spaces after it, the rest. A marker alone on its line is an empty item. */
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:( +)(.*)|$)/;
const TABLE_RULE = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
const TASK = /^\[([ xX])\][ \t]+/;

const leading = (line: string) => line.length - line.trimStart().length;
const blank = (line: string | undefined) => line !== undefined && !line.trim();

/** The cells of a table row: split at `|`, but not at `\|` nor inside code. */
function cells(line: string): string[] {
  const text = line.trim();
  const out: string[] = [];
  let cell = "";
  let code = false;
  for (let at = 0; at < text.length; at++) {
    const ch = text[at]!;
    if (ch === "\\" && text[at + 1] === "|") { cell += "|"; at++; continue; }
    if (ch === "`") code = !code;
    if (ch === "|" && !code) { out.push(cell); cell = ""; continue; }
    cell += ch;
  }
  out.push(cell);
  if (text.startsWith("|")) out.shift();
  if (text.endsWith("|") && !text.endsWith("\\|")) out.pop();
  return out.map((value) => value.trim());
}

/** A table starts where a row is followed by its rule (`|---|:-:|`) with as many cells. */
function tableAt(lines: string[], at: number): boolean {
  const rule = lines[at + 1];
  return lines[at]!.includes("|") && rule !== undefined && TABLE_RULE.test(rule) && cells(lines[at]!).length === cells(rule).length;
}

/** Whether the line at `at` ends the paragraph above it. A numbered list only does when it starts at 1, so a line
 * that happens to begin with `2026.` stays in its paragraph. */
function interrupts(lines: string[], at: number): boolean {
  const line = lines[at]!;
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || tableAt(lines, at)) return true;
  const item = ITEM.exec(line);
  return !!item && !!item[4] && (!/\d/.test(item[2]!) || parseInt(item[2]!, 10) === 1);
}

function readList(lines: string[], start: number): { list: Block; next: number } {
  const first = ITEM.exec(lines[start]!)!;
  const indent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  // The next item of this list: the same kind of marker, no deeper than a child would be.
  const sibling = (line: string | undefined) => {
    const match = line === undefined || RULE.test(line) ? null : ITEM.exec(line);
    return match && match[1]!.length >= indent && match[1]!.length < indent + 2 && /\d/.test(match[2]!) === ordered ? match : null;
  };
  const items: ListItem[] = [];
  let loose = false;
  let i = start;
  for (let match = sibling(lines[i]); match; match = sibling(lines[i])) {
    const gap = match[3]?.length ?? 1;
    const inside = match[1]!.length + match[2]!.length + (gap > 4 ? 1 : gap);
    const body = [match[4] ?? ""];
    i++;
    // What is indented under the item is the item's: more text, a nested list, a code block.
    while (i < lines.length) {
      if (blank(lines[i])) {
        let after = i + 1;
        while (blank(lines[after])) after++;
        if (after >= lines.length || leading(lines[after]!) < indent + 2) break;
        for (; i < after; i++) body.push("");
        continue;
      }
      const depth = leading(lines[i]!);
      if (depth < indent + 2) break;
      body.push(lines[i]!.slice(Math.min(depth, inside)));
      i++;
    }
    const task = TASK.exec(body[0]!);
    if (task) body[0] = body[0]!.slice(task[0].length);
    items.push({ ...(task ? { checked: task[1] !== " " } : {}), blocks: parseBlocks(body) });
    let after = i;
    while (blank(lines[after])) after++;
    if (after > i && sibling(lines[after])) { loose = true; i = after; }
  }
  return { list: { kind: "list", ordered, start: ordered ? parseInt(first[2]!, 10) : 1, loose, items }, next: i };
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence[2]![0]}{${fence[2]!.length},}[ \\t]*$`);
      const body: string[] = [];
      for (i++; i < lines.length && !closing.test(lines[i]!); i++) body.push(lines[i]!.slice(Math.min(leading(lines[i]!), fence[1]!.length)));
      i++;
      blocks.push({ kind: "code", lang: fence[3]!, text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: "heading", level: heading[1]!.length, children: parseInline(heading[2] ?? "") }); i++; continue; }
    if (RULE.test(line)) { blocks.push({ kind: "rule" }); i++; continue; }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]!); i++) inner.push(lines[i]!.replace(QUOTE, ""));
      blocks.push({ kind: "quote", blocks: parseBlocks(inner) });
      continue;
    }
    if (ITEM.test(line)) {
      const { list, next } = readList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    if (tableAt(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((rule): Align => rule.startsWith(":") && rule.endsWith(":") ? "center" : rule.endsWith(":") ? "right" : rule.startsWith(":") ? "left" : null);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && !blank(lines[i]) && lines[i]!.includes("|"); i++) {
        const row = cells(lines[i]!);
        rows.push(head.map((_, column) => parseInline(row[column] ?? "")));
      }
      blocks.push({ kind: "table", align, head: head.map((cell) => parseInline(cell)), rows });
      continue;
    }
    const text = [line.trim()];
    for (i++; i < lines.length && !blank(lines[i]) && !interrupts(lines, i); i++) text.push(lines[i]!.trim());
    blocks.push({ kind: "p", children: parseInline(text.join("\n")) });
  }
  return blocks;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/^[ \t]+/, (space) => space.replace(/\t/g, "    ")));
  return parseBlocks(lines);
}

// ── As plain text ──

const inlineText = (nodes: Inline[]): string => nodes.map((node) =>
  typeof node === "string" ? node : node.kind === "code" ? node.text : node.kind === "break" ? "\n" : inlineText(node.children)).join("");

function readingLabel(children: Inline[]): { title: Inline[]; body: Inline[] } | null {
  const [label, ...body] = children;
  if (!label || typeof label === "string" || label.kind !== "strong") return null;
  const labelText = inlineText(label.children);
  if (labelText.includes("\n") || !/[\p{L}\p{N}\p{S}]/u.test(labelText)) return null;

  const title: Inline[] = [label];
  if (!/[:：]$/.test(labelText)) {
    const after = body[0];
    if (typeof after !== "string" || !/^[:：]/.test(after)) return null;
    title.push(after[0]!);
    if (after.length === 1) body.shift();
    else body[0] = after.slice(1);
  }
  return /[\p{L}\p{N}\p{S}]/u.test(inlineText(body)) ? { title, body } : null;
}

/** A bold label followed by its paragraph can serve as a section heading in an Inbox article.
 * Work on top-level blocks so quoted mail, lists, tables and code keep their authored structure. */
export function inboxReadingBlocks(blocks: Block[]): Block[] {
  const result: Block[] = [];
  let labelLevel = 1;
  for (const block of blocks) {
    if (block.kind === "heading") labelLevel = Math.min(block.level + 1, 6);
    const label = block.kind === "p" ? readingLabel(block.children) : null;
    if (label) result.push({ kind: "heading", level: labelLevel, children: label.title }, { kind: "p", children: label.body });
    else result.push(block);
  }
  return result;
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "p": case "heading": return inlineText(block.children);
    case "code": return block.text;
    case "quote": return block.blocks.map(blockText).join("\n");
    case "list": return block.items.map((item, index) => {
      const mark = item.checked !== undefined ? (item.checked ? "☑" : "☐") : block.ordered ? `${block.start + index}.` : "•";
      return `${mark} ${item.blocks.map(blockText).join("\n").replace(/\n/g, "\n  ")}`;
    }).join("\n");
    case "table": return [block.head, ...block.rows].map((row) => row.map(inlineText).join(" · ")).join("\n");
    case "rule": return "";
  }
}

/** A reply without its Markdown, for where it is shown as one piece of plain text: a notification, a one-line preview. */
export function plainText(text: string): string {
  // A result in sections tags its rows and cites what they are about (`[Risk] … (mail:ID)`, sections.ts); the page
  // that draws it reads those, a preview drops them.
  return parseMarkdown(text).map(blockText).filter(Boolean).join("\n").split("\n").map((line) => {
    const mark = /^\s*(?:[•☐☑]|\d+\.)\s+/.exec(line)?.[0] ?? "";
    return mark + readRow(line.slice(mark.length)).text;
  }).join("\n");
}
