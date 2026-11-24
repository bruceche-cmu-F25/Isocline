import type { Area } from "@isocline/core";
import type { RunSources } from "@isocline/protocol";

/** Source formats emitted by the calendar, todo and mail modules. Read the stored tool results,
 * never the model's interpretation or today's mirrors, and do not return mail bodies or snippets. */
export interface SourceRead { name: string; args: Record<string, unknown>; text: string }

function dayEvents(text: string, date: string): RunSources["calendar"] {
  const events: NonNullable<RunSources["calendar"]> = [];
  let day = "", matched = false, explicitlyEmpty = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("Could not read ")) return null;
    const header = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (\d{4}-\d{2}-\d{2})(?:: nothing)?$/.exec(line);
    if (header) {
      day = header[1];
      if (day === date) { matched = true; explicitlyEmpty = line.endsWith(": nothing"); }
      continue;
    }
    if (day !== date || !line.trim() || line.startsWith("(Read from Google at ")) continue;
    const row = /^  (all day|((?:[01]\d|2[0-3]):[0-5]\d|…)–((?:[01]\d|2[0-3]):[0-5]\d|…)) (.+) \[([^\[\]]+)\]$/.exec(line);
    if (!row) return null;
    // The calendar reader puts optional calendar, location and RSVP details after the title.
    // Preserve this displayed name intact: a title may itself end in parentheses.
    events.push({ id: row[5], title: row[4], allDay: row[1] === "all day", start: row[2] && row[2] !== "…" ? row[2] : null, end: row[3] && row[3] !== "…" ? row[3] : null });
  }
  return matched && (events.length > 0 || explicitlyEmpty) ? events : null;
}

const deadline = /^(.*) \((?:due (today|tomorrow|\d{4}-\d\d-\d\d)|overdue, was due (\d{4}-\d\d-\d\d)|\d{4}-\d\d-\d\d – (\d{4}-\d\d-\d\d)(?:, overdue)?)\)$/;
function dueTodos(text: string, date: string, areas: readonly Area[]): RunSources["todos"] {
  const [header, ...lines] = text.split("\n");
  if (header !== `Today is ${date} (user's local date).` || !lines.some((line) => line.trim())) return null;
  if (lines.length === 1 && /^No (?:open )?todos\.$/.test(lines[0])) return [];
  const todos: NonNullable<RunSources["todos"]> = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith("[x] ")) continue;
    const row = /^\[ \] ([\w-]+)  (.+)$/.exec(line);
    if (!row) return null;
    // Peel the module's suffixes in reverse formatting order. Parentheses inside the title are retained.
    let details = row[2].replace(/ -> (?:https?:\/\/|mailto:)\S+$/, "");
    if (details.endsWith(" (your suggestion; the user has not kept it yet)")) continue;
    details = details.replace(/ \(from (?:mail|the calendar(?:; repeats [^\n]*?, this is its next time)?)\)$/, "")
      .replace(/ \(planned \d{4}-\d\d-\d\d, not a deadline\)$/, "");
    const by = / \(by ((?:[01]\d|2[0-3]):[0-5]\d)\)$/.exec(details);
    if (by) details = details.slice(0, by.index);
    const match = deadline.exec(details);
    if (!match || match[2] === "tomorrow") continue;
    const due = match[2] === "today" ? date : match[2] ?? match[3] ?? match[4];
    if (due > date) continue;
    const named = / \[area: ([\w-]+)\]$/.exec(match[1].replace(/ \(in progress\)$/, ""));
    const title = match[1].replace(/ \(in progress\)$/, "").replace(/ \[area: [\w-]+\]$/, "");
    const area = named && areas.find((candidate) => candidate.id === named[1]);
    todos.push({ id: row[1], title, due, overdue: due < date, ...(by ? { at: by[1] } : {}), ...(area ? { area: { ...area } } : {}) });
  }
  return todos;
}

export function readSources(date: string, timezone: string, reads: SourceRead[], areas: readonly Area[] = []): RunSources {
  const result: RunSources = { date, timezone, calendar: null, todos: null, mail: null };
  const opened = new Map<string, NonNullable<RunSources["mail"]>[number]>();
  for (const { name, args, text } of reads) {
    if (name === "calendar_list") {
      const events = dayEvents(text, date);
      if (events !== null) result.calendar = events;
    } else if (name === "todo_list") {
      const todos = dueTodos(text, date, areas);
      if (todos !== null) result.todos = todos;
    } else if (name === "mail_list" && /^(?:No mail matches\.|\[[\w-]+\] )/.test(text) && !/^Could not read /m.test(text)) {
      result.mail ??= [];
    } else if (name === "mail_read" && typeof args.id === "string" && /^[\w-]{1,64}$/.test(args.id)) {
      const header = /^From: (.+)\nTo: [^\n]*\nDate: [^\n]+\nSubject: ([^\n]+)/.exec(text);
      if (header) opened.set(args.id, { id: args.id, from: header[1], subject: header[2] });
    }
  }
  if (opened.size) result.mail = [...opened.values()];
  return result;
}
