/** Reminders: which events, todos and mail Zirma should mention now, on its own (docs/design/reminders.md).
 *
 * One decision, made here and nowhere else, like attention.ts: given the calendar, the todos, the mail, the user's
 * reminder settings, what was already told and the time, it says what to tell now and when to look again. It is
 * pure: the home node (server reminders.ts) gathers the data from the modules' snapshots and turns what this says
 * into notices, which then go wherever attention says.
 *
 * Each thing is told once. Its name (`key`) carries what it is told about: an event's start, a todo's hour. So a
 * second pass, a restart or a second sync stays quiet, and an event moved to another time is told again at the new
 * time.
 */
import type { ReminderSettings } from "./settings.ts";

/** An event as reminders need it (from the calendar module's snapshot). */
export interface ReminderEvent {
  id: string;
  title: string;
  allDay: boolean;
  /** ISO instant; absent for whole days. */
  start?: string;
  location?: string;
  /** A video call link. */
  meeting?: string;
  response?: "accepted" | "declined" | "tentative" | "needsAction";
  /** A day off by the user's own words (the todo module's `isDayOff`): not a meeting to be told about. */
  dayOff: boolean;
}

/** A todo as reminders need it (from the todo module's snapshot). */
export interface ReminderTodo {
  id: string;
  title: string;
  done: boolean;
  /** Local date (YYYY-MM-DD) and hour (HH:MM) it is due by, on the home node's clock. */
  due?: string;
  at?: string;
  archivedAt?: string;
  /** Zirma's suggestion, not yet the user's. */
  suggested?: boolean;
  /** Made from a calendar event: the event is told instead. */
  fromCalendar: boolean;
  area?: string;
}

/** A message as reminders need it (from the mail module's snapshot). */
export interface ReminderMail {
  id: string;
  /** The mailbox it came to (a message is opened by account and id). */
  account: string;
  from: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  unread: boolean;
  important: boolean;
  category: string;
  inInbox?: boolean;
}

export interface ReminderItem {
  source: "event" | "todo" | "mail";
  id: string;
  title: string;
  /** When it happens (an event's start, a todo's hour) or when the mail came. ISO. */
  at: string;
  location?: string;
  meeting?: boolean;
  from?: string;
  /** A message's mailbox. */
  account?: string;
  area?: string;
}

/** What one notice says: things of one kind, due in the same minute (or mail read in the same pass). */
export interface ReminderBatch {
  /** Each thing's name, so it is never told twice. */
  keys: string[];
  items: ReminderItem[];
  /** After this nobody needs to hear it: the event has started, the hour has come, the mail is an hour old. */
  expiresAt: number;
}

export interface ReminderPlan {
  /** To tell now, soonest first. */
  batches: ReminderBatch[];
  /** Every thing whose time to be told is now, told or not. A reminder not yet delivered about none of these is
   * out of date (the event moved, the todo was finished): it is withdrawn. */
  current: Set<string>;
  /** When the next thing comes up to be told, if anything does; the home node looks again then. */
  next: number | null;
}

/** New mail is told while it is this fresh. */
export const MAIL_FRESH_MS = 60 * 60_000;

/** The categories whose mail is told only when its sender is on the user's list. */
const QUIET_CATEGORIES = new Set(["promotions", "social", "updates", "forums"]);

/** A local date and hour on the home node's clock, as an instant. */
export function localInstant(date: string, hour: string): number {
  return new Date(`${date}T${hour}:00`).getTime();
}

export const eventKey = (event: { id: string; start?: string }) => `event:${event.id}@${event.start}`;
export const todoKey = (todo: { id: string; due?: string; at?: string }) => `todo:${todo.id}@${todo.due}T${todo.at}`;
export const mailKey = (message: { id: string }) => `mail:${message.id}`;

interface Candidate { key: string; item: ReminderItem; when: number; from: number }

export function planReminders(input: {
  now: number;
  settings: ReminderSettings;
  events: readonly ReminderEvent[];
  todos: readonly ReminderTodo[];
  mail: readonly ReminderMail[];
  /** Keys already told (or being told). */
  told: ReadonlySet<string>;
}): ReminderPlan {
  const { now, settings, told } = input;
  const timed: Candidate[] = [];

  if (settings.events.on) {
    const before = settings.events.beforeMin * 60_000;
    for (const event of input.events) {
      if (event.allDay || !event.start || event.dayOff || event.response === "declined") continue;
      const when = Date.parse(event.start);
      if (Number.isNaN(when)) continue;
      timed.push({
        key: eventKey(event), when, from: when - before,
        item: { source: "event", id: event.id, title: event.title, at: new Date(when).toISOString(), ...(event.location ? { location: event.location } : {}), ...(event.meeting ? { meeting: true } : {}) },
      });
    }
  }
  if (settings.todos.on) {
    const before = settings.todos.beforeMin * 60_000;
    for (const todo of input.todos) {
      if (todo.done || todo.archivedAt || todo.suggested || todo.fromCalendar || !todo.due || !todo.at) continue;
      const when = localInstant(todo.due, todo.at);
      if (Number.isNaN(when)) continue;
      timed.push({
        key: todoKey(todo), when, from: when - before,
        item: { source: "todo", id: todo.id, title: todo.title, at: new Date(when).toISOString(), ...(todo.area ? { area: todo.area } : {}) },
      });
    }
  }

  const current = new Set<string>();
  let next: number | null = null;
  const due: Candidate[] = [];
  for (const candidate of timed) {
    // Its time has come (or it came in late, but before it happens); it has not happened yet.
    if (candidate.from <= now && now < candidate.when) {
      current.add(candidate.key);
      if (!told.has(candidate.key)) due.push(candidate);
    } else if (candidate.from > now && !told.has(candidate.key)) {
      next = next === null ? candidate.from : Math.min(next, candidate.from);
    }
  }

  // Things of one kind due in the same minute are told together.
  const groups = new Map<string, Candidate[]>();
  for (const candidate of due.sort((a, b) => a.when - b.when || a.item.title.localeCompare(b.item.title))) {
    const group = `${candidate.item.source}@${Math.floor(candidate.when / 60_000)}`;
    groups.set(group, [...(groups.get(group) ?? []), candidate]);
  }
  const batches: ReminderBatch[] = [...groups.values()].map((group) => ({
    keys: group.map((candidate) => candidate.key), items: group.map((candidate) => candidate.item), expiresAt: group[0].when,
  }));

  const mail = settings.mail;
  const senders = new Set(mail.senders.map((sender) => sender.toLowerCase()));
  if (senders.size || mail.important) {
    const since = Math.max(mail.since ? Date.parse(mail.since) : now, now - MAIL_FRESH_MS);
    const fresh: Array<{ key: string; item: ReminderItem; came: number }> = [];
    for (const message of input.mail) {
      const came = Date.parse(message.receivedAt);
      if (Number.isNaN(came) || came < since || came > now + 60_000 || !message.unread || message.inInbox === false) continue;
      // A sender the user named is told whatever Gmail filed it under; otherwise only important mail in the main inbox.
      const listed = senders.has(message.fromEmail.toLowerCase());
      if (!listed && !(mail.important && message.important && !QUIET_CATEGORIES.has(message.category))) continue;
      const key = mailKey(message);
      current.add(key);
      if (told.has(key)) continue;
      fresh.push({ key, came, item: { source: "mail", id: message.id, title: message.subject, from: message.from, account: message.account, at: new Date(came).toISOString() } });
    }
    if (fresh.length) {
      fresh.sort((a, b) => a.came - b.came);
      batches.push({ keys: fresh.map((one) => one.key), items: fresh.map((one) => one.item), expiresAt: Math.max(...fresh.map((one) => one.came)) + MAIL_FRESH_MS });
    }
  }

  return { batches: batches.sort((a, b) => a.expiresAt - b.expiresAt), current, next };
}
