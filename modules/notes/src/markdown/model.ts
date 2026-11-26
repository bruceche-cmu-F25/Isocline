/** What a page is to the editor and the index: a list of top-level blocks, each with its words as inline runs
 * (docs/research/notes-editor.md 3.1). Pure data, the same on the home node and in the browser. Block ids never go
 * into the file: a block is known by where it was read from. */

export const MARKS = ["strong", "em", "strike", "code"] as const;
export type Mark = (typeof MARKS)[number];

export type Inline =
  /** Words, with the marks on them and the link they are part of. */
  | { t: "text"; text: string; marks?: Mark[]; href?: string }
  /** `[[target]]`, `[[target|alias]]`, `![[embed]]`: one piece, written back as it was until it is changed. */
  | { t: "wiki"; target: string; alias?: string; embed?: boolean; raw: string }
  /** Something the editor does not draw (inline math, `%%comment%%`, an image, HTML, a hard break): kept as written. */
  | { t: "atom"; raw: string };

export type ListKind = "bullet" | "ordered" | "task";

export type Block =
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "heading"; level: number; content: Inline[] }
  /** One list item, nested items flattened after it with a larger depth. */
  | { kind: "item"; list: ListKind; depth: number; checked?: boolean; number?: number; content: Inline[] }
  | { kind: "quote"; content: Inline[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "rule" }
  /** What the editor cannot draw as a block (a table, HTML, math, a callout, a footnote): edited as its source text,
   * written back exactly as shown, never generated. */
  | { kind: "raw"; text: string };

export type BlockKind = Block["kind"];

/** The words of some inline runs, with pieces kept as written. */
export function plainInline(content: readonly Inline[]): string {
  return content.map((run) => (run.t === "text" ? run.text : run.raw)).join("");
}

/** The words of a block: what "read back the same" compares, and what search and the index see. */
export function plainBlock(block: Block): string {
  switch (block.kind) {
    case "code": return block.text;
    case "raw": return block.text;
    case "rule": return "";
    default: return plainInline(block.content);
  }
}

/** The words a reader sees in a block: links by their shown text, pieces kept as written left out. */
export function readableBlock(block: Block): string {
  if (block.kind === "code" || block.kind === "raw") return block.text;
  if (block.kind === "rule") return "";
  return block.content.map((run) => (run.t === "text" ? run.text : run.t === "wiki" ? run.alias ?? run.target : "")).join("");
}

/** Equal marks, in any order. */
function sameMarks(a: readonly Mark[] = [], b: readonly Mark[] = []): boolean {
  return a.length === b.length && a.every((mark) => b.includes(mark));
}

/** Runs in their one written form: neighbours with the same marks joined, empty words dropped, marks in one order.
 * The editor joins neighbours the same way, so a block read and shown again compares equal to itself. */
export function normalizeInline(content: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const run of content) {
    if (run.t !== "text") { out.push(run); continue; }
    if (!run.text) continue;
    const marks = run.marks?.length ? MARKS.filter((mark) => run.marks!.includes(mark)) : undefined;
    const last = out[out.length - 1];
    if (last?.t === "text" && sameMarks(last.marks, marks) && last.href === run.href) {
      out[out.length - 1] = { ...last, text: last.text + run.text };
      continue;
    }
    out.push({ t: "text", text: run.text, ...(marks ? { marks } : {}), ...(run.href !== undefined ? { href: run.href } : {}) });
  }
  return out;
}

function sameInline(a: readonly Inline[], b: readonly Inline[]): boolean {
  const x = normalizeInline(a), y = normalizeInline(b);
  if (x.length !== y.length) return false;
  return x.every((run, i) => {
    const other = y[i];
    if (run.t !== other.t) return false;
    if (run.t === "text" && other.t === "text") return run.text === other.text && sameMarks(run.marks, other.marks) && run.href === other.href;
    if (run.t === "wiki" && other.t === "wiki") return run.raw === other.raw && run.target === other.target && run.alias === other.alias && !!run.embed === !!other.embed;
    return (run as { raw: string }).raw === (other as { raw: string }).raw;
  });
}

/** The same block: nothing about it would be written differently. A block that is the same as the one it was read
 * from is copied from the file, byte for byte. */
export function sameBlock(a: Block, b: Block): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "paragraph": case "quote": return sameInline(a.content, (b as typeof a).content);
    case "heading": return a.level === (b as typeof a).level && sameInline(a.content, (b as typeof a).content);
    case "item": {
      const o = b as typeof a;
      return a.list === o.list && a.depth === o.depth && !!a.checked === !!o.checked && sameInline(a.content, o.content);
    }
    case "code": return a.lang === (b as typeof a).lang && a.text === (b as typeof a).text;
    case "rule": return true;
    case "raw": return a.text === (b as typeof a).text;
  }
}

/** What "read back the same" compares for one block: its kind, the facts that make it that kind, and its words. */
export function signature(block: Block): string {
  switch (block.kind) {
    case "heading": return `heading:${block.level}|${plainBlock(block)}`;
    case "item": return `item:${block.list}:${block.depth}:${block.list === "task" ? !!block.checked : ""}|${plainBlock(block)}`;
    case "code": return `code:${block.lang}|${block.text}`;
    case "raw": return `raw|${block.text.trim()}`;
    default: return `${block.kind}|${plainBlock(block)}`;
  }
}

/** A short key for some words (white space not counted): how a to-do in a note is known to the todo list without an
 * id in the file (research 3.5). Two FNV-1a hashes, 16 hex characters; the same in the browser and on the home node. */
export function wordsKey(words: string): string {
  const text = words.replace(/\s+/g, " ").trim();
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000197) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** The todo source `ref` of the `index`-th block of a page, a to-do: its page, its words' key, and which of the
 * to-dos with the same words on the page it is (the second "call the client" is not the first). */
export function taskRef(library: string, page: string, blocks: readonly Block[], index: number): string | null {
  const block = blocks[index];
  if (block?.kind !== "item" || block.list !== "task") return null;
  const key = wordsKey(readableBlock(block));
  let nth = 0;
  for (let i = 0; i < index; i++) {
    const other = blocks[i];
    if (other.kind === "item" && other.list === "task" && wordsKey(readableBlock(other)) === key) nth++;
  }
  return `note:${library}:${page}#${key}:${nth}`;
}

/** Which block a to-do's ref points at in a page now: the same words, the same count; else, if its words changed,
 * nothing (it is not guessed). */
export function findTask(blocks: readonly Block[], key: string, nth: number): number {
  let seen = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind !== "item" || block.list !== "task" || wordsKey(readableBlock(block)) !== key) continue;
    if (seen === nth) return i;
    seen++;
  }
  return -1;
}
