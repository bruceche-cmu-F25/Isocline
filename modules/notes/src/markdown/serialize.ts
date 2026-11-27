/** Writing one block that changed (docs/research/notes-editor.md 3.1). Only changed blocks come here: a block the
 * user did not touch is copied from the file. The forms are fixed (`**`, `*`, `~~`, `` ` ``, `- `), and words are
 * escaped so they read back as the same words, not as markup. */
import type { Block, Inline, Mark } from "./model.ts";

const DELIMITER: Record<Exclude<Mark, "code">, string> = { strong: "**", em: "*", strike: "~~" };
const STACKED: readonly Exclude<Mark, "code">[] = ["strong", "em", "strike"];

/** Words as Markdown that reads back as these words. */
export function escapeWords(text: string): string {
  let out = text
    .replace(/[\\`*~$[\]]/g, "\\$&")
    .replace(/<(?=[A-Za-z/!?])/g, "\\<")
    .replace(/&(?=#?\w+;)/g, "\\&")
    .replace(/%%/g, "%\\%");
  // `_` only where it could open or close emphasis: inside a word it is a plain character.
  out = out.replace(/_/g, (match, at: number, all: string) => (/[\p{L}\p{N}]/u.test(all[at - 1] ?? "") && /[\p{L}\p{N}]/u.test(all[at + 1] ?? "") ? "_" : "\\_"));
  return out;
}

/** What would start a block if it began a line: a heading, a quote, a list item, a setext underline. */
function escapeLineStart(line: string): string {
  return line
    .replace(/^([ \t]*)([#>+\-=])(?=[ \t]|$|[#=-])/, "$1\\$2")
    .replace(/^([ \t]*\d{1,9})([.)])(?=[ \t]|$)/, "$1\\$2");
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((ticks) => ticks.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ") && text.trim()) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function linkTarget(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : url;
}

/** One stretch of runs with no link change inside: marks opened and closed around the words, white space kept
 * outside the delimiters so they still open and close. */
function marked(runs: readonly Inline[]): string {
  let out = "";
  const open: Exclude<Mark, "code">[] = [];
  const close = (keep: readonly Mark[]) => {
    // Closing a mark closes everything opened after it; those that should stay open are opened again.
    const at = open.findIndex((mark) => !keep.includes(mark));
    if (at === -1) return;
    for (const mark of open.splice(at).reverse()) out += DELIMITER[mark];
  };
  runs.forEach((run, i) => {
    if (run.t !== "text") {
      close([]);
      out += run.raw;
      return;
    }
    const marks = run.marks ?? [];
    close(marks);
    const opening = STACKED.filter((mark) => marks.includes(mark) && !open.includes(mark));
    const next = runs[i + 1];
    const nextMarks = next?.t === "text" ? next.marks ?? [] : [];
    const closing = open.length + opening.length > 0 && [...open, ...opening].some((mark) => !nextMarks.includes(mark));
    let words = run.text;
    let lead = "", tail = "";
    if (opening.length) { lead = /^\s*/.exec(words)![0]; words = words.slice(lead.length); }
    if (closing) { tail = /\s*$/.exec(words)![0]; words = words.slice(0, words.length - tail.length); }
    out += lead;
    for (const mark of opening) { out += DELIMITER[mark]; open.push(mark); }
    out += marks.includes("code") ? codeSpan(words) : escapeWords(words);
    if (closing) close(nextMarks);
    out += tail;
  });
  close([]);
  return out;
}

/** Inline runs as Markdown, on one logical line (line breaks inside are kept as they are). */
export function inlineMarkdown(content: readonly Inline[]): string {
  let out = "";
  let i = 0;
  while (i < content.length) {
    const run = content[i];
    const href = run.t === "text" ? run.href : undefined;
    let j = i + 1;
    while (j < content.length && content[j].t === "text" && (content[j] as { href?: string }).href === href && href !== undefined) j++;
    if (href === undefined) {
      // Up to the next linked run.
      j = i + 1;
      while (j < content.length && !(content[j].t === "text" && (content[j] as { href?: string }).href !== undefined)) j++;
      out += marked(content.slice(i, j));
    } else {
      out += `[${marked(content.slice(i, j).map((r) => ({ ...r, href: undefined }) as Inline))}](${linkTarget(href)})`;
    }
    i = j;
  }
  // Each line starts as words, not as a block's marker; spaces at a line's end would make a hard break. Lines end
  // in "\n" here; the page's own line ending is put back when the block goes into the file.
  return out.replace(/\r\n?/g, "\n").split("\n").map((line, n) => (n === 0 ? line : line.replace(/^[ \t]+/, ""))).map((line) => line.replace(/[ \t]+$/, "")).map(escapeLineStart).join("\n");
}

const MARKER = /^([-+*]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;

/** The marker of a list item: the one it was written with, when there is one of the same kind. */
export function itemMarker(block: Extract<Block, { kind: "item" }>, written?: string): string {
  const found = written ? MARKER.exec(written) : null;
  const ordered = found ? /\d/.test(found[1]) : false;
  if (found && (block.list === "ordered") === ordered && (block.list === "task") === !!found[3]) {
    if (block.list === "task") return `${found[1]}${found[2]}[${block.checked ? "x" : " "}]${found[3]!.slice(3)}`;
    return found[0];
  }
  if (block.list === "ordered") return `${block.number ?? 1}. `;
  if (block.list === "task") return `- [${block.checked ? "x" : " "}] `;
  return "- ";
}

/** How far a nested list under this item is indented, past the item's own indent. */
export function contentWidth(marker: string): number {
  const found = MARKER.exec(marker);
  return found ? found[1].length + Math.min(found[2].length, 4) : 2;
}

/** One block as Markdown. `written` is the list item's marker in the file, kept when the item stays that kind. */
export function blockMarkdown(block: Block, written?: string): string {
  switch (block.kind) {
    case "paragraph": return inlineMarkdown(block.content);
    case "heading": {
      const words = inlineMarkdown(block.content).replace(/\n+/g, " ").replace(/#+$/, (hashes) => hashes.replace(/#/g, "\\#"));
      return `${"#".repeat(Math.min(6, Math.max(1, block.level)))} ${words}`;
    }
    case "item": {
      const marker = itemMarker(block, written);
      const continued = " ".repeat(contentWidth(marker));
      return marker + inlineMarkdown(block.content).split("\n").join(`\n${continued}`);
    }
    case "quote": return inlineMarkdown(block.content).split("\n").map((line) => `> ${line}`.trimEnd()).join("\n");
    case "code": {
      const longest = Math.max(2, ...(block.text.match(/`{3,}/g) ?? []).map((ticks) => ticks.length));
      const fence = "`".repeat(longest + 1);
      return `${fence}${block.lang}\n${block.text}${block.text.endsWith("\n") || !block.text ? "" : "\n"}${fence}`;
    }
    case "rule": return "---";
    case "table": {
      // A pipe inside a cell is escaped, also in code: GFM reads it as a column break otherwise.
      const cell = (content: readonly Inline[]) => inlineMarkdown(content).replace(/\n+/g, " ").replace(/(?<!\\)\|/g, "\\|").trim() || " ";
      const width = Math.max(1, block.align.length, ...block.rows.map((row) => row.length));
      const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
      const rows = (block.rows.length ? block.rows : [[]]).map((row) => line(Array.from({ length: width }, (_, i) => cell(row[i] ?? []))));
      const rule = line(Array.from({ length: width }, (_, i) => ({ left: ":--", right: "--:", center: ":-:" } as Record<string, string>)[block.align[i] ?? ""] ?? "---"));
      return [rows[0], rule, ...rows.slice(1)].join("\n");
    }
    case "callout": {
      const words = inlineMarkdown(block.content);
      const head = `> [!${block.type}]${block.fold}${block.title ? ` ${block.title.replace(/\n+/g, " ")}` : ""}`;
      return words ? `${head}\n${words.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}` : head;
    }
    case "raw": return block.text;
  }
}
