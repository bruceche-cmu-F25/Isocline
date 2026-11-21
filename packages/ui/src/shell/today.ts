/** 今天 (the Today page): what deserves the user's attention now, read from the home node's state. It stores nothing
 * and asks no model: these are the facts (docs/design/today-and-inbox.md, 3.2). Alfred's judgement (which letter may
 * need a reply, what to start with, a time for a todo without one) is a later layer on top.
 *   next     the event going on, or the next one today, with the way in (its call, its place)
 *   waiting  the first few things that wait on the user; the Inbox has them all
 *   rows     today on one line of time: events, and todos due at an hour
 *   loose    todos for today with no hour
 *   mail     how many letters came today, and the unread ones
 *   doing    what Alfred is running now, and the automation that fires next
 *   done     what finished and has not been looked at
 */
import type { CalendarEvent, CalendarSnapshot } from "@alfred/module-calendar/types";
import type { MailMessage, MailSnapshot } from "@alfred/module-mail/types";
import type { Todo, TodoSnapshot } from "@alfred/module-todo/types";
import type { Run, StateResponse } from "@alfred/protocol";
import { automationTitle, hhmm, whenText } from "../automationText.ts";
import { t } from "../i18n/dict.ts";
import { inboxItems, type InboxItem } from "./inbox.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const plusDay = (date: string, days: number) => { const [y, m, d] = date.split("-").map(Number); return localDate(new Date(y, m - 1, d + days).getTime()); };
const minuteOf = (ms: number) => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };
const toMinute = (at: string) => { const [h, m] = at.split(":").map(Number); return h * 60 + (m || 0); };

/** An event today, with its instants worked out once. */
export interface TodayEvent {
  event: CalendarEvent;
  startMs: number;
  endMs: number;
  /** "10:00" and "11:00" on this device's clock. */
  at: string;
  until: string;
}

export type TodayRow =
  | ({ kind: "event"; minute: number; past: boolean; now: boolean } & TodayEvent)
  /** A todo due at an hour today: `past` means the hour has gone by and it is still open. */
  | { kind: "todo"; minute: number; past: boolean; at: string; todo: Todo; k: string | null };

export interface TodayDone {
  key: string;
  title: string;
  sub: string;
  at: string;
  /** Where it is read: the Inbox item of a result the user asked to be told about, or its conversation. */
  inbox?: string;
  conversationId?: string;
  session: boolean;
}

export interface TodayModel {
  /** The home node's local date. */
  date: string;
  part: "morning" | "afternoon" | "evening";
  calendar: "none" | "error" | "ok";
  /** Going on now; the next one today; and, when today has nothing left, tomorrow's first. */
  current?: TodayEvent;
  next?: TodayEvent;
  tomorrow?: TodayEvent;
  allDay: CalendarEvent[];
  rows: TodayRow[];
  loose: Array<{ todo: Todo; k: string | null }>;
  late: number;
  waiting: { count: number; top: InboxItem[] };
  mail: { state: "none" | "sendOnly" | "error" | "ok"; today: number; unread: number; rows: MailMessage[] };
  doing: Array<{ run: Run; title: string; sub: string; session: boolean }>;
  upcoming?: { name: string; when: string };
  done: TodayDone[];
}

const GOING = new Set(["queued", "running", "cancelling"]);
const TOP = 3, MAIL_ROWS = 4, DONE_ROWS = 6;

function timed(event: CalendarEvent): TodayEvent {
  const startMs = Date.parse(event.start!), endMs = Date.parse(event.end ?? event.start!);
  return { event, startMs, endMs, at: hhmm(new Date(startMs)), until: hhmm(new Date(endMs)) };
}

export function todayModel(state: StateResponse, now: number = Date.now()): TodayModel {
  const calendar = state.modules.calendar as CalendarSnapshot | undefined;
  const todos = state.modules.todo as TodoSnapshot | undefined;
  const mail = state.modules.mail as MailSnapshot | undefined;
  const date = calendar?.today ?? todos?.today ?? localDate(now);
  const hour = new Date(now).getHours();
  const areaK = (id?: string) => state.areas?.find((area) => area.id === id)?.k ?? null;

  // The calendar: what touches today, and what has an hour today.
  const mine = (calendar?.events ?? []).filter((event) => event.response !== "declined");
  const touching = mine.filter((event) => event.startDate <= date && event.endDate >= date);
  const hasHour = (event: CalendarEvent, day: string) => !event.allDay && !!event.start && event.startDate === day;
  const events = touching.filter((event) => hasHour(event, date)).map(timed).sort((a, b) => a.startMs - b.startMs);
  const current = events.find((event) => event.startMs <= now && event.endMs > now);
  const next = events.find((event) => event.startMs > now);
  const tomorrow = current || next ? undefined
    : mine.filter((event) => hasHour(event, plusDay(date, 1))).map(timed).sort((a, b) => a.startMs - b.startMs)[0];

  // Todos: Alfred's suggestions are not the user's yet, and one mirrored from the calendar is already there as its event.
  const open = (todos?.todos ?? []).filter((todo) => !todo.done && !todo.suggested && !todo.archivedAt && todo.source?.kind !== "calendar");
  const forToday = (todo: Todo) => todo.due === date || todo.plannedOn === date || (!!todo.startDate && !!todo.due && todo.startDate <= date && todo.due >= date);
  const todays = open.filter(forToday);
  const atHour = todays.filter((todo) => todo.at && todo.due === date);
  const nowMinute = date === localDate(now) ? minuteOf(now) : date < localDate(now) ? 24 * 60 : -1;

  const rows: TodayRow[] = [
    ...events.map((event): TodayRow => ({ kind: "event", minute: minuteOf(event.startMs), past: event.endMs <= now, now: event === current, ...event })),
    ...atHour.map((todo): TodayRow => ({ kind: "todo", minute: toMinute(todo.at!), past: toMinute(todo.at!) <= nowMinute, at: todo.at!, todo, k: areaK(todo.area) })),
  ].sort((a, b) => a.minute - b.minute || Number(a.kind === "todo") - Number(b.kind === "todo"));

  // What waits: a task stuck on an answer first, the longest wait first; then the rest as the Inbox orders them.
  const decide = inboxItems(state).filter((item) => item.kind === "decide");
  const stuck = decide.filter((item) => item.run).sort((a, b) => a.at.localeCompare(b.at));
  const waiting = [...stuck, ...decide.filter((item) => !item.run)];

  const sources = mail?.sources ?? [];
  const arrived = (mail?.messages ?? []).filter((message) => localDate(Date.parse(message.receivedAt)) === date);
  const unread = arrived.filter((message) => message.unread && message.category === "primary")
    .sort((a, b) => Number(b.important) - Number(a.important) || b.receivedAt.localeCompare(a.receivedAt));

  // One row a conversation: its newest run that is still going.
  const seen = new Set<string>();
  const doing = state.runs.filter((run) => GOING.has(run.state) && !seen.has(run.conversationId) && !!seen.add(run.conversationId)).map((run) => {
    const conversation = state.conversations.find((candidate) => candidate.id === run.conversationId);
    const automation = state.automations?.find((candidate) => candidate.id === run.automationId);
    const title = (automation ? automationTitle(automation) : conversation?.title) || run.goal.slice(0, 80);
    return { run, title, sub: automation || run.goal === title ? "" : run.goal.slice(0, 120), session: !!conversation?.projectId };
  });
  const soonest = (state.automations ?? []).filter((automation) => automation.enabled && automation.nextAt).sort((a, b) => a.nextAt!.localeCompare(b.nextAt!))[0];

  // Finished and not looked at: a result the user asked to be told about, and any reply still unread.
  const results = inboxItems(state).filter((item) => item.kind === "result" && item.notice?.kind !== "outbound");
  const done: TodayDone[] = [
    ...results.map((item): TodayDone => ({ key: item.id, title: item.edition?.name ?? item.title, sub: item.summary, at: item.at, inbox: item.id,
      session: !!state.conversations.find((conversation) => conversation.id === item.conversationId)?.projectId })),
    ...state.conversations.filter((conversation) => conversation.unreadReplyId && !results.some((item) => item.conversationId === conversation.id))
      .map((conversation): TodayDone => ({ key: `c:${conversation.id}`, title: conversation.title, sub: conversation.lastGoal && conversation.lastGoal !== conversation.title ? conversation.lastGoal : "",
        at: conversation.updatedAt, conversationId: conversation.id, session: !!conversation.projectId })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, DONE_ROWS);

  return {
    date, part: hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening",
    calendar: !calendar?.sources?.length ? "none" : calendar.sources.some((source) => source.error) ? "error" : "ok",
    current, next, tomorrow,
    allDay: touching.filter((event) => !hasHour(event, date)),
    rows,
    loose: todays.filter((todo) => !atHour.includes(todo)).map((todo) => ({ todo, k: areaK(todo.area) })),
    late: open.filter((todo) => !!todo.due && todo.due < date && !forToday(todo)).length,
    waiting: { count: waiting.length, top: waiting.slice(0, TOP) },
    mail: {
      state: !sources.length ? "none" : !sources.some((source) => source.canRead !== false) ? "sendOnly" : sources.some((source) => source.error) ? "error" : "ok",
      today: arrived.length, unread: unread.length, rows: unread.slice(0, MAIL_ROWS),
    },
    doing,
    upcoming: soonest ? { name: automationTitle(soonest), when: whenText(soonest.nextAt!, now) } : undefined,
    done,
  };
}

/** "1 小时 50 分", "25 分钟": how long until something, in whole minutes. */
export function untilText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000)), h = Math.floor(minutes / 60), m = minutes % 60;
  if (!h) return t("today.left.m", { m });
  return m ? t("today.left.hm", { h, m }) : t("today.left.h", { h });
}

/** The page's one line: what is next, and how much waits. Also what Alfred hears with a question asked from here. */
export function todaySummary(state: StateResponse, now: number = Date.now()): string {
  const model = todayModel(state, now);
  const first = model.current ? t("today.sum.now", { title: model.current.event.title })
    : model.next ? t("today.sum.next", { at: model.next.at, title: model.next.event.title })
    : model.calendar === "none" ? t("today.noCalendar") : t("today.free");
  return first + (model.waiting.count ? t("today.sum.waiting", { n: model.waiting.count }) : "");
}
