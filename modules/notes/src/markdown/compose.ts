/** Putting a page back together (docs/research/notes-editor.md 3.1): blocks the user did not change are copied
 * from the file byte for byte, changed and new ones are written, and the gaps between them are the file's own where
 * nothing around them changed. Then the result is read again: if the blocks read back are not the editor's blocks
 * (kind, words, order), the neighbours are written again too; if that still fails, nothing is saved. */
import { readBlocks, parsePage, type ParsedPage } from "./parse.ts";
import { sameBlock, signature, type Block } from "./model.ts";
import { blockMarkdown, contentWidth, itemMarker } from "./serialize.ts";

/** A block in the editor: `from` is the index of the block it was read from, if it was read from the file. */
export type EditBlock = Block & { from?: number };

export type Composed = { ok: true; text: string } | { ok: false; reason: string };

const BLANK = /\n[ \t]*\r?\n/;

/** What "the same words" means when reading back: in words (not code, not kept source) white space is white
 * space, however much and wherever; Markdown keeps line breaks in a paragraph but not in a heading. */
export function comparable(block: Block): string {
  const sig = signature(block);
  if (block.kind === "code" || block.kind === "raw") return sig.replace(/[ \t]+(\r?\n)/g, "$1").trim();
  return sig.replace(/\s+/g, " ").trim();
}

function sameReadBack(text: string, blocks: readonly Block[]): boolean {
  const read = readBlocks(text);
  return read.length === blocks.length && read.every((block, i) => comparable(block) === comparable(blocks[i]));
}

function build(page: ParsedPage, blocks: readonly EditBlock[], rewrite: ReadonlySet<number>): string {
  const { body, front, eol } = page;
  const src = page.blocks;
  const kept = blocks.map((block, i) => block.from !== undefined && !rewrite.has(i) && src[block.from] !== undefined && sameBlock(block, src[block.from].block)
    // A rule moved to the very top is written again (as `***`): `---` there would open properties.
    && !(i === 0 && !front && block.kind === "rule" && block.from !== 0));
  const indents: string[] = [];
  const markers: string[] = [];
  const toEol = (text: string) => (eol === "\n" ? text : text.replace(/\r?\n/g, "\r\n"));

  // Indentation of each list item: its own when it keeps its depth, else under the item it now sits in.
  blocks.forEach((block, i) => {
    const source = block.from !== undefined ? src[block.from] : undefined;
    if (block.kind !== "item") { indents.push(""); markers.push(""); return; }
    markers.push(kept[i] ? source!.marker ?? "" : itemMarker(block, source?.marker));
    const own = source?.block.kind === "item" && source.block.depth === block.depth ? source.indent : undefined;
    if (own !== undefined) { indents.push(own); return; }
    if (block.depth === 0) { indents.push(""); return; }
    let found: string | undefined;
    for (let j = i - 1; j >= 0 && found === undefined; j--) {
      const above = blocks[j];
      if (above.kind !== "item") break;
      if (above.depth === block.depth) found = indents[j];
      else if (above.depth === block.depth - 1) found = indents[j] + " ".repeat(contentWidth(markers[j]));
    }
    indents.push(found ?? "  ".repeat(block.depth));
  });

  const originalGap = (a: number | undefined, b: number | undefined): string | null => {
    if (a !== undefined && b !== undefined && b === a + 1) return body.slice(src[a].end, src[b].start);
    if (b !== undefined && b > 0) return body.slice(src[b - 1].end, src[b].start);
    if (a !== undefined && a + 1 < src.length) return body.slice(src[a].end, src[a + 1].start);
    return null;
  };
  const gap = (i: number): string => {
    const a = blocks[i - 1], b = blocks[i];
    if (kept[i - 1] && kept[i] && b.from === a.from! + 1) return body.slice(src[a.from!].end, src[b.from!].start);
    const was = originalGap(a.from, b.from);
    const sameDepth = b.from !== undefined && src[b.from].block.kind === "item" && (src[b.from].block as { depth: number }).depth === (b as { depth?: number }).depth;
    if (a.kind === "item" && b.kind === "item") {
      if (was !== null && sameDepth && /^\s*$/.test(was) && b.from !== undefined && a.from !== undefined && b.from === a.from + 1) return was;
      return toEol("\n") + indents[i];
    }
    if (was !== null && BLANK.test(was) && /^\s*$/.test(was) && (b.kind !== "item" || sameDepth)) return was;
    return toEol("\n\n") + indents[i];
  };

  const frontEnd = front?.end ?? 0;
  let out = body.slice(0, frontEnd);
  if (blocks.length) {
    const first = blocks[0];
    const leading = src.length ? body.slice(frontEnd, src[0].start) : body.slice(frontEnd);
    if (kept[0] && first.from === 0) out += leading;
    else if (front) out += BLANK.test(leading) ? leading : toEol("\n\n");
    else out += /^\s*$/.test(leading) && first.from === 0 ? leading : "";
    if (!(kept[0] && first.from === 0)) out += indents[0];
  }
  blocks.forEach((block, i) => {
    if (i > 0) out += gap(i);
    // A rule at the very top would open properties (`---`): written there as `***`.
    const written = i === 0 && !front && block.kind === "rule" ? "***" : blockMarkdown(block, block.from !== undefined ? src[block.from].marker : undefined);
    out += kept[i] ? body.slice(src[block.from!].start, src[block.from!].end) : toEol(written);
  });
  const last = blocks[blocks.length - 1];
  const trailing = src.length ? body.slice(src[src.length - 1].end) : front ? body.slice(frontEnd) : body;
  if (!blocks.length) out += front ? trailing : "";
  else if (last.from === src.length - 1 && /^\s*$/.test(trailing)) out += trailing;
  else if (kept[blocks.length - 1] && last.from === src.length - 1) out += trailing;
  else out += /^\s*$/.test(trailing) && trailing ? (trailing.includes("\n") ? eol : "") : body.endsWith("\n") || !body ? eol : "";
  return (page.bom ? "﻿" : "") + out;
}

/** The page's new text, or why it could not be written so that it reads back as the editor shows it. */
export function compose(page: ParsedPage, given: readonly EditBlock[]): Composed {
  const blocks = fitDepths(given);
  const plain = blocks.map(({ from: _from, ...block }) => block as Block);
  const changed = new Set<number>();
  const unchanged = blocks.every((block, i) => block.from === i && page.blocks[i] && sameBlock(block, page.blocks[i].block)) && blocks.length === page.blocks.length;
  if (unchanged) return { ok: true, text: (page.bom ? "﻿" : "") + page.body };
  let text = build(page, blocks, changed);
  if (sameReadBack(text, plain)) return { ok: true, text };
  // Write the neighbours of every changed block again too.
  blocks.forEach((block, i) => {
    const kept = block.from !== undefined && page.blocks[block.from] && sameBlock(block, page.blocks[block.from].block);
    if (!kept) { changed.add(i - 1); changed.add(i + 1); }
  });
  text = build(page, blocks, changed);
  if (sameReadBack(text, plain)) return { ok: true, text };
  return { ok: false, reason: "The page would not read back as it is shown" };
}

/** List items as Markdown can nest them: an item is at most one level deeper than the item above it, and an item
 * after anything but an item starts at the top. The editor keeps this already; a block list from elsewhere is fitted. */
export function fitDepths<T extends Block>(blocks: readonly T[]): T[] {
  let above = -1;
  return blocks.map((block) => {
    if (block.kind !== "item") { above = -1; return block; }
    const depth = Math.min(block.depth, above + 1);
    above = depth;
    return depth === block.depth ? block : { ...block, depth };
  });
}

/** A page's text from blocks alone (a new page, or "save as a new page" after a failed save): every block written. */
export function writeBlocks(blocks: readonly Block[], eol: "\n" | "\r\n" = "\n"): string {
  const empty = parsePage("");
  return build({ ...empty, eol }, fitDepths(blocks), new Set());
}

/**
 * Which block in the file each of the editor's blocks was read from, found again from the blocks alone, so the
 * editor keeps no ids (research 3.1: block ids live only in memory). Blocks that are the same as one in the file are
 * matched in order (longest common sequence); between two matches, a changed block takes the file's block of the
 * same kind in the same place, so an edited list item keeps its `*` and an edited paragraph its blank lines.
 */
export function assignSources(page: ParsedPage, blocks: readonly Block[]): EditBlock[] {
  const src = page.blocks.map((source) => source.block);
  const n = blocks.length, m = src.length;
  // Longest common sequence of equal blocks (pages are small; a big page is a few thousand blocks).
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = sameBlock(blocks[i], src[j]) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const from: (number | undefined)[] = new Array(n).fill(undefined);
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (sameBlock(blocks[i], src[j])) { from[i] = j; pairs.push([i, j]); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  // Between matches: changed blocks paired with the file's unmatched blocks there, in order, by kind.
  const bounds: Array<[number, number]> = [[-1, -1], ...pairs, [n, m]];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [i0, j0] = bounds[k], [i1, j1] = bounds[k + 1];
    let j = j0 + 1;
    for (let i = i0 + 1; i < i1 && j < j1; i++) {
      const kindAt = (index: number) => src[index].kind;
      let found = j;
      while (found < j1 && kindAt(found) !== blocks[i].kind) found++;
      if (found < j1) { from[i] = found; j = found + 1; }
      else if (i - i0 === j - j0) { from[i] = j; j++; }
    }
  }
  return blocks.map((block, i) => (from[i] === undefined ? { ...block } : { ...block, from: from[i] }));
}
