/** How a goal's three files are read (docs/design/goals.md 4.1): by their shape, never by the words of a heading, so
 * a file written in any language, by hand or in Obsidian, reads the same.
 *
 *   the goal's file   properties (`zirma-goal`, `deadline`, `pace`), then the goal in one paragraph, then a
 *                     second-level heading under which the user says why they want it
 *   the big picture   what comes before the first second-level heading is the whole thing explained; a
 *                     second-level heading is a part, a third-level heading under it a topic
 *   the route         a second-level heading is a stage, a third-level heading a step; a step's heading may end
 *                     with an Obsidian block id (`^s3`), which is what its record hangs on
 *
 * Nothing here touches a disk. */

export interface OutlineItem {
  title: string;
  /** The block id at the end of the heading (`^s3`), without the caret. */
  id: string | null;
  body: string;
  /** The heading's line in the text, from 0. */
  line: number;
}
export interface OutlinePart {
  title: string;
  /** What the part says before its first item. */
  text: string;
  items: OutlineItem[];
}
export interface Outline {
  /** What comes before the first part (a first-level title is left out). */
  intro: string;
  parts: OutlinePart[];
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
// Closing hashes count only after a space (`## Title ##`): "C#" at the end of a title is part of the title.
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BLOCK_ID = /[ \t]\^([A-Za-z0-9-]+)$/;

/** The lines of a text and where its properties end (the line after the closing `---`; 0 when it has none). */
function linesOf(text: string): { lines: string[]; bodyAt: number } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { lines, bodyAt: 0 };
  const close = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
  return { lines, bodyAt: close === -1 ? 0 : close + 1 };
}

const tidy = (lines: readonly string[]) => lines.join("\n").replace(/^\s*\n/, "").trimEnd();

/** A text as parts (second-level headings) and their items (third-level headings). Headings inside a code fence are
 * words, not headings. A third-level heading before any part opens a part with no title. */
export function readOutline(text: string): Outline {
  const { lines, bodyAt } = linesOf(text);
  const intro: string[] = [];
  const parts: Array<{ title: string; text: string[]; items: Array<{ title: string; id: string | null; body: string[]; line: number }> }> = [];
  let fence: string | null = null, titled = false;
  for (let index = bodyAt; index < lines.length; index++) {
    const line = lines[index];
    const mark = FENCE.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark[0];
      else if (mark[0] === fence) fence = null;
    }
    const heading = fence || mark ? null : HEADING.exec(line);
    const part = parts.at(-1), item = part?.items.at(-1);
    // The page's own title (a first-level heading at its top) is not part of what it says.
    if (heading && heading[1].length === 1 && !titled && !parts.length) { titled = true; continue; }
    if (heading && heading[1].length <= 2) { parts.push({ title: heading[2], text: [], items: [] }); continue; }
    if (heading && heading[1].length === 3) {
      const id = BLOCK_ID.exec(heading[2])?.[1] ?? null;
      const title = id ? heading[2].replace(BLOCK_ID, "").trimEnd() : heading[2];
      if (part) part.items.push({ title, id, body: [], line: index });
      else parts.push({ title: "", text: [], items: [{ title, id, body: [], line: index }] });
      continue;
    }
    (item?.body ?? part?.text ?? intro).push(line);
  }
  return {
    intro: tidy(intro),
    parts: parts.map((part) => ({ title: part.title, text: tidy(part.text), items: part.items.map((item) => ({ ...item, body: tidy(item.body) })) })),
  };
}

/** The route's file with a block id put at the end of its `n`-th step's heading (from 1); null when there is no
 * such step or it has one already. */
export function withStepId(text: string, n: number, id: string): string | null {
  const steps = readOutline(text).parts.flatMap((part) => part.items);
  const step = steps[n - 1];
  if (!step || step.id) return null;
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.slice(bom.length).split(/\r?\n/);
  // Closing hashes (`### Title ###`) would hide the id from Obsidian: it goes at the very end of the words.
  lines[step.line] = `${lines[step.line].replace(/(?:[ \t]+#+)?[ \t]*$/, "")} ^${id}`;
  return bom + lines.join(eol);
}

/** A block id no step of the route has yet: `s1`, `s2`… */
export function freeStepId(text: string): string {
  const taken = new Set(readOutline(text).parts.flatMap((part) => part.items.map((item) => item.id)));
  for (let n = 1; ; n++) if (!taken.has(`s${n}`)) return `s${n}`;
}

export interface GoalFile {
  id: string | null;
  sentence: string;
  why: string;
  deadline: string | null;
  pace: number | null;
}

export const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value);

/** A property's value as written: quoted or not. Only the plain values this module writes are read. */
function property(lines: readonly string[], bodyAt: number, key: string): string | null {
  for (const line of lines.slice(1, Math.max(1, bodyAt - 1))) {
    if (!line.startsWith(`${key}:`)) continue;
    const raw = line.slice(key.length + 1).trim();
    if (/^".*"$/.test(raw)) { try { return String(JSON.parse(raw)); } catch { return raw.slice(1, -1); } }
    return /^'.*'$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return null;
}

/** Where the goal's file keeps its three pieces, as lines: the sentence from `start` to the first heading, the words
 * under that heading up to `next`, and the rest. A first-level heading at the very top is the page's own title (a
 * file written by hand often has one): the sentence starts after it. */
function goalShape(text: string) {
  const { lines, bodyAt } = linesOf(text);
  let fence: string | null = null, heading = -1, next = lines.length, start = bodyAt, words = false;
  for (let index = bodyAt; index < lines.length; index++) {
    const mark = FENCE.exec(lines[index])?.[1];
    if (mark) { if (!fence) fence = mark[0]; else if (mark[0] === fence) fence = null; words = true; continue; }
    if (fence) continue;
    const found = HEADING.exec(lines[index]);
    if (found && found[1].length === 1 && !words && heading === -1 && start === bodyAt) { start = index + 1; continue; }
    if (!found || found[1].length > 2) { words ||= !!lines[index].trim(); continue; }
    if (heading === -1) heading = index;
    else { next = index; break; }
  }
  return { lines, start, heading, next, bodyAt };
}

export function readGoal(text: string): GoalFile {
  const { lines, bodyAt, start, heading, next } = goalShape(text);
  const pace = Number(property(lines, bodyAt, "pace"));
  const deadline = property(lines, bodyAt, "deadline");
  return {
    id: property(lines, bodyAt, "zirma-goal") || null,
    sentence: lines.slice(start, heading === -1 ? lines.length : heading).join("\n").trim().replace(/\s*\n\s*/g, " "),
    why: heading === -1 ? "" : tidy(lines.slice(heading + 1, next)),
    deadline: isDate(deadline) ? deadline : null,
    pace: Number.isInteger(pace) && pace >= 1 && pace <= 7 ? pace : null,
  };
}

/** The goal's file with its sentence or its "why" rewritten. Its properties, its title if it has one, the heading's
 * own words and anything the user wrote after the "why" stay as they are. `whyHeading` is used only when the file has no heading yet. */
export function writeGoal(text: string, patch: { sentence?: string; why?: string }, whyHeading: string): string {
  const { lines, bodyAt, start, heading, next } = goalShape(text);
  const now = readGoal(text);
  const sentence = (patch.sentence ?? now.sentence).trim().replace(/\s*\n\s*/g, " ");
  const why = (patch.why ?? now.why).trim();
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const rest = heading === -1 ? [] : lines.slice(next);
  const body = [sentence, "", heading === -1 ? `## ${whyHeading}` : lines[heading], "", ...(why ? [...why.split(/\r?\n/), ""] : []), ...rest];
  while (body.length && !body.at(-1)!.trim()) body.pop();
  return bom + [...lines.slice(0, start), ...(start > bodyAt ? [""] : []), ...body, ""].join(eol);
}
