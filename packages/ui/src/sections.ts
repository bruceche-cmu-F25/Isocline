/** A result written in sections (an automation with `layout: sections`, like the morning brief), read for the page
 * that draws it (Sections.tsx). Nothing here knows any section by name: a section is whatever heading the result
 * wrote, and what it is about comes from what its rows link to (docs/design/user-defined.md §3.3). The writing rules
 * the result follows are core's SECTIONS_GUIDE.
 *
 *   lead       the words before the first heading: what it comes down to
 *   sections   one per Markdown heading (or, in older editions, a bold label that starts a line), in order
 *   row        one bullet, or one paragraph; a leading tag says how much it matters, a trailing id what it is about
 */

/** What a row links to: a message, an event or a todo, by the id the tools gave. */
export type RefKind = "mail" | "event" | "todo";
/** How much a row matters, as the result tagged it. */
export type RowKind = "risk" | "decide" | "due" | "fyi";

export interface Row {
  /** The row without its tag and its id. */
  text: string;
  kind: RowKind | null;
  /** A `due` row's date (YYYY-MM-DD), when the tag gave one. */
  due?: string;
  ref?: { kind: RefKind; id: string };
}

export interface Section {
  title: string;
  rows: Row[];
  /** What most of its rows link to; null when they link to nothing. */
  about: RefKind | null;
}

export interface Sections {
  lead: Row[];
  sections: Section[];
}

const KINDS: Array<[RowKind, RegExp]> = [
  ["risk", /^(risk|风险)$/],
  ["decide", /^(decide|decision|your call|等你|等你决定|待决定)$/],
  ["due", /^(due|deadline|期限|截止)$/],
  ["fyi", /^(fyi|告知|知悉)$/],
];
const REF_NAMES: Record<string, RefKind> = { mail: "mail", 邮件: "mail", event: "event", 日程: "event", todo: "todo", 待办: "todo" };

/** `[Risk] …words… (mail:ID)`: a leading tag and a trailing id, both optional, in either language.
 * A bracket that is not one of the known tags is the row's own words and stays. */
export function readRow(source: string): Row {
  let text = source.trim();
  const result: Row = { text, kind: null };
  const cite = /\s*[(（]\s*(mail|event|todo|邮件|日程|待办)\s*[:：]\s*([\w-]{1,64})\s*[)）]\s*([.。]?)$/i.exec(text);
  if (cite) {
    result.ref = { kind: REF_NAMES[cite[1]!.toLowerCase()]!, id: cite[2]! };
    text = text.slice(0, cite.index).trimEnd();
    if (cite[3] && !/[.。!?！？]$/.test(text)) text += cite[3];
  }
  const tag = /^\*{0,2}(?:\[([^\[\]]{1,24})\]|【([^【】]{1,24})】)\*{0,2}\s*[:：]?\s*/.exec(text);
  if (tag && tag[0].length < text.length) {
    const label = (tag[1] ?? tag[2])!.trim().toLowerCase();
    const date = /\d{4}-\d\d-\d\d/.exec(label)?.[0];
    const name = (date ? label.replace(date, "") : label).trim();
    const kind = KINDS.find(([, names]) => names.test(name))?.[0];
    if (kind) {
      result.kind = kind;
      if (kind === "due" && date) result.due = date;
      text = text.slice(tag[0].length);
    }
  }
  result.text = text;
  return result;
}

function heading(line: string): { title: string; rest: string } | null {
  const hash = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
  if (hash) return { title: hash[1]!, rest: "" };
  const bold = /^\*\*(.+?)\*\*[:：]?\s*(.*)$/.exec(line);
  return bold ? { title: bold[1]!.replace(/[:：]$/, ""), rest: bold[2]! } : null;
}

function about(rows: Row[]): RefKind | null {
  const counts = new Map<RefKind, number>();
  for (const row of rows) if (row.ref) counts.set(row.ref.kind, (counts.get(row.ref.kind) ?? 0) + 1);
  let best: RefKind | null = null;
  for (const [kind, n] of counts) if (!best || n > counts.get(best)!) best = kind;
  return best;
}

export function readSections(reply: string): Sections {
  const lead: string[] = [];
  const sections: Array<{ title: string; rows: string[] }> = [];
  let pending: string[] = [];
  let fence = "";
  const flush = () => {
    const text = pending.join("\n").trim();
    pending = [];
    if (!text) return;
    (sections.at(-1)?.rows ?? lead).push(text);
  };
  for (const line of reply.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence || marker) {
      pending.push(line);
      if (!fence) fence = marker!;
      else if (marker && marker.startsWith(fence)) fence = "";
      continue;
    }
    const head = heading(line);
    if (head) {
      flush();
      sections.push({ title: head.title.trim(), rows: [] });
      if (head.rest.trim()) pending.push(head.rest);
    } else if (!line.trim()) {
      flush();
    } else {
      // A top-level item starts a row; an indented one (a sub-item) belongs to the row above, as written.
      const bullet = /^ ?(?:[-*+]|\d{1,2}[.)])\s+(.+)$/.exec(line);
      if (bullet) {
        flush();
        pending.push(bullet[1]!);
      } else {
        pending.push(line);
      }
    }
  }
  flush();
  return {
    lead: lead.map(readRow),
    sections: sections.filter((section) => section.rows.length).map((section) => {
      const rows = section.rows.map(readRow);
      return { title: section.title, rows, about: about(rows) };
    }),
  };
}
