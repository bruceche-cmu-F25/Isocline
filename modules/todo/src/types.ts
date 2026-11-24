/** Todo types a device needs. No imports, so browser code can use them. */
export const TODO_STATUSES = ["todo", "doing", "done"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** A calendar event that repeats every week or more often has one todo for all of it, standing for its next time.
 * `days`: the weekdays it falls on (0 Sunday … 6 Saturday); `at`: when it starts (HH:MM by the home node's clock),
 * if it has a time. */
export interface TodoRepeat { days: number[]; at?: string }

/** Where a todo came from, when the user did not write it: a calendar event Zirma mirrors, or a mail Zirma
 * picked it out of. `ref` names that one thing (`calendar:<account>:<event id>`, or
 * `calendar:<account>:repeat:<repeating event>` for one that repeats weekly; `mail:<message id>`): it never makes
 * a second todo at a time, and a todo the user removed is not made again. */
export interface TodoSource {
  kind: "calendar" | "mail";
  ref: string;
  /** What to call the source: the calendar's name, the mail's subject. */
  label: string;
  /** The event or the message at its service. */
  link?: string;
  /** Set on the one todo of an event that repeats weekly. */
  repeat?: TodoRepeat;
}

/** The words an all-day event that is a day off is named by. These are samples: the user keeps their own list
 * (todo settings `offWords`, on the todo page's sources), and once they change it, theirs is used. */
export const SAMPLE_OFF_WORDS: readonly string[] = [
  "holiday", "break", "recess", "no classes", "classes cancelled", "classes canceled", "university closed", "day off",
  "放假", "假期", "假日", "停课", "休假", "节假日",
];
export const MAX_OFF_WORDS = 50, MAX_OFF_WORD = 40;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A word in a Latin script matches as a whole word (and its plural); any other (Chinese) wherever it appears. */
export function offMatcher(words: readonly string[]): (title: string) => boolean {
  const parts = words.map((word) => word.trim()).filter(Boolean)
    .map((word) => (/^[\p{Script=Latin}\d\s'-]+$/u.test(word) ? `\\b${escape(word).replace(/\s+/g, "\\s+")}(?:s|es)?\\b` : escape(word)));
  if (!parts.length) return () => false;
  const pattern = new RegExp(parts.join("|"), "iu");
  return (title) => pattern.test(title);
}

/** A day off: an event of a holiday calendar (Google's are `…#holiday@group.v.calendar.google.com`), or an all-day
 * event whose name has one of the user's day-off words (a lunch break has a time, so it is not one). It is never made
 * a todo; the todo page labels its days with it. */
export function isDayOff(event: { allDay: boolean; title: string; calendarId?: string }, words: readonly string[] = SAMPLE_OFF_WORDS): boolean {
  if (!event.allDay) return false;
  return (event.calendarId ?? "").includes("#holiday@") || offMatcher(words)(event.title);
}

/** Which calendar events become todos by themselves: none, the all-day ones (deadlines, days to remember), or all. */
export const CALENDAR_MODES = ["off", "allday", "all"] as const;
export type CalendarMode = (typeof CALENDAR_MODES)[number];
export interface TodoSettings {
  fromCalendar: CalendarMode;
  /** The words a day off is named by: the samples until the user changes them. */
  offWords: string[];
}

export interface Todo {
  id: string;
  title: string;
  done: boolean;
  status?: TodoStatus;
  /** One explicitly chosen next task across the list; not a work date. */
  next?: boolean;
  /** First day of a multi-day task. Only with `due`. */
  startDate?: string;
  due?: string;
  /** The hour it is due by on its `due` day (HH:MM, the home node's clock). */
  at?: string;
  /** Deliberate work date, never a deadline. */
  plannedOn?: string;
  /** Abandoned, not completed; reversible and left out of ordinary lists. */
  archivedAt?: string;
  url?: string;
  /** The area of life it belongs to: one of the user's areas (core listAreas), by id. */
  area?: string;
  createdAt: string;
  completedAt?: string;
  source?: TodoSource;
  /** Zirma's suggestion (from mail), not yet the user's todo: kept with a yes or any edit, dropped with a no. */
  suggested?: boolean;
  /** Fields written by another version, kept as they are but not edited. */
  [kept: string]: unknown;
}

/** What a device draws: every non-archived todo with its revision, and the local date. `changedBy` says Zirma
 * made the latest change to it (read from the event log), and which kind of change. */
export interface TodoSnapshot {
  today: string;
  /** What becomes a todo by itself. Absent from a home node older than this field. */
  settings?: TodoSettings;
  todos: Array<Todo & { revision: string; changedBy?: { actor: "alfred"; kind: string; at: string } }>;
}

/** The operations a device may ask of this module (POST /api/ops/<name>), as the module defines them. A test on the
 * home node checks this list against the module's own, so a device cannot name one that is not there. */
export const TODO_OPS = ["todo.add", "todo.update", "todo.complete", "todo.accept", "todo.sources", "todo.delete"] as const;
export type TodoOp = (typeof TODO_OPS)[number];
