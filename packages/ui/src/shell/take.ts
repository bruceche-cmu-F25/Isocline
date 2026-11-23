/** Putting down what the ask bar read in a line (shell/read.ts): a todo on the todo list, an event in the user's own
 * calendar, by the same operations the pages use when the user types there. No run, no proposal: the line showed
 * what it would become, and Enter was the yes. Each thing put down can be taken back. */
import type { CalendarSnapshot } from "@alfred/module-calendar/types";
import { api, newRequestId } from "../api.ts";
import { intlLocale, t, type Key } from "../i18n/index.ts";
import { weekday, type Reading } from "./read.ts";

/** How long an event lasts when the line gave no end. */
const MINUTES = 60;

const pad = (n: number) => String(n).padStart(2, "0");
const parse = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); };
const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const instant = (day: string, time: string) => { const date = parse(day); const [h, m] = time.split(":").map(Number); date.setHours(h, m); return date; };
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** This device's date: the day the user means by "today". */
export const localToday = () => ymd(new Date());

/** Where an event goes: the user's main calendar, as a proposal's would. */
export interface Target { account: string; calendarId: string }
export function calendarTarget(snapshot: CalendarSnapshot | undefined): Target | null {
  for (const source of snapshot?.sources ?? []) {
    const calendar = source.canWrite ? source.calendars.find((candidate) => candidate.writable) : undefined;
    if (calendar) return { account: source.account, calendarId: calendar.id };
  }
  return null;
}

function dayText(day: string, today: string): string {
  if (day === today) return t("todo.today");
  if (day === ymd(new Date(parse(today).getFullYear(), parse(today).getMonth(), parse(today).getDate() + 1))) return t("todo.tomorrow");
  return parse(day).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", weekday: "short" });
}

/** Other days to put a reading on, one tap each: today, tomorrow, Saturday, next Monday. */
export function dayChoices(today: string): Array<{ day: string; label: string }> {
  const tomorrow = ymd(new Date(parse(today).getFullYear(), parse(today).getMonth(), parse(today).getDate() + 1));
  return [...new Set([today, tomorrow, weekday(today, 6, false), weekday(today, 1, true)])].map((day) => ({ day, label: dayText(day, today) }));
}

/** When an event read from the line starts and ends. */
function span(item: Reading, today: string): { start: Date; end: Date } {
  const day = item.day ?? today, start = instant(day, item.start!);
  let end = item.end ? instant(day, item.end) : new Date(start.getTime() + MINUTES * 60_000);
  if (end <= start) end = new Date(end.getTime() + 86_400_000);
  return { start, end };
}

/** When the thing is, as the line under the words and the note after Enter say it. */
export function whenText(item: Reading, kind: Reading["kind"], today: string): string {
  const day = dayText(item.day ?? today, today);
  if (kind === "event") {
    if (!item.start) return `${day} · ${t("todo.allDay")}`;
    const { start, end } = span(item, today);
    return `${day} ${clock(start)}–${clock(end)}`;
  }
  const said = item.start ? `${day} ${item.start}` : day;
  return item.by ? t("take.by", { day: said }) : said;
}

/** Something put down, and how to take it back. */
export interface Put { kind: Reading["kind"]; page: string; undo(): Promise<unknown> }

/** A refusal in a successful HTTP response was recorded under the request ID; retrying it needs a fresh ID. */
export class PutRefused extends Error {}

function remove(op: "calendar.delete" | "todo.delete", input: { account?: string; id: string }) {
  let requestId = newRequestId();
  return async () => {
    const { result } = await api.op(op, input, requestId);
    const { error } = result as { error?: string };
    if (error) {
      requestId = newRequestId();
      throw new PutRefused(op === "calendar.delete" ? t(`cal.err.${error}` as Key) : error);
    }
  };
}

export async function put(item: Reading, kind: Reading["kind"], target: Target | null, today: string, requestId: string): Promise<Put> {
  if (kind === "event" && target) {
    const when = item.start
      ? (({ start, end }) => ({ start: start.toISOString(), end: end.toISOString() }))(span(item, today))
      : { date: item.day ?? today, endDate: item.day ?? today };
    const result = (await api.op("calendar.create", { ...target, title: item.title, when }, requestId)).result as { id?: string; error?: string };
    if (result.error) throw new PutRefused(t(`cal.err.${result.error}` as Key));
    if (!result.id) throw new Error(t("api.unreachable"));
    const id = result.id;
    return { kind: "event", page: "calendar.week", undo: remove("calendar.delete", { account: target.account, id }) };
  }
  // A todo's hour needs its day: an hour said by itself is today's.
  const due = item.day ?? (item.start ? today : null);
  const todo = (await api.op("todo.add", { title: item.title, ...(due ? { due } : {}), ...(due && item.start ? { at: item.start } : {}) }, requestId)).result as { id: string };
  return { kind: "todo", page: "todo.list", undo: remove("todo.delete", { id: todo.id }) };
}
