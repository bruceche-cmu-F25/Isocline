/** 今天 (the Today page): what deserves the user's attention now, read from the home node's state. It stores nothing
 * and asks no model: these are the facts (docs/design/today-and-inbox.md, 3.2). Alfred's judgement (which letter may
 * need a reply, what to start with, a time for a todo without one) is a later layer on top.
 *   next     the event going on, or the next one today, with the way in (its call, its place)
 *   turned   in the evening, once nothing with an hour is left today, the page is about tomorrow (`ahead`)
 *   waiting  the first few things that wait on the user; the Inbox has them all
 *   rows     today on one line of time: events, and todos due at an hour
 *   loose    todos for today with no hour
 *   mail     how many letters came today, and the unread ones a person wrote (codes and sign-in notices are counted apart)
 *   doing    what Alfred is running now, and the automation that fires next
 *   done     what finished and has not been looked at
 * `todayLine` lays these out as the page draws them: one line of rows in order of time.
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

/** One day as the page draws it: what covers the whole day, what has an hour, and the todos for it without one. */
export interface TodayDay {
  date: string;
  allDay: CalendarEvent[];
  rows: TodayRow[];
  loose: Array<{ todo: Todo; k: string | null }>;
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
  /** Evening, and nothing with an hour is left today: the page turns to tomorrow, and today folds into a line. */
  turned: boolean;
  /** Tomorrow, drawn the same way. */
  ahead: TodayDay;
  /** How many events with an hour today had, for "today's 3 are over". */
  passed: number;
  /** Today's todos still open, those due at an hour first: what the evening must not lose sight of. */
  unfinished: Array<{ todo: Todo; k: string | null; at?: string }>;
  /** `count`: everything waiting; `top`: the first few, each thing once. */
  waiting: { count: number; top: InboxItem[] };
  /** `rows`: unread letters a person wrote; `machine`: unread ones a system sent (a code, a sign-in notice). */
  mail: { state: "none" | "sendOnly" | "error" | "ok"; today: number; unread: number; rows: MailMessage[]; machine: number };
  doing: Array<{ run: Run; title: string; sub: string; session: boolean }>;
  upcoming?: { name: string; when: string };
  done: TodayDone[];
}

const GOING = new Set(["queued", "running", "cancelling"]);
const TOP = 3, MAIL_ROWS = 4, DONE_ROWS = 6;

/** A letter no person wrote and nobody answers: a one-time code, a sign-in or security notice, a no-reply sender.
 * Plain rules on the sender and the first words, so it is a fact about the letter, not a judgement of its worth. */
export function machineMail(message: Pick<MailMessage, "fromEmail" | "subject" | "snippet">): boolean {
  if (/^(no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|security)[^@]*@/i.test(message.fromEmail)) return true;
  const words = `${message.subject} ${message.snippet.slice(0, 160)}`;
  return /\b(verification|one[- ]time|security|login|sign[- ]?in) code\b|验证码|校验码|\bsign(ing)? in to\b|\bnew (sign[- ]?in|login|device)\b|unrecognized device|登录提醒|新设备登录|password reset|reset your password|重置密码|\b(confirm|verify) your (email|account)\b/i.test(words);
}

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

  // The calendar: an invitation turned down is not on the day.
  const mine = (calendar?.events ?? []).filter((event) => event.response !== "declined");
  const hasHour = (event: CalendarEvent, day: string) => !event.allDay && !!event.start && event.startDate === day;
  // Todos: Alfred's suggestions are not the user's yet, and one mirrored from the calendar is already there as its event.
  const open = (todos?.todos ?? []).filter((todo) => !todo.done && !todo.suggested && !todo.archivedAt && todo.source?.kind !== "calendar");
  const isFor = (todo: Todo, day: string) => todo.due === day || todo.plannedOn === day || (!!todo.startDate && !!todo.due && todo.startDate <= day && todo.due >= day);
  const here = localDate(now);

  /** A day as the page draws it. `current`: the event going on, which only today has. */
  const dayOf = (day: string): { day: TodayDay; events: TodayEvent[]; current?: TodayEvent } => {
    const touching = mine.filter((event) => event.startDate <= day && event.endDate >= day);
    const events = touching.filter((event) => hasHour(event, day)).map(timed).sort((a, b) => a.startMs - b.startMs);
    const current = events.find((event) => event.startMs <= now && event.endMs > now);
    const todays = open.filter((todo) => isFor(todo, day));
    const atHour = todays.filter((todo) => todo.at && todo.due === day);
    const nowMinute = day === here ? minuteOf(now) : day < here ? 24 * 60 : -1;
    const rows: TodayRow[] = [
      ...events.map((event): TodayRow => ({ kind: "event", minute: minuteOf(event.startMs), past: event.endMs <= now, now: event === current, ...event })),
      ...atHour.map((todo): TodayRow => ({ kind: "todo", minute: toMinute(todo.at!), past: toMinute(todo.at!) <= nowMinute, at: todo.at!, todo, k: areaK(todo.area) })),
    ].sort((a, b) => a.minute - b.minute || Number(a.kind === "todo") - Number(b.kind === "todo"));
    return {
      events, current,
      day: { date: day, rows, allDay: touching.filter((event) => !hasHour(event, day)), loose: todays.filter((todo) => !atHour.includes(todo)).map((todo) => ({ todo, k: areaK(todo.area) })) },
    };
  };
  const today = dayOf(date), ahead = dayOf(plusDay(date, 1));
  const { events, current } = today;
  const { rows } = today.day;
  const next = events.find((event) => event.startMs > now);
  const tomorrow = current || next ? undefined : ahead.events[0];
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  // A todo due at an hour still to come keeps the evening on today.
  const turned = part === "evening" && !current && !next && !rows.some((row) => !row.past);

  // What waits: a task stuck on an answer first, the longest wait first; then the rest as the Inbox orders them.
  const decide = inboxItems(state).filter((item) => item.kind === "decide");
  const stuck = decide.filter((item) => item.run).sort((a, b) => a.at.localeCompare(b.at));
  const waiting = [...stuck, ...decide.filter((item) => !item.run)];
  // The same thing said twice (a proposal and its newer versions) is one row here; the Inbox still has each.
  const said = new Set<string>();
  const distinct = waiting.filter((item) => { const words = `${item.title}\n${item.summary}`; return !said.has(words) && !!said.add(words); });

  const sources = mail?.sources ?? [];
  const arrived = (mail?.messages ?? []).filter((message) => localDate(Date.parse(message.receivedAt)) === date);
  const unread = arrived.filter((message) => message.unread && message.category === "primary")
    .sort((a, b) => Number(b.important) - Number(a.important) || b.receivedAt.localeCompare(a.receivedAt));
  const written = unread.filter((message) => !machineMail(message));

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
    date, part,
    calendar: !calendar?.sources?.length ? "none" : calendar.sources.some((source) => source.error) ? "error" : "ok",
    current, next, tomorrow,
    allDay: today.day.allDay,
    rows,
    loose: today.day.loose,
    late: open.filter((todo) => !!todo.due && todo.due < date && !isFor(todo, date)).length,
    turned, ahead: ahead.day, passed: events.length,
    unfinished: [...rows.flatMap((row) => (row.kind === "todo" ? [{ todo: row.todo, k: row.k, at: row.at }] : [])), ...today.day.loose],
    waiting: { count: waiting.length, top: distinct.slice(0, TOP) },
    mail: {
      state: !sources.length ? "none" : !sources.some((source) => source.canRead !== false) ? "sendOnly" : sources.some((source) => source.error) ? "error" : "ok",
      today: arrived.length, unread: unread.length, rows: written.slice(0, MAIL_ROWS), machine: unread.length - written.length,
    },
    doing,
    upcoming: soonest ? { name: automationTitle(soonest), when: whenText(soonest.nextAt!, now) } : undefined,
    done,
  };
}

/** One row of the day's line. Whatever it is, it is drawn the same way: when · what kind · what it is · the way in. */
export type LineRow =
  | { key: string; kind: "wait"; item: InboxItem }
  /** `at` absent: it covers the whole day. */
  | { key: string; kind: "event"; event: CalendarEvent; at?: string; until?: string; past: boolean; now: boolean }
  /** `late`: due at an hour that has gone by, and still open. */
  | { key: string; kind: "todo"; todo: Todo; k: string | null; at?: string; late: boolean }
  | { key: string; kind: "mail"; message: MailMessage };

/** The day in order (docs/design/today-and-inbox.md, 3.1b): one list, three marks on it (now, sometime today,
 * tomorrow), and no section for where a thing comes from. */
export interface TodayLine {
  /** Today's events that are over: folded into one line. */
  past: LineRow[];
  /** At "now": the first few things waiting on the user (`moreWaiting` more are in the Inbox)… */
  wait: LineRow[];
  moreWaiting: number;
  /** …then what is on or still to come today, a todo past its hour included. */
  ahead: LineRow[];
  /** Today, at no hour: todos, and unread letters marked important. */
  within: LineRow[];
  /** Tomorrow: all of it once the evening has turned to it, else its first few (`moreTomorrow` beyond them). */
  tomorrow: LineRow[];
  moreTomorrow: number;
}

const LINE_MAIL = 3, LINE_TOMORROW = 3;

export function todayLine(model: TodayModel): TodayLine {
  const rowsOf = (day: Pick<TodayDay, "date" | "allDay" | "rows" | "loose">) => ({
    allDay: day.allDay.map((event): LineRow => ({ key: `${day.date}:e:${event.account}:${event.id}`, kind: "event", event, past: false, now: false })),
    timed: day.rows.map((row): LineRow => row.kind === "event"
      ? { key: `${day.date}:e:${row.event.account}:${row.event.id}`, kind: "event", event: row.event, at: row.at, until: row.until, past: row.past, now: row.now }
      : { key: `${day.date}:t:${row.todo.id}`, kind: "todo", todo: row.todo, k: row.k, at: row.at, late: row.past }),
    loose: day.loose.map(({ todo, k }): LineRow => ({ key: `${day.date}:t:${todo.id}`, kind: "todo", todo, k, late: false })),
  });
  const over = (row: LineRow) => row.kind === "event" && row.past;
  const today = rowsOf(model), next = rowsOf(model.ahead);
  const tomorrow = [...next.allDay, ...next.timed, ...next.loose];
  const shown = model.turned ? tomorrow : tomorrow.slice(0, LINE_TOMORROW);
  return {
    past: today.timed.filter(over),
    wait: model.waiting.top.map((item): LineRow => ({ key: `w:${item.id}`, kind: "wait", item })),
    moreWaiting: model.waiting.count - model.waiting.top.length,
    ahead: [...today.allDay, ...today.timed.filter((row) => !over(row))],
    within: [
      ...today.loose,
      ...model.mail.rows.filter((message) => message.important).slice(0, LINE_MAIL).map((message): LineRow => ({ key: `m:${message.account}|${message.id}`, kind: "mail", message })),
    ],
    tomorrow: shown,
    moreTomorrow: tomorrow.length - shown.length,
  };
}

/** "1 小时 50 分", "25 分钟": how long until something, in whole minutes. */
export function untilText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000)), h = Math.floor(minutes / 60), m = minutes % 60;
  if (!h) return t("today.left.m", { m });
  return m ? t("today.left.hm", { h, m }) : t("today.left.h", { h });
}

/** The page's one line, in the top bar: the day by its counts. The page's own first sentence says what is next, so
 * this does not say it again. Also what Alfred hears with a question asked from here. */
export function todaySummary(state: StateResponse, now: number = Date.now()): string {
  const model = todayModel(state, now);
  const parts = [
    model.calendar === "none" ? t("today.noCalendar") : model.passed ? t("today.sum.events", { n: model.passed }) : t("today.sum.noEvents"),
    ...(model.unfinished.length ? [t("today.sum.todos", { n: model.unfinished.length })] : []),
    ...(model.waiting.count ? [t("today.sum.waiting", { n: model.waiting.count })] : []),
  ];
  return parts.join(" · ");
}
