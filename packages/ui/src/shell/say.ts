/** A few words about one thing that is already on the page, read without a model: "明天" moves a todo's day, "晚1小时"
 * an event's hour, "做完了" finishes a todo. The thing is in the ask bar (shell/about.ts) and the words go to it.
 * Words that say more than a day and an hour are not guessed at: the caller hands them to Isocline with the thing. */
import type { CalendarWhen } from "@isocline/module-calendar/types";
import { readClause } from "./read.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const parse = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d); };
const ymd = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const at = (day: string, time: string) => { const date = parse(day); const [h, m] = time.split(":").map(Number); date.setHours(h, m); return date; };
const dayGap = (from: string, to: string) => Math.round((parse(to).getTime() - parse(from).getTime()) / 86_400_000);
const plus = (day: string, n: number) => { const date = parse(day); date.setDate(date.getDate() + n); return ymd(date); };

/** Words that only carry a day or an hour to the thing ("改到", "move to"): with those gone, nothing else may be left. */
const CARRY = /改到|挪到|移到|推到|放到|改成|改为|换到|到|吧|\b(?:move(?:\s+it)?\s+to|make\s+it|change\s+(?:it\s+)?to|due|on|at|to)\b/gi;
const only = (rest: string) => !rest.replace(CARRY, " ").replace(/[\s，,。.!！]+/g, "");

const DONE = /^\s*(?:做完了?|完成了?|搞定了?|好了|done|finished|did it)\s*[。.!！]?\s*$/i;

/** What the words do to a todo: finish it, or give it a day and maybe an hour. Null: not plainly either. */
export function todoChange(words: string, today: string, todo: { due?: string | null }): { done: true } | { patch: { due: string; at?: string } } | null {
  if (DONE.test(words)) return { done: true };
  const got = readClause(words, today);
  if (!(got.day || got.start) || !only(got.title)) return null;
  return { patch: { due: got.day ?? todo.due ?? today, ...(got.start ? { at: got.start } : {}) } };
}

/** Minutes the words push an event later (earlier: negative): "晚1小时", "提前半小时", "2 hours later". */
function shift(words: string): { minutes: number; rest: string } {
  const zh = words.match(/(晚|推迟|推后|延后|早|提前)\s*(\d+|一|两|二|三|半)?\s*个?\s*(小时|分钟)?/);
  const en = words.match(/\b(\d+|an?|half an?)?\s*(hours?|minutes?|mins?)\s+(later|earlier)\b/i);
  if (zh && (zh[2] || zh[3])) {
    const n = zh[2] === "半" ? 0.5 : ({ 一: 1, 两: 2, 二: 2, 三: 3 } as Record<string, number>)[zh[2] ?? ""] ?? Number(zh[2] ?? 1);
    const minutes = n * (zh[3] === "分钟" ? 1 : 60);
    return { minutes: /早|提前/.test(zh[1]) ? -minutes : minutes, rest: words.replace(zh[0], " ") };
  }
  if (en) {
    const n = !en[1] || /^an?$/i.test(en[1]) ? 1 : /half/i.test(en[1]) ? 0.5 : Number(en[1]);
    const minutes = n * (/^h/i.test(en[2]) ? 60 : 1);
    return { minutes: /earlier/i.test(en[3]) ? -minutes : minutes, rest: words.replace(en[0], " ") };
  }
  return { minutes: 0, rest: words };
}

/** When the words move an event to. It keeps its length unless they say when it ends; a whole-day event stays whole
 * days unless they give it an hour. Null: the words do not plainly say a day, an hour or a shift. */
export function eventChange(words: string, today: string, event: { allDay: boolean; startDate: string; endDate: string; start?: string; end?: string }): CalendarWhen | null {
  const moved = shift(words);
  const got = readClause(moved.rest, today);
  if (!(got.day || got.start || moved.minutes) || !only(got.title)) return null;
  if (event.allDay || !event.start || !event.end) {
    if (moved.minutes) return null;
    const date = got.day ?? event.startDate;
    if (!got.start) return { date, endDate: plus(date, dayGap(event.startDate, event.endDate)) };
    const start = at(date, got.start), end = got.end ? at(date, got.end) : new Date(start.getTime() + 3_600_000);
    return { start: start.toISOString(), end: (end > start ? end : new Date(end.getTime() + 86_400_000)).toISOString() };
  }
  const was = new Date(event.start), length = Date.parse(event.end) - was.getTime();
  const day = got.day ?? ymd(was);
  const start = got.start ? at(day, got.start) : new Date(at(day, `${pad(was.getHours())}:${pad(was.getMinutes())}`).getTime() + moved.minutes * 60_000);
  let end = got.end ? at(day, got.end) : new Date(start.getTime() + length);
  if (end <= start) end = new Date(end.getTime() + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}
