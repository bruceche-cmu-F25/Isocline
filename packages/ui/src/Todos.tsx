import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Area, Automation } from "@zirma/protocol";
import type { CalendarEvent, CalendarSnapshot } from "@zirma/module-calendar/types";
import { isDayOff, SAMPLE_OFF_WORDS, type CalendarMode, type TodoOp, type TodoSnapshot } from "@zirma/module-todo/types";
import { api } from "./api.ts";
import { AddBar, Pill, PickerPill } from "./AddBar.tsx";
import { Linked, OutLink } from "./Linked.tsx";
import { getLocale, t, type Key, getAssistant } from "./i18n/index.ts";
import type { PageLine } from "./shell/about.ts";
import { todoChange } from "./shell/say.ts";
import { PHONE, useMedia } from "./shell/layout.ts";
import { Select } from "./shell/Select.tsx";
import "./todos-phone.css";

type Item = TodoSnapshot["todos"][number];
type View = "list" | "board" | "week";
type OnError = (message: string | null) => void;

/* ── Days ── */

const parse = (date: string) => { const [y, m, d] = date.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function addDays(date: string, days: number): string { const next = parse(date); next.setDate(next.getDate() + days); return iso(next); }
const between = (from: string, to: string) => Math.round((parse(to).getTime() - parse(from).getTime()) / 864e5);
const weekdayOf = (date: string) => parse(date).getDay();
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
const weekdayName = (date: string) => t("todo.weekdays").split(",")[weekdayOf(date)];
/** Days from `today` to the Sunday that ends its week (weeks start on Monday). */
const toSunday = (today: string) => (7 - weekdayOf(today)) % 7;

/** "Today", "Tomorrow", "Sat", "Next Tue", "12/3". */
function dayWord(date: string, today: string): string {
  const days = between(today, date);
  if (days === 0) return t("todo.today");
  if (days === 1) return t("todo.tomorrow");
  if (days < 0) return t("todo.overdue", { date: md(date) });
  const end = toSunday(today);
  if (days <= end || days < 7) return weekdayName(date);
  if (days <= end + 7) return t("todo.nextWeekday", { day: weekdayName(date) });
  return md(date);
}

/** When it is due as a short line: "Today 21:00", "11/23 – 12/4". */
function dueLabel(todo: Item, today: string): string | null {
  if (!todo.due) return null;
  if (todo.startDate && todo.startDate !== todo.due) return `${md(todo.startDate)} – ${md(todo.due)}`;
  return `${dayWord(todo.due, today)}${todo.at ? ` ${todo.at}` : ""}`;
}

/** The minute it is due: its hour, or the end of its day. */
function dueTime(todo: Item): number | null {
  if (!todo.due) return null;
  const day = parse(todo.due);
  if (todo.at) { const [h, m] = todo.at.split(":").map(Number); day.setHours(h, m); } else day.setDate(day.getDate() + 1);
  return day.getTime();
}

function span(minutes: number): string {
  const abs = Math.abs(Math.round(minutes)), d = Math.floor(abs / 1440), h = Math.floor((abs % 1440) / 60), m = abs % 60;
  if (d >= 1) return h ? t("todo.span.dh", { d, h }) : t("todo.span.d", { d });
  if (h >= 1) return m ? t("todo.span.hm", { h, m }) : t("todo.span.h", { h });
  return t("todo.span.m", { m });
}

/** The clock, a minute at a time, for the countdowns. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  return now;
}

/* ── What a todo says about itself ── */

type Repeat = NonNullable<NonNullable<Item["source"]>["repeat"]>;
const mondayFirst = (day: number) => (day + 6) % 7;
function repeatLabel(repeat: Repeat): string {
  const names = t("todo.rep.days").split(",");
  const days = [...repeat.days].sort((a, b) => mondayFirst(a) - mondayFirst(b)).map((day) => names[day]).join(t("todo.rep.join"));
  return `${repeat.days.length >= 7 ? t("todo.rep.daily") : t("todo.rep.weekly", { days })}${repeat.at ? ` ${repeat.at}` : ""}`;
}

/** The next time of something that repeats can be ticked off only once its day has come (the server says so too):
 * ticking one brings the time after it, so a tick ahead would look like nothing happened and use up the days to come. */
const notYet = (todo: Item, today: string) => !!todo.source?.repeat && !todo.done && !!todo.due && (todo.startDate ?? todo.due) > today;

/** Who put it on the list: the calendar, mail (picked out by Zirma), Zirma in a conversation, or the user. */
type Origin = "calendar" | "mail" | "alfred" | "you";
const originOf = (todo: Item): Origin => todo.source?.kind ?? (todo.changedBy?.kind === "todo.added" ? "alfred" : "you");
const addedDay = (todo: Item) => iso(new Date(todo.createdAt));
/** How long somebody's own todo has waited; a calendar's todo was put there by a date, not left. */
const waited = (todo: Item, today: string) => {
  const origin = originOf(todo);
  if (todo.done || todo.suggested || todo.source?.repeat || (origin !== "you" && origin !== "alfred")) return 0;
  return Math.max(0, between(addedDay(todo), today));
};
const STALE_DAYS = 7;

/** Days in a row the times of a repeating todo were done, up to the one before its next time. */
function streakOf(todo: Item, all: Item[]): number {
  const repeat = todo.source?.repeat;
  if (!repeat || repeat.days.length < 7 || !todo.due) return 0;
  const done = new Set(all.filter((other) => other.done && other.source?.ref === todo.source!.ref && other.due).map((other) => other.due!));
  let n = 0;
  for (let day = addDays(todo.due, -1); done.has(day); day = addDays(day, -1)) n++;
  return n;
}

const ICON: Record<Origin | "repeat" | "wait" | "link" | "off" | "cal" | "note", ReactNode> = {
  calendar: <path d="M3.5 5.5h13v11h-13zM3.5 8.5h13M7 3.5v3M13 3.5v3" />,
  mail: <><rect x="3" y="5" width="14" height="10.5" rx="2" /><path d="M3.5 6.5l6.5 4.5 6.5-4.5" /></>,
  alfred: <><path d="M10 2.8l6.2 3.6v7.2L10 17.2l-6.2-3.6V6.4z" /><path d="M10 10l6.2-3.6M10 10v7.2M10 10L3.8 6.4" /></>,
  you: <><circle cx="10" cy="7" r="3" /><path d="M4.5 16.5c.8-2.8 3-4.2 5.5-4.2s4.7 1.4 5.5 4.2" /></>,
  repeat: <><path d="M4.5 9a5.5 5.5 0 0 1 9.6-3.4L15.5 7M15.5 3.5V7H12M15.5 11a5.5 5.5 0 0 1-9.6 3.4L4.5 13M4.5 16.5V13H8" /></>,
  wait: <path d="M6 3.5h8M6 16.5h8M7 3.5c0 3.8 6 3.8 6 6.5s-6 2.7-6 6.5M13 3.5c0 3.8-6 3.8-6 6.5s6 2.7 6 6.5" />,
  link: <path d="M8.5 11.5l3-3M7 9.5L5.5 11a2.5 2.5 0 0 0 3.5 3.5L10.5 13M13 10.5l1.5-1.5A2.5 2.5 0 0 0 11 5.5L9.5 7" />,
  off: <><circle cx="10" cy="10" r="3" /><path d="M10 3v1.5M10 15.5V17M3 10h1.5M15.5 10H17M5 5l1 1M14 14l1 1M5 15l1-1M14 6l1-1" /></>,
  cal: <path d="M3.5 5.5h13v11h-13zM3.5 8.5h13M7 3.5v3M13 3.5v3" />,
  note: <path d="M5 3.5h7l3 3v10H5zM8 9.5h4M8 12.5h4" />,
};
const Icon = ({ name }: { name: keyof typeof ICON }) => <svg className="ti" viewBox="0 0 20 20" aria-hidden="true">{ICON[name]}</svg>;

function originShort(todo: Item): string {
  const origin = originOf(todo);
  if (origin === "calendar") return todo.source!.label;
  if (origin === "mail") return t("todo.src.mail");
  if (origin === "alfred") return getAssistant();
  return t("todo.from.you");
}
function originLong(todo: Item): string {
  const origin = originOf(todo);
  if (origin === "calendar") return t("todo.from.calendar", { name: todo.source!.label });
  if (origin === "mail") return t("todo.from.mail", { subject: todo.source!.label });
  return t(origin === "alfred" ? "todo.from.alfred" : "todo.from.youLong");
}

/** Under a day or an hour away (or past it): how long is left. Nothing for what repeats; its days come by themselves. */
function Countdown({ todo, now }: { todo: Item; now: number }) {
  const due = dueTime(todo);
  if (todo.done || todo.suggested || due === null || todo.source?.repeat) return null;
  const minutes = (due - now) / 60_000;
  // A day without an hour has no clock to count down to: it only says, once past, how many days late it is.
  if (!todo.at) {
    const late = todo.due ? between(todo.due, iso(new Date(now))) : 0;
    return late > 0 ? <span className="left" data-k="now"><i />{t("todo.late", { span: t("todo.span.d", { d: late }) })}</span> : null;
  }
  if (minutes > 1440) return null;
  const k = minutes < 0 || minutes <= 180 ? "now" : "warm";
  return <span className="left" data-k={k}><i />{minutes < 0 ? t("todo.late", { span: span(minutes) }) : t("todo.left", { span: span(minutes) })}</span>;
}

/** The small facts under a title: area, in progress, repeat, where from, how long it has waited, a link. */
function Meta({ todo, today, all, areas, when, hour, children }: { todo: Item; today: string; all: Item[]; areas: Area[]; when?: boolean; hour?: string | null; children?: ReactNode }) {
  const area = areas.find((candidate) => candidate.id === todo.area);
  const origin = originOf(todo);
  const streak = streakOf(todo, all);
  const days = waited(todo, today);
  const due = when ? dueLabel(todo, today) : null;
  return (
    <span className="todo-meta">
      {hour && <span className="hour">{hour}</span>}
      {children}
      {todo.suggested && <span className="by"><Icon name="alfred" />{t("todo.g.suggested")}</span>}
      {area && <span className="tag" data-k={area.k}>{area.name}</span>}
      {due && <span className="due">{due}</span>}
      {!when && todo.startDate && todo.due && todo.startDate !== todo.due && <span className="due">{md(todo.startDate)} – {md(todo.due)}</span>}
      {todo.status === "doing" && !todo.done && <span className="doing">{t("todo.doing")}</span>}
      {todo.plannedOn && !todo.done && <span className="due">{t("todo.planned", { date: md(todo.plannedOn) })}</span>}
      {todo.source?.repeat && !todo.done && (
        <span><Icon name="repeat" />{repeatLabel(todo.source.repeat)}{streak > 0 && ` · ${t("todo.streak", { n: streak })}`}</span>
      )}
      {origin !== "you" && <span className={origin === "alfred" ? "by" : undefined} title={originLong(todo)}><Icon name={origin} />{originShort(todo)}</span>}
      {days >= STALE_DAYS && <span className="stale" title={t("todo.waitedLong", { n: days })}><Icon name="wait" />{t("todo.waited", { n: days })}</span>}
      {todo.url && <span><Icon name="link" />{t("todo.hasLink")}</span>}
    </span>
  );
}

/* ── Doing things ── */

function useRun(onError: OnError) {
  const [busy, setBusy] = useState(false);
  const run = (op: TodoOp, input: unknown, then?: () => void) => {
    setBusy(true);
    onError(null);
    api.op(op, input).then((response) => {
      const result = response.result as { error?: string } | null;
      if (result && typeof result.error === "string") onError(result.error); else then?.();
    }).catch((reason: Error) => onError(reason.message)).finally(() => setBusy(false));
  };
  return { busy, run };
}

function Check({ todo, today, onError }: { todo: Item; today: string; onError: OnError }) {
  const { busy, run } = useRun(onError);
  const later = notYet(todo, today);
  const toggle = () => todo.done
    ? run("todo.update", { id: todo.id, revision: todo.revision, patch: { done: false } })
    : run("todo.complete", { id: todo.id, revision: todo.revision });
  return (
    <button type="button" className="check" role="checkbox" aria-checked={todo.done} disabled={busy || later} data-later={later || undefined}
      onClick={(event) => { event.stopPropagation(); toggle(); }}
      aria-label={t(todo.done ? "todo.uncheck" : "todo.check", { title: todo.title })} title={later ? t("todo.notYet", { date: dueLabel(todo, today) ?? "" }) : undefined}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10.5l3 3 6-7" /></svg>
    </button>
  );
}

/** Zirma's suggestion: keep it as a todo, or drop it (it is not suggested again). */
function KeepDrop({ todo, onError }: { todo: Item; onError: OnError }) {
  const { busy, run } = useRun(onError);
  return (
    <span className="keep-drop" onClick={(event) => event.stopPropagation()}>
      <button type="button" className="keep" disabled={busy} onClick={() => run("todo.accept", { id: todo.id, revision: todo.revision })} aria-label={t("todo.keepIt", { title: todo.title })}>{t("todo.keep")}</button>
      <button type="button" className="drop" disabled={busy} onClick={() => run("todo.delete", { id: todo.id, revision: todo.revision })} aria-label={t("todo.dropIt", { title: todo.title })}>{t("todo.drop")}</button>
    </span>
  );
}

/** A check, or the empty ring of what is only suggested. */
const Lead = ({ todo, today, onError }: { todo: Item; today: string; onError: OnError }) =>
  todo.suggested ? <span className="check" data-suggested aria-hidden="true" /> : <Check todo={todo} today={today} onError={onError} />;

/* ── A todo's card, over the blurred page (as an event's on the calendar) ── */

function Pop({ onClose, children }: { onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const escape = (press: KeyboardEvent) => { if (press.key === "Escape" && !press.isComposing) onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  return createPortal(
    <div className="ev-pop" role="presentation" onMouseDown={(down) => { if (down.target === down.currentTarget) onClose(); }}>{children}</div>,
    document.body,
  );
}

function TodoCard({ todo, today, all, areas, now, onClose, onError, onSay }: { todo: Item; today: string; all: Item[]; areas: Area[]; now: number; onClose(): void; onError: OnError; onSay?: () => void }) {
  const { busy, run } = useRun(onError);
  const [title, setTitle] = useState(todo.title);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setTitle(todo.title), [todo.title]);
  const patch = (change: Record<string, unknown>) => run("todo.update", { id: todo.id, revision: todo.revision, patch: change });
  const saveTitle = () => { const next = title.trim(); if (next && next !== todo.title) patch({ title: next }); else setTitle(todo.title); };
  const area = areas.find((candidate) => candidate.id === todo.area);
  const repeat = todo.source?.repeat;
  const streak = streakOf(todo, all);
  const due = dueTime(todo);
  const left = due !== null && !todo.done && !repeat && todo.at ? (due - now) / 60_000 : null;
  const nextMonday = addDays(today, toSunday(today) + 1);
  const days: Array<[string, string]> = [[today, t("todo.today")], [addDays(today, 1), t("todo.tomorrow")], [nextMonday, t("todo.nextWeekday", { day: weekdayName(nextMonday) })], ["", t("todo.noDate")]];
  const origin = originOf(todo);
  const age = between(addedDay(todo), today);
  return (
    <Pop onClose={onClose}>
      <div className="ev-edit todo-card" data-k={area?.k} role="dialog" aria-modal="true" aria-label={todo.title}>
        <div className="todo-card-head">
          <Lead todo={todo} today={today} onError={onError} />
          <textarea className="todo-card-title" value={title} rows={1} maxLength={500} aria-label={t("todo.titleOf")} disabled={busy}
            onChange={(event) => setTitle(event.target.value)} onBlur={saveTitle}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); (event.target as HTMLTextAreaElement).blur(); } }} />
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>×</button>
        </div>

        <div className="todo-fact">
          <Icon name="cal" />
          <div>
            <p>
              {todo.due ? <>{dueLabel(todo, today)} · {md(todo.due)} {weekdayName(todo.due)}{!todo.at && !todo.startDate ? ` · ${t("todo.allDay")}` : ""}</> : t("todo.noDate")}
              {left !== null && <span className="quiet"> · {left < 0 ? t("todo.late", { span: span(left) }) : t("todo.left", { span: span(left) })}</span>}
            </p>
            {!repeat && !todo.done && (
              <div className="todo-card-row">
                {days.map(([date, word]) => (
                  <button type="button" key={word} className="mini" aria-pressed={(todo.due ?? "") === date && !todo.startDate} disabled={busy}
                    onClick={() => patch(date ? { due: date, startDate: "" } : { due: "", startDate: "" })}>{word}</button>
                ))}
                <PickerPill type="date" icon="day" value={todo.due ?? ""} empty={t("todo.pickDay")} text={todo.due ? md(todo.due) : undefined} label={t("todo.due")} onChange={(value) => patch({ due: value, ...(value ? {} : { startDate: "" }) })} />
                {todo.due && <PickerPill type="time" icon="hour" value={todo.at ?? ""} empty={t("todo.pickHour")} label={t("todo.at")} onChange={(value) => patch({ at: value })} />}
              </div>
            )}
          </div>
        </div>

        {repeat && (
          <div className="todo-fact">
            <Icon name="repeat" />
            <div>
              <p>{repeatLabel(repeat)}{streak > 0 && <span className="quiet"> · {t("todo.streak", { n: streak })}</span>}</p>
              {repeat.days.length >= 7 && (
                <span className="streak" aria-hidden="true">
                  {Array.from({ length: 14 }, (_, index) => { const day = addDays(todo.due!, index - 14); return <i key={day} data-on={streak >= 14 - index || undefined} data-today={day === today || undefined} />; })}
                </span>
              )}
              {notYet(todo, today) && <p className="quiet">{t("todo.notYet", { date: dueLabel(todo, today) ?? "" })}</p>}
            </div>
          </div>
        )}

        <div className="todo-fact">
          <svg className="ti" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 3.5h6l7 7-6 6-7-7z" /><circle cx="7" cy="7" r="1" /></svg>
          <div className="todo-card-row">
            {areas.map((candidate) => (
              <button type="button" key={candidate.id} className="mini" data-k={candidate.k} aria-pressed={todo.area === candidate.id} disabled={busy}
                onClick={() => patch({ area: todo.area === candidate.id ? "" : candidate.id })}>{candidate.name}</button>
            ))}
          </div>
        </div>

        <div className="todo-fact">
          <Icon name={origin} />
          <div>
            <p>
              {originLong(todo)}
              {todo.source?.link && <> · <OutLink href={todo.source.link}>{t("todo.openSource")}</OutLink></>}
            </p>
            <p className="quiet">{t("todo.addedOn", { date: md(addedDay(todo)) })}{age >= 1 && !todo.done ? ` · ${t("todo.daysAgo", { n: age })}` : ""}</p>
          </div>
        </div>

        {todo.url && (
          <div className="todo-fact"><Icon name="link" /><p className="todo-card-url"><OutLink href={todo.url}>{todo.url}</OutLink></p></div>
        )}

        <div className="todo-card-foot">
          {todo.suggested
            ? <KeepDrop todo={todo} onError={onError} />
            : !todo.done && <button type="button" className="mini" aria-pressed={todo.status === "doing"} disabled={busy} onClick={() => patch({ status: todo.status === "doing" ? "todo" : "doing" })}>{t("todo.doing")}</button>}
          {/* Words about it go in the line under the page: the card steps aside. */}
          {onSay && !todo.suggested && !todo.done && <button type="button" className="mini" disabled={busy} onClick={onSay}>{t("say.open")}</button>}
          <span className="grow" />
          {!todo.suggested && (
            <button type="button" className={confirming ? "mini danger" : "mini quiet-danger"} disabled={busy}
              onClick={() => { if (!confirming) return setConfirming(true); run("todo.delete", { id: todo.id, revision: todo.revision }, onClose); }}>
              {confirming ? t("todo.confirmDelete", { title: "" }).replace(/[“”「」]/g, "").trim() : t("todo.deleteShort")}
            </button>
          )}
        </div>
      </div>
    </Pop>
  );
}

/* ── The views ── */

interface ViewProps {
  open: Item[];
  suggested: Item[];
  all: Item[];
  today: string;
  now: number;
  areas: Area[];
  fresh: ReadonlySet<string>;
  daysOff: DayOff[];
  events: CalendarEvent[];
  onOpen(id: string): void;
  onError: OnError;
  /** A phone: one column, facts on one line under the title, lanes one at a time. */
  phone?: boolean;
}
type TodayHeading = (title: ReactNode) => ReactNode;
interface DayOff { from: string; to: string; title: string }
const offOn = (daysOff: DayOff[], date: string) => daysOff.filter((off) => off.from <= date && off.to >= date);
const byHour = (a: Item, b: Item) => (a.at ?? "99").localeCompare(b.at ?? "99") || a.title.localeCompare(b.title);
const byDue = (a: Item, b: Item) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || byHour(a, b);
/** A todo counts on a day: a range running that day counts on it, else its due day. */
const runsOn = (todo: Item, date: string) => !!todo.due && (todo.startDate ? todo.startDate <= date && todo.due >= date : todo.due === date);
const timedOn = (events: CalendarEvent[], date: string) => events.filter((event) => !event.allDay && event.start && event.startDate === date && event.response !== "declined");

/** A: by day. The next two weeks as a strip (how full each day is, the days off), then the todos day by day, each
 * with its hour. */
function ByDay({ open, suggested, all, today, now, areas, fresh, daysOff, events, onOpen, onError, phone, todayHeading }: ViewProps & { todayHeading?: TodayHeading }) {
  const days = Array.from({ length: 14 }, (_, index) => addDays(today, index));
  const shown = [...open, ...suggested];
  const groups = new Map<string, Item[]>();
  const put = (key: string, todo: Item) => groups.set(key, [...(groups.get(key) ?? []), todo]);
  for (const todo of shown) {
    if (!todo.due) put("any", todo);
    else if (todo.startDate && todo.startDate <= today && todo.due >= today) put(today, todo);
    else if (todo.due < today) put("late", todo);
    else if (between(today, todo.startDate ?? todo.due) > 13) put("later", todo);
    else put(todo.startDate ?? todo.due, todo);
  }
  const dated = days.filter((date) => groups.has(date) || offOn(daysOff, date).length || date === today);
  const jump = (date: string) => document.getElementById(`todo-day-${date}`)?.scrollIntoView({ behavior: "smooth", block: "start" });

  const row = (todo: Item) => {
    const late = !!todo.due && todo.due < today && !(todo.startDate && todo.startDate <= today);
    const at = todo.at ?? null;
    const sub = todo.startDate && todo.startDate !== todo.due ? t("todo.range") : late ? md(todo.due!) : todo.due && !at ? t("todo.allDay") : "";
    const area = areas.find((candidate) => candidate.id === todo.area);
    return (
      <li key={todo.id} className="todo" data-k={area?.k} data-suggested={todo.suggested || undefined} data-fresh={fresh.has(`todo:${todo.id}`) || undefined}
        onClick={() => onOpen(todo.id)}>
        {/* A phone has no room for a column of hours: the hour leads the facts under the title, with how long is left. */}
        {!phone && <span className="todo-at">{at}{sub && <small>{sub}</small>}</span>}
        <Lead todo={todo} today={today} onError={onError} />
        <span className="todo-body">
          <span className="todo-title"><Linked text={todo.title} /></span>
          <Meta todo={todo} today={today} all={all} areas={areas} hour={phone ? at : null}>{phone && <Countdown todo={todo} now={now} />}</Meta>
          {todo.suggested && <KeepDrop todo={todo} onError={onError} />}
        </span>
        {!phone && <span className="todo-end"><Countdown todo={todo} now={now} /></span>}
      </li>
    );
  };
  const section = (key: string, head: ReactNode, items: Item[], extra?: { today?: boolean; late?: boolean; empty?: string }) => (
    <section key={key} id={`todo-day-${key}`} className="todo-day" data-today={extra?.today || undefined} data-late={extra?.late || undefined}>
      {extra?.today && todayHeading ? todayHeading(head) : <div className="todo-day-head">{head}</div>}
      {items.length > 0 ? <ul>{items.map(row)}</ul> : extra?.empty && <p className="quiet todo-day-empty">{extra.empty}</p>}
    </section>
  );

  return (
    <div className="todo-byday">
      <div className="todo-strip" role="group" aria-label={t("todo.twoWeeks")}>
        {days.map((date, index) => {
          const on = open.filter((todo) => runsOn(todo, date) || (index === 0 && !!todo.due && todo.due < today));
          const off = offOn(daysOff, date);
          return (
            <button type="button" key={date} className="todo-cell" onClick={() => jump(date)} data-today={index === 0 || undefined} data-off={off.length > 0 || undefined}
              data-far={index >= 7 || undefined} title={[`${md(date)} ${weekdayName(date)}`, ...off.map((x) => x.title), on.length ? t("todo.nOpen", { n: on.length }) : ""].filter(Boolean).join("\n")}>
              <span className="wd">{index === 0 ? t("todo.today") : weekdayName(date)}</span>
              <span className="d">{Number(date.slice(8))}</span>
              <span className="dots">
                {on.slice(0, 6).map((todo) => <i key={todo.id} data-k={areas.find((area) => area.id === todo.area)?.k} data-hour={todo.at ? true : undefined} />)}
                {on.length > 6 && <i />}
              </span>
              {off.length > 0 && <span className="off">{off[0].title}</span>}
            </button>
          );
        })}
      </div>

      {groups.has("late") && section("late", <h3>{t("todo.g.late")}<span className="count">{groups.get("late")!.length}</span></h3>, groups.get("late")!.sort(byDue), { late: true })}
      {dated.map((date) => {
        const off = offOn(daysOff, date);
        const busy = timedOn(events, date);
        return section(date, (
          <>
            <h3>{dayWord(date, today)}</h3>
            <span className="date">{md(date)} {weekdayName(date)}</span>
            {off.map((x) => <span className="ctx" key={x.title}><Icon name="off" />{x.title}</span>)}
            {busy.length > 0 && <span className="cal-n" title={busy.map((event) => `${hhmm(event.start!)} ${event.title}`).join("\n")}><Icon name="cal" />{t("todo.events", { n: busy.length })}</span>}
          </>
        ), (groups.get(date) ?? []).sort(byHour), { today: date === today, empty: date === today ? t("todo.todayClear") : undefined });
      })}
      {groups.has("later") && section("later", <h3>{t("todo.g.afterTwoWeeks")}<span className="count">{groups.get("later")!.length}</span></h3>, groups.get("later")!.sort(byDue))}
      {groups.has("any") && section("any", <h3>{t("todo.g.someday")}<span className="count">{groups.get("any")!.length}</span></h3>, groups.get("any")!)}
    </div>
  );
}

const hhmm = (instant: string) => { const at = new Date(instant); return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`; };
const minuteOf = (instant: string) => { const at = new Date(instant); return at.getHours() * 60 + at.getMinutes(); };

/** B: a board. Today, tomorrow, the rest of this week, later, any time; a card dragged to another column moves there.
 * On a phone one lane fills the width and the next peeks in at the edge: swiped between, or picked by name in the
 * row above (a card is moved with the days in its own card; there is no dragging on a touch screen). */
function Board({ open, suggested, all, today, now, areas, fresh, daysOff, onOpen, onError, phone, todayHeading }: ViewProps & { todayHeading?: TodayHeading }) {
  const { run } = useRun(onError);
  const [over, setOver] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(0);
  const lanesOf = () => Array.from(strip.current?.children ?? []) as HTMLElement[];
  const showLane = (index: number) => {
    const board = strip.current, lane = lanesOf()[index];
    if (board && lane) board.scrollTo({ left: lane.offsetLeft - board.offsetLeft - parseFloat(getComputedStyle(board).paddingLeft), behavior: "smooth" });
  };
  const followScroll = () => {
    const board = strip.current;
    if (!board) return;
    const lanes = lanesOf();
    const at = board.scrollLeft + board.offsetLeft + parseFloat(getComputedStyle(board).paddingLeft);
    let nearest = 0;
    lanes.forEach((lane, index) => { if (Math.abs(lane.offsetLeft - at) < Math.abs(lanes[nearest].offsetLeft - at)) nearest = index; });
    setInView(nearest);
  };
  const end = toSunday(today);
  const first = (todo: Item) => todo.startDate ?? todo.due!;
  const lanes = [
    { id: "today", name: t("todo.today"), sub: md(today), to: today, test: (todo: Item) => !!todo.due && (todo.due <= today || (!!todo.startDate && todo.startDate <= today)) },
    { id: "tomorrow", name: t("todo.tomorrow"), sub: md(addDays(today, 1)), to: addDays(today, 1), test: (todo: Item) => !!todo.due && between(today, first(todo)) === 1 },
    ...(end >= 2 ? [{ id: "week", name: t("todo.g.week"), sub: `${md(addDays(today, 2))} – ${md(addDays(today, end))}`, to: addDays(today, 2), test: (todo: Item) => !!todo.due && between(today, first(todo)) >= 2 && between(today, first(todo)) <= end }] : []),
    { id: "later", name: t("todo.g.later"), sub: t("todo.from", { date: md(addDays(today, Math.max(end, 1) + 1)) }), to: addDays(today, Math.max(end, 1) + 1), test: (todo: Item) => !!todo.due && between(today, first(todo)) > Math.max(end, 1) },
    { id: "any", name: t("todo.g.someday"), sub: "", to: "", test: (todo: Item) => !todo.due },
  ];
  const move = (id: string, to: string) => {
    const todo = open.find((candidate) => candidate.id === id);
    if (!todo || todo.source?.repeat) return;
    run("todo.update", { id: todo.id, revision: todo.revision, patch: to ? { due: to, startDate: "" } : { due: "", startDate: "" } });
  };
  const seen = new Set<string>();
  const filled = lanes.map((lane) => {
    const items = [...open, ...suggested].filter((todo) => !seen.has(todo.id) && lane.test(todo)).sort(byDue);
    items.forEach((todo) => seen.add(todo.id));
    return { lane, items };
  });
  return (
    <>
    {phone && (
      <div className="lane-tabs" role="group" aria-label={t("todo.view.board")}>
        {filled.map(({ lane, items }, index) => (
          <button type="button" key={lane.id} aria-pressed={inView === index} data-today={lane.id === "today" || undefined} onClick={() => showLane(index)}>
            {lane.name}{items.length > 0 && <span className="count">{items.length}</span>}
          </button>
        ))}
      </div>
    )}
    <div className="todo-board" ref={strip} onScroll={phone ? followScroll : undefined}>
      {filled.map(({ lane, items }) => {
        const laneOff = lane.id === "any" ? [] : daysOff.filter((off) => {
          const from = lane.id === "today" ? today : lane.id === "tomorrow" ? addDays(today, 1) : lane.id === "week" ? addDays(today, 2) : lane.to;
          const to = lane.id === "today" ? today : lane.id === "tomorrow" ? addDays(today, 1) : lane.id === "week" ? addDays(today, end) : "9999";
          return off.from <= to && off.to >= from;
        });
        const heading = <h3>{lane.name}<span className="date">{lane.sub}</span><span className="count">{items.length}</span></h3>;
        return (
          <section key={lane.id} className="todo-lane" data-today={lane.id === "today" || undefined} data-over={over === lane.id || undefined}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("text/todo")) { event.preventDefault(); setOver(lane.id); } }}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null); }}
            onDrop={(event) => { event.preventDefault(); setOver(null); move(event.dataTransfer.getData("text/todo"), lane.to); }}>
            {lane.id === "today" && todayHeading ? todayHeading(heading) : heading}
            {laneOff.map((off) => <span className="ctx" key={off.from + off.title}><Icon name="off" />{lane.id === "today" || lane.id === "tomorrow" ? "" : `${md(off.from)}${off.to !== off.from ? `–${md(off.to)}` : ""} `}{off.title}</span>)}
            <ul>
              {items.map((todo) => {
                const area = areas.find((candidate) => candidate.id === todo.area);
                const movable = !todo.suggested && !todo.source?.repeat;
                return (
                  <li key={todo.id} className="todo-tile" data-k={area?.k} data-suggested={todo.suggested || undefined} data-fresh={fresh.has(`todo:${todo.id}`) || undefined}
                    draggable={movable} onDragStart={(event) => { event.dataTransfer.setData("text/todo", todo.id); event.dataTransfer.effectAllowed = "move"; }}
                    onClick={() => onOpen(todo.id)}>
                    <div className="todo-tile-top"><Lead todo={todo} today={today} onError={onError} /><span className="todo-title"><Linked text={todo.title} /></span></div>
                    {todo.due && !phone && <div className="todo-tile-when"><span className="due">{todo.due < today && !todo.startDate ? md(todo.due) : dueLabel(todo, today)}</span><Countdown todo={todo} now={now} /></div>}
                    {/* A phone: the day joins the other facts on one line, and only says what the lane does not. */}
                    <Meta todo={todo} today={today} all={all} areas={areas} hour={phone && todo.due === lane.to && !todo.startDate ? todo.at : null}>
                      {phone && todo.due && !(todo.due === lane.to && !todo.startDate) && <span className="due">{todo.due < today && !todo.startDate ? md(todo.due) : dueLabel(todo, today)}</span>}
                      {phone && <Countdown todo={todo} now={now} />}
                    </Meta>
                    {todo.suggested && <KeepDrop todo={todo} onError={onError} />}
                  </li>
                );
              })}
            </ul>
            {items.length === 0 && <p className="quiet todo-lane-empty">{t(phone ? "todo.laneEmpty" : "todo.dropHere")}</p>}
          </section>
        );
      })}
    </div>
    </>
  );
}

/** Open work carried into today and work completed today, including tasks spanning several days. */
function TodayProgress({ all, today, hideEmpty }: { all: Item[]; today: string; hideEmpty?: boolean }) {
  const ofToday = all.filter((todo) => !todo.suggested && !todo.archivedAt && (todo.done ? (todo.completedAt ? iso(new Date(todo.completedAt)) === today : todo.due === today) : runsOn(todo, today) || (!!todo.due && todo.due < today)));
  if (hideEmpty && !ofToday.length) return null;
  const doneN = ofToday.filter((todo) => todo.done).length;
  const ring = 2 * Math.PI * 24;
  return (
    <span className="todo-progress">
      <svg viewBox="0 0 56 56" aria-hidden="true"><circle className="bg" cx="28" cy="28" r="24" /><circle className="fg" cx="28" cy="28" r="24" strokeDasharray={ring} strokeDashoffset={ring * (1 - (ofToday.length ? doneN / ofToday.length : 0))} transform="rotate(-90 28 28)" /></svg>
      <span>{t("todo.doneToday", { done: doneN, total: ofToday.length })}</span>
    </span>
  );
}

/** The next deadline and the hours left between calendar events. A phone includes progress in the heading. */
function TodayRail({ open, all, today, now, areas, events, inHeading }: ViewProps & { inHeading?: boolean }) {
  const next = open.filter((todo) => todo.at && (dueTime(todo) ?? 0) > now).sort((a, b) => dueTime(a)! - dueTime(b)!)[0];
  const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const from = Math.max(0, Math.floor(nowMin / 60) * 60), to = 24 * 60;
  const height = Math.max(160, Math.min(320, (to - from) / 3));
  const y = (minute: number) => ((minute - from) / (to - from)) * height;
  const busy = timedOn(events, today).filter((event) => event.end && minuteOf(event.end) > nowMin && iso(new Date(event.end)) === today || (event.end && iso(new Date(event.end)) > today))
    .map((event) => ({ event, a: Math.max(minuteOf(event.start!), from), b: iso(new Date(event.end!)) > today ? to : minuteOf(event.end!) }))
    .sort((p, q) => p.a - q.a);
  const deadline = next && next.due === today ? minuteOf(new Date(dueTime(next)!).toISOString()) : to;
  const frees: Array<[number, number]> = [];
  let cursor = nowMin;
  for (const { a, b } of busy) { if (a > cursor && cursor < deadline) frees.push([cursor, Math.min(a, deadline)]); cursor = Math.max(cursor, b); }
  if (deadline > cursor) frees.push([cursor, deadline]);
  const free = frees.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0);
  const lines = open.filter((todo) => todo.at && todo.due === today);
  const nextLeft = next ? (dueTime(next)! - now) / 60_000 : 0;

  return (
      <aside className="todo-rail" aria-label={t("todo.g.today")}>
        {!inHeading && <div className="todo-panel todo-panel-today">
          <h4>{t("todo.g.today")} · {md(today)} {weekdayName(today)}</h4>
          <TodayProgress all={all} today={today} />
        </div>}
        {next && (
          <div className="todo-panel" data-k={nextLeft <= 180 ? "now" : "warm"}>
            <h4>{t("todo.nextDeadline")}</h4>
            {!inHeading && <p className="todo-big">{t("todo.left", { span: span(nextLeft) })}</p>}
            <p className="todo-next-what">{dueLabel(next, today)} · {next.title}</p>
            {next.due === today && <p className="quiet">{t("todo.freeBefore", { span: span(free) })}</p>}
          </div>
        )}
        <div className="todo-panel todo-panel-tl">
          <h4>{t("todo.restOfToday")}<span>{t("todo.calAndDeadlines")}</span></h4>
          <div className="todo-tl" style={{ height }}>
            {Array.from({ length: Math.floor((to - from) / 120) + 1 }, (_, index) => from + index * 120).map((minute) => (
              <div className="hr" key={minute} style={{ top: y(minute) }}><span>{String(Math.floor(minute / 60) % 24).padStart(2, "0")}:00</span></div>
            ))}
            {frees.filter(([a, b]) => b - a >= 30).map(([a, b]) => <div className="free" key={a} style={{ top: y(a) + 1, height: y(b) - y(a) - 3 }}>{t("todo.free", { span: span(b - a) })}</div>)}
            {busy.map(({ event, a, b }) => <div className="ev" key={event.id} data-k={event.k} style={{ top: y(a), height: Math.max(14, y(b) - y(a) - 2) }}>{hhmm(event.start!)} {event.title}</div>)}
            {lines.map((todo) => { const m = minuteOf(new Date(dueTime(todo)!).toISOString()); return <div className="dl" key={todo.id} data-k={areas.find((area) => area.id === todo.area)?.k ?? "gray"} style={{ top: y(m) }}><span>{todo.at} {todo.title}</span></div>; })}
            <div className="now-line" style={{ top: y(nowMin) }} />
          </div>
        </div>
      </aside>
  );
}

/** What repeats every week, by weekday, Monday first: the shape of a week, not a list of dates. What is on every
 * day is said once, above the days. Its next time is marked, and can be ticked off on its day. */
function Week({ todos, today, areas, onOpen, onError }: { todos: Item[]; today: string; areas: Area[]; onOpen(id: string): void; onError: OnError }) {
  const names = t("todo.weekdays").split(",");
  const now = weekdayOf(today);
  const byAt = (a: Item, b: Item) => (a.source?.repeat?.at ?? "").localeCompare(b.source?.repeat?.at ?? "") || a.title.localeCompare(b.title);
  const daily = todos.filter((todo) => todo.source!.repeat!.days.length >= 7).sort(byAt);
  const some = todos.filter((todo) => todo.source!.repeat!.days.length < 7);
  const row = (todo: Item, next: boolean) => (
    <li key={todo.id} className="week-row" data-k={areas.find((area) => area.id === todo.area)?.k} data-next={next || undefined} onClick={() => onOpen(todo.id)}>
      {next ? <Check todo={todo} today={today} onError={onError} /> : <span className="week-dot" aria-hidden="true" />}
      {todo.source?.repeat?.at && <span className="week-at">{todo.source.repeat.at}</span>}
      <span className="week-title"><Linked text={todo.title} /></span>
      {next && <span className="due">{dueLabel(todo, today)}</span>}
    </li>
  );
  return (
    <div className="todo-week">
      {daily.length > 0 && (
        <section className="week-day" data-daily aria-label={t("todo.rep.daily")}>
          <h3>{t("todo.rep.daily")}</h3>
          <ul>{daily.map((todo) => row(todo, true))}</ul>
        </section>
      )}
      {[1, 2, 3, 4, 5, 6, 0].map((day) => {
        const items = some.filter((todo) => todo.source!.repeat!.days.includes(day)).sort(byAt);
        return (
          <section className="week-day" key={day} data-today={day === now || undefined} data-empty={items.length ? undefined : true} aria-label={names[day]}>
            <h3>{names[day]}</h3>
            <ul>{items.map((todo) => row(todo, !!todo.due && weekdayOf(todo.due) === day))}</ul>
          </section>
        );
      })}
    </div>
  );
}

/* ── Sources, behind a button ── */

const MODES: CalendarMode[] = ["off", "allday", "all"];

/** What becomes a todo without the user writing it: calendar events (which ones), and what Zirma picks out of
 * mail (an automation, switched on and off here and run on its schedule). */
function Sources({ mode, words, picking, onError }: { mode: CalendarMode; words: string[]; picking?: Automation; onError: OnError }) {
  const [word, setWord] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = (action: () => Promise<unknown>) => {
    setBusy(true);
    action().catch((reason: Error) => onError(reason.message)).finally(() => setBusy(false));
  };
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (!(event.target as Element).closest?.(".todo-sources, .choice-menu")) setOpen(false); };
    const escape = (press: KeyboardEvent) => { if (press.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", escape); };
  }, [open]);
  return (
    <div className="todo-sources">
      <button type="button" className="chip" aria-expanded={open} onClick={() => setOpen(!open)} title={t("todo.sources")} aria-label={t("todo.sources")}>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h8M15 6h1M4 14h2M9 14h7" /><circle cx="13.5" cy="6" r="1.5" /><circle cx="7.5" cy="14" r="1.5" /></svg>
        <span className="todo-sources-word">{t("todo.sourcesShort")}</span>
      </button>
      {open && (
        <div className="todo-sources-pop" role="group" aria-label={t("todo.sources")}>
          <span className="todo-pick">
            <span>{t("todo.src.calendar")}</span>
            <Select className="tag area-pick" value={mode} disabled={busy} label={t("todo.src.calendarWhich")}
              onChange={(next) => act(() => api.op("todo.sources", { fromCalendar: next }))}
              options={MODES.map((candidate) => ({ value: candidate, label: t(`todo.src.cal.${candidate}` as Key) }))} />
          </span>
          {picking && (
            <span className="todo-pick">
              <span>{t("todo.src.mail")}</span>
              <span className="grow" />
              {picking.enabled && <span className="quiet">{picking.schedule.at}</span>}
              <button type="button" className="switch" role="switch" aria-checked={picking.enabled} disabled={busy} aria-label={t("todo.src.mailPick")} title={t("todo.src.mailPick")}
                onClick={() => act(() => api.updateAutomation(picking.id, { enabled: !picking.enabled }))} />
              <button type="button" className="pick-now" disabled={busy} onClick={() => act(() => api.runAutomation(picking.id))}>{t("todo.src.pickNow")}</button>
            </span>
          )}
          <p className="quiet">{t("todo.daysOffHint")}</p>
          {/* The words a day off is named by: the user's own list (samples until they change it). */}
          <div className="off-words" role="group" aria-label={t("todo.offWords")}>
            {words.map((one) => (
              <span key={one} className="off-word">{one}
                <button type="button" aria-label={t("todo.offWords.remove", { word: one })} disabled={busy}
                  onClick={() => act(() => api.op("todo.sources", { offWords: words.filter((other) => other !== one) }))}>×</button>
              </span>
            ))}
            <form onSubmit={(event) => {
              event.preventDefault();
              const next = word.trim();
              if (next) act(() => api.op("todo.sources", { offWords: [...words, next] }).then(() => setWord("")));
            }}>
              <input value={word} maxLength={40} placeholder={t("todo.offWords.add")} aria-label={t("todo.offWords.add")} disabled={busy} onChange={(event) => setWord(event.target.value)} />
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── The page ── */

const VIEWS: Array<[View, Key]> = [["list", "todo.view.list"], ["board", "todo.view.board"], ["week", "todo.view.week"]];
const VIEW_KEY = "zirma.todo.view";
const savedView = (): View => { try { const view = localStorage.getItem(VIEW_KEY); return VIEWS.some(([id]) => id === view) ? view as View : "list"; } catch { return "list"; } };

/** The todo page: what is open, day by day with today beside it, or as a board, or what repeats as a week (the
 * user picks; the device keeps it). */
export function Todos({ snapshot, fresh, areas, automations, calendar, line }: { snapshot: TodoSnapshot; fresh: ReadonlySet<string>; areas: Area[]; automations?: Automation[]; calendar?: CalendarSnapshot; line?: PageLine }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [at, setAt] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [newArea, setNewArea] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [view, setView] = useState<View>(savedView);
  const [opened, setOpened] = useState<string | null>(null);
  const { busy: adding, run } = useRun(setError);
  const now = useNow();
  const phone = useMedia(PHONE);
  const { today, todos } = snapshot;
  /** Puts a todo in the line under the page: a day, an hour or "done" changes it at once (shell/say.ts); words that
   * say more go to Zirma with the todo. */
  const say = (todo: Item) => {
    if (!line) return;
    setOpened(null);
    const nextMonday = addDays(today, toSunday(today) + 1);
    line.attach({
      key: `todo:say:${todo.id}`, label: todo.title.length > 24 ? `${todo.title.slice(0, 23)}…` : todo.title, placeholder: t("say.placeholder"),
      chips: [t("todo.today"), t("todo.tomorrow"), t("todo.nextWeekday", { day: weekdayName(nextMonday) }), t("say.done")],
      send: async (words) => {
        const change = todoChange(words, today, todo);
        if (!change) { await line.ask(t("say.goal.todo", { title: todo.title, text: words }), { id: `todo:${todo.id}`, title: todo.title.slice(0, 200) }); return; }
        const response = "done" in change
          ? await api.op("todo.complete", { id: todo.id })
          : await api.op("todo.update", { id: todo.id, patch: { ...change.patch, startDate: "" } });
        const result = response.result as { error?: string } | null;
        if (result && typeof result.error === "string") throw new Error(result.error);
      },
    });
  };

  // A suggestion is not a todo until it is kept: it is drawn apart and counted nowhere.
  const shown = (todo: Item) => filter === "all" || (filter === "none" ? !todo.area : todo.area === filter);
  const open = todos.filter((todo) => !todo.done && !todo.suggested);
  const suggested = todos.filter((todo) => todo.suggested && !todo.done);
  const chips = useMemo(() => {
    const used = areas.filter((area) => open.some((todo) => todo.area === area.id) || filter === area.id);
    return [
      { id: "all", label: t("common.all"), k: undefined as string | undefined, count: open.length },
      ...used.map((area) => ({ id: area.id, label: area.name, k: area.k, count: open.filter((todo) => todo.area === area.id).length })),
      ...(open.some((todo) => !todo.area) && used.length ? [{ id: "none", label: t("todo.noAreaChip"), k: "gray", count: open.filter((todo) => !todo.area).length }] : []),
    ];
  }, [areas, open, filter, getLocale()]);
  const done = todos.filter((todo) => todo.done && shown(todo)).sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")).slice(0, 30);
  // What repeats weekly (one todo each, from the calendar) can also be seen as a week.
  const weekly = open.filter((todo) => todo.source?.repeat?.days.length);
  const current: View = view === "week" && weekly.length === 0 ? "list" : view;
  const events = calendar?.events ?? [];
  const daysOff = useMemo(() => {
    const seen = new Set<string>();
    const words = snapshot.settings?.offWords ?? SAMPLE_OFF_WORDS;
    return events.filter((event) => isDayOff(event, words)).map((event) => ({ from: event.startDate, to: event.endDate, title: event.title.trim() }))
      .filter((off) => { const key = `${off.from}|${off.to}|${off.title}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((a, b) => a.from.localeCompare(b.from));
  }, [events, snapshot.settings?.offWords]);

  // New todos go into the area being looked at.
  useEffect(() => { setNewArea(areas.some((area) => area.id === filter) ? filter : ""); }, [filter, areas]);
  const pickView = (next: View) => { setView(next); try { localStorage.setItem(VIEW_KEY, next); } catch { /* kept for this visit only */ } };

  const add = () => run("todo.add", { title: title.trim(), ...(due ? { due } : {}), ...(due && at ? { at } : {}), ...(newArea ? { area: newArea } : {}) },
    () => { setTitle(""); setDue(""); setAt(""); });
  const addArea = areas.find((area) => area.id === newArea);
  const props: ViewProps = {
    open: open.filter(shown), suggested: suggested.filter(shown), all: todos, today, now, areas, fresh, daysOff, events,
    onOpen: setOpened, onError: setError, phone,
  };
  const openedTodo = todos.find((todo) => todo.id === opened);
  const nothing = props.open.length === 0 && props.suggested.length === 0;
  const todayHeading: TodayHeading | undefined = phone ? (heading) => (
    <details className="todo-summary">
      <summary className="todo-day-head" title={t("todo.restOfToday")}>
        {heading}
        <TodayProgress all={todos.filter(shown)} today={today} hideEmpty />
      </summary>
      <TodayRail {...props} inHeading />
    </details>
  ) : undefined;
  const emptyList = nothing && <>
    {todayHeading?.(<><h3>{t("todo.today")}</h3><span className="date">{md(today)} {weekdayName(today)}</span></>)}
    <p className="quiet empty-list">{t(filter === "all" ? "todo.emptyAll" : "todo.emptyArea")}</p>
  </>;

  return (
    <section className="todos" data-view={current} aria-label={t("todo.label")}>
      <div className="todo-bar">
        <div className="chips" role="group" aria-label={t("todo.byArea")}>
          {chips.length > 1 && chips.map((chip) => (
            <button type="button" key={chip.id} className="chip" aria-pressed={filter === chip.id} onClick={() => setFilter(chip.id)}>
              {chip.k && <span className="mark" data-k={chip.k} />}{chip.label}<span className="count">{chip.count}</span>
            </button>
          ))}
        </div>
        <div className="todo-views" role="group" aria-label={t("todo.view.label")}>
          {VIEWS.filter(([id]) => id !== "week" || weekly.length > 0).map(([id, key]) => (
            <button type="button" key={id} aria-pressed={current === id} onClick={() => pickView(id)} title={id === "week" ? t("todo.view.weekHint") : undefined}>{t(key)}</button>
          ))}
        </div>
        <Sources mode={snapshot.settings?.fromCalendar ?? "allday"} words={snapshot.settings?.offWords ?? [...SAMPLE_OFF_WORDS]} picking={automations?.find((automation) => automation.template === "mail_todos")} onError={setError} />
      </div>

      <AddBar value={title} onChange={setTitle} onSubmit={add} ready={!!title.trim()} busy={adding} maxLength={500}
        placeholder={t("todo.placeholder")} label={t("todo.new")} submitLabel={t("todo.add")}>
        <PickerPill type="date" icon="day" value={due} onChange={(value) => { setDue(value); if (!value) setAt(""); }} empty={t("todo.pickDay")}
          text={due ? dayWord(due, today) : undefined} label={t("todo.due")} />
        {due && <PickerPill type="time" icon="hour" value={at} onChange={setAt} empty={t("todo.pickHour")} label={t("todo.at")} />}
        <Pill icon="tag" text={addArea ? addArea.name : t("todo.pickArea")} set={!!addArea} k={addArea?.k} label={t("todo.newArea")} onClear={() => setNewArea("")}>
          <Select cover value={newArea} onChange={setNewArea} label={t("todo.newArea")}
            options={[{ value: "", label: t("todo.noArea") }, ...areas.map((area) => ({ value: area.id, label: area.name }))]} />
        </Pill>
      </AddBar>
      {error && <p className="problem small" role="alert">{error}</p>}

      <div className="todo-groups">
        {current === "week"
          ? <Week todos={weekly.filter(shown)} today={today} areas={areas} onOpen={setOpened} onError={setError} />
          : <>
              {current === "list" && (
                <div className="todo-split">
                  <div className="todo-split-list">
                    {nothing ? emptyList : <ByDay {...props} todayHeading={todayHeading} />}
                  </div>
                  {!phone && <TodayRail {...props} />}
                </div>
              )}
              {current === "board" && (nothing ? emptyList : <Board {...props} todayHeading={todayHeading} />)}
            </>}
        {done.length > 0 && current !== "week" && (
          <div className="todo-group todo-done">
            <button type="button" className="disclosure" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
              {t("todo.done")} <span className="count">{done.length}</span>
            </button>
            {showDone && (
              <ul>
                {done.map((todo) => (
                  <li key={todo.id} className="todo todo-line" data-done data-k={areas.find((area) => area.id === todo.area)?.k} onClick={() => setOpened(todo.id)}>
                    <Check todo={todo} today={today} onError={setError} />
                    <span className="todo-title">{todo.title}</span>
                    <span className="todo-when">{todo.completedAt ? `${md(iso(new Date(todo.completedAt)))} ${hhmm(todo.completedAt)}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {openedTodo && <TodoCard todo={openedTodo} today={today} all={todos} areas={areas} now={now} onClose={() => setOpened(null)} onError={setError} onSay={line && !openedTodo.source?.repeat ? () => say(openedTodo) : undefined} />}
    </section>
  );
}
