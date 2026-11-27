/** Reminders on the home node (docs/design/reminders.md §4): it looks at the calendar, the todos and the mail, asks
 * the core's `planReminders` what to tell now, and makes the notices; attention then takes them to wherever the user
 * is (a window, the Mac's figure, the phone).
 *
 * Like todo-sources.ts it is a place that knows several modules. None reads another's tables: each module's
 * snapshot is taken as a device would get it and handed to the core as plain data.
 *
 * It looks again every minute, at the moment the next thing comes up, and soon after anything it depends on changes.
 * While mail reminders are on, it also has the mail read every five minutes instead of every thirty.
 */
import {
  getSettings, mailRemindersOn, onEvents, planReminders, remindersTold, tellReminders,
  type ReminderEvent, type ReminderMail, type ReminderTodo, type World,
} from "@zirma/core";
import type { ZirmaModule } from "@zirma/module-kit";
import type { CalendarSnapshot } from "@zirma/module-calendar";
import type { MailSnapshot } from "@zirma/module-mail";
import { isDayOff, type TodoSnapshot } from "@zirma/module-todo";

const EVERY_MS = 60_000;
/** How often the mail is read while mail reminders are on. */
export const MAIL_EVERY_MS = 5 * 60_000;
/** What reminders depend on. Its own `reminder.due` is not among them. */
const NEWS = ["calendar.synced", "mail.synced", "mail.read", "settings.changed", "todo.added", "todo.updated", "todo.completed", "todo.deleted"];

export interface ReminderHome {
  world: World;
  modules: readonly ZirmaModule[];
  /** Has a module read its outside service now (passes.ts). */
  syncModule(id: string): Promise<void>;
}

/** The data `planReminders` needs, from the modules' snapshots. A module that is not there gives nothing. */
export function reminderData(world: World, modules: readonly ZirmaModule[]): { events: ReminderEvent[]; todos: ReminderTodo[]; mail: ReminderMail[] } {
  const snapshot = <T>(id: string): T | null => {
    const module = modules.find((candidate) => candidate.id === id);
    return module?.snapshot ? module.snapshot(world) as T : null;
  };
  const todo = snapshot<TodoSnapshot>("todo");
  const calendar = snapshot<CalendarSnapshot>("calendar");
  const mail = snapshot<MailSnapshot>("mail");
  const words = todo?.settings?.offWords;
  return {
    events: (calendar?.events ?? []).map((event) => ({
      id: event.id, title: event.title, allDay: event.allDay, start: event.start, location: event.location, meeting: event.meeting,
      response: event.response, dayOff: isDayOff(event, words),
    })),
    todos: (todo?.todos ?? []).map((item) => ({
      id: item.id, title: item.title, done: item.done, due: item.due, at: item.at, archivedAt: item.archivedAt, suggested: item.suggested,
      fromCalendar: item.source?.kind === "calendar", area: item.area,
    })),
    mail: (mail?.messages ?? []).map((message) => ({
      id: message.id, account: message.account, from: message.from, fromEmail: message.fromEmail, subject: message.subject, receivedAt: message.receivedAt,
      unread: message.unread, important: message.important, category: message.category, inInbox: message.inInbox,
    })),
  };
}

/** How long until the look for the next thing, or null when the minute's look comes first. Never a wait longer than
 * a minute: `setTimeout` cannot wait more than about 24 days (longer fires at once), and the calendar reaches months
 * ahead. */
export function nextLookIn(next: number | null, now: number): number | null {
  if (next === null) return null;
  const wait = Math.max(next - now, 0);
  return wait < EVERY_MS ? wait : null;
}

/** One look: tells what is due, takes back what went out of date, and says when to look next. */
export function remindNow(world: World, modules: readonly ZirmaModule[], now: number = Date.now()): { told: number; withdrawn: number; next: number | null } {
  const plan = planReminders({ now, settings: getSettings(world).reminders, ...reminderData(world, modules), told: remindersTold(world, now) });
  return { ...tellReminders(world, plan.batches, plan.current, now), next: plan.next };
}

export function watchReminders(home: ReminderHome, log?: (message: string) => void): () => void {
  const { world } = home;
  let timer: NodeJS.Timeout | null = null;
  let at: number | null = null;
  let looking = false;
  const look = () => {
    timer = null;
    at = null;
    if (!world.db.isOpen) return;
    looking = true;
    try {
      const done = remindNow(world, home.modules);
      if (done.told || done.withdrawn) log?.(`reminders: ${done.told} told${done.withdrawn ? `, ${done.withdrawn} out of date` : ""}`);
      // The next thing's moment, unless the minute's look comes first.
      const wait = nextLookIn(done.next, Date.now());
      if (wait !== null) soon(wait);
    } catch (error) {
      log?.(`reminders: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      looking = false;
    }
  };
  function soon(ms: number) {
    const when = Date.now() + ms;
    if (timer && at !== null && at <= when) return;
    if (timer) clearTimeout(timer);
    at = when;
    timer = setTimeout(look, ms);
    timer.unref();
  }
  // What this look writes itself is not news to it.
  const off = onEvents(world, (kinds) => { if (!looking && NEWS.some((kind) => kinds.has(kind))) soon(500); });
  soon(5000);
  const every = setInterval(() => soon(0), EVERY_MS);
  every.unref();
  const mail = setInterval(() => {
    if (!world.db.isOpen) return;
    try {
      if (mailRemindersOn(getSettings(world).reminders.mail)) home.syncModule("mail").catch((error) => log?.(`reminders: reading mail: ${error instanceof Error ? error.message : String(error)}`));
    } catch { /* closing */ }
  }, MAIL_EVERY_MS);
  mail.unref();
  return () => { off(); clearInterval(every); clearInterval(mail); if (timer) clearTimeout(timer); };
}
