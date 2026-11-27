/** How a page in Zirma's layer is written (notes-two-layers.md 4.4): a few properties, then lines, each a list item
 * that ends with where it came from:
 *
 *   ---
 *   zirma: maintained
 *   updated: 2026-11-26 08:00
 *   from: ["[[V60 参数]]", "[[周末想试的]]"]
 *   ---
 *
 *   - 常用 V60：粉水比 1:15（[[V60 参数]]）
 *   - 水温写过 92 度，也写过 94 度（[[V60 参数]]、[[周末想试的]]）
 *
 * A source is an ordinary `[[link]]`, so the page reads the same in Obsidian. A fact that came from outside the notes
 * (a mail the user said to remember) names where it came from in words: `（来自邮件：机票确认）`. Zirma writes these
 * pages itself, so reading them only has to understand its own format, plus whatever a person may have added. */
import { plainWords } from "./layer-store.ts";

export interface KeptSource {
  /** A link's page name as written (`V60 参数`, or a path); null for a source named in words. */
  target: string | null;
  /** What to call it: the link's alias or name, or the words. */
  label: string;
}

export interface KeptLine {
  /** Counted from 0 over the page's lines. */
  index: number;
  /** The line's place in the file (0-based), to take it out. */
  at: number;
  section: string | null;
  text: string;
  sources: KeptSource[];
}

export interface KeptPage {
  props: Record<string, string>;
  sections: Array<{ heading: string | null; lines: KeptLine[] }>;
  lines: KeptLine[];
}

const FRONT = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const WIKI = /^\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]$/;
const WORDS = /^(来自|from\b)/i;
const TAIL = /\s*[（(]([^（）()]+)[）)]\s*$/;

/** A line's words and its sources, when it ends with them. A closing bracket that holds anything else is words. */
export function splitSources(line: string): { text: string; sources: KeptSource[] } {
  const found = TAIL.exec(line);
  if (!found) return { text: line.trim(), sources: [] };
  const parts = found[1].split(/\s*[、,，;；]\s*/).map((part) => part.trim()).filter(Boolean);
  const sources: KeptSource[] = [];
  for (const part of parts) {
    const wiki = WIKI.exec(part);
    if (wiki) sources.push({ target: wiki[1].trim(), label: (wiki[2] ?? wiki[1]).trim() });
    else if (WORDS.test(part)) sources.push({ target: null, label: part });
    else return { text: line.trim(), sources: [] };
  }
  return { text: line.slice(0, found.index).trim(), sources };
}

export function readKept(text: string): KeptPage {
  const front = FRONT.exec(text);
  const props: Record<string, string> = {};
  if (front) {
    for (const line of front[1].split(/\r?\n/)) {
      const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (pair) props[pair[1]] = pair[2].replace(/^["']|["']$/g, "");
    }
  }
  const offset = front ? front[0].split(/\n/).length - 1 : 0;
  const body = (front ? text.slice(front[0].length) : text.replace(/^﻿/, "")).split(/\r?\n/);
  const sections: KeptPage["sections"] = [];
  const lines: KeptLine[] = [];
  let section: { heading: string | null; lines: KeptLine[] } | null = null;
  body.forEach((raw, i) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw);
    if (heading) { section = { heading: heading[1].trim(), lines: [] }; sections.push(section); return; }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(raw);
    const words = item ? item[1] : raw.trim();
    if (!words) return;
    if (!section) { section = { heading: null, lines: [] }; sections.push(section); }
    const split = splitSources(words);
    const line: KeptLine = { index: lines.length, at: offset + i, section: section.heading, text: split.text, sources: split.sources };
    section.lines.push(line);
    lines.push(line);
  });
  return { props, sections: sections.filter((one) => one.lines.length || one.heading), lines };
}

export type Locale = "zh" | "en";

export function sourceSuffix(sources: readonly KeptSource[], locale: Locale): string {
  if (!sources.length) return "";
  const parts = sources.map((source) => (source.target ? `[[${source.target}]]` : source.label));
  return locale === "zh" ? `（${parts.join("、")}）` : ` (${parts.join(", ")})`;
}

/** The local time as the page says it was brought up to date: `2026-11-26 08:00`. */
export function stamp(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function composeKept(input: {
  icon: string | null;
  sections: ReadonlyArray<{ heading: string | null; lines: ReadonlyArray<{ text: string; sources: readonly KeptSource[] }> }>;
  updated?: string;
}, locale: Locale): string {
  const from = [...new Set(input.sections.flatMap((section) => section.lines.flatMap((line) => line.sources.filter((source) => source.target).map((source) => `[[${source.target}]]`))))];
  const head = ["---", "zirma: maintained", ...(input.icon ? [`icon: ${input.icon}`] : []), `updated: ${input.updated ?? stamp()}`, `from: ${JSON.stringify(from)}`, "---", ""];
  const parts: string[] = [];
  for (const section of input.sections) {
    const lines = section.lines.map((line) => `- ${line.text}${sourceSuffix(line.sources, locale)}`);
    if (!lines.length) continue;
    parts.push([...(section.heading ? [`## ${section.heading}`, ""] : []), ...lines].join("\n"));
  }
  return `${head.join("\n")}\n${parts.join("\n\n")}\n`;
}

/** Whether two texts of a Zirma page differ only in when they were brought up to date. */
export function sameKept(a: string, b: string): boolean {
  const strip = (text: string) => text.replace(/^updated: .*$/m, "");
  return strip(a) === strip(b);
}

/** The lines in `after` that `before` did not have, with their sources (link names, lower case): what a change of
 * Zirma's added, for remembering that the user did not want them when they take the change back. */
export function addedLines(before: string, after: string): Array<{ words: string; sources: string[] }> {
  const had = new Set(readKept(before).lines.map((line) => plainWords(line.text)));
  return readKept(after).lines
    .filter((line) => !had.has(plainWords(line.text)))
    .map((line) => ({ words: line.text, sources: line.sources.filter((source) => source.target).map((source) => source.target!.toLowerCase()) }));
}
