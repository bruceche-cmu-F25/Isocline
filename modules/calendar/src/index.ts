/** The calendar module: the user's Google Calendar, mirrored for reading (docs/design/workspace-architecture.md W6).
 *
 * Google is the source of truth; Isocline keeps no second calendar. A sync every few minutes reads each connected
 * account's shown calendars, this month and the next (and a week on either side), and replaces that account's events here. Devices and
 * runs read the mirror, so a question about the schedule never waits on Google. Writing (moving a meeting, holding
 * time) is only ever proposed by a run; the user adds and changes events themselves on the calendar page. Either way
 * the change is delivered by write.ts, and what Google answers is written into the mirror at once.
 */
import { createHash } from "node:crypto";
import { localDate, recordDomainEvent, withDefaultActor, type World, defineModule, defineTool, ServiceError, Type, type ModuleServices } from "@isocline/module-kit";
import { addDays, readAccount } from "./google.ts";
import { calendarSources, colourSeries, putEvent, seriesOf } from "./mirror.ts";
import { calendarOps, calendarQueries, calendarWriteTools, deliverCalendar, pendingChanges } from "./write.ts";
import type { CalendarEvent, CalendarSnapshot } from "./types.ts";

export type { CalendarEvent, CalendarPending, CalendarSnapshot, CalendarSource, CalendarWhen } from "./types.ts";
export { calendarSources } from "./mirror.ts";
export { mapEvent, addDays, type GoogleEvent } from "./google.ts";
export { deliverCalendar, newEventId, type AddInput, type DeleteInput, type EditInput, type MoveInput, type RespondInput } from "./write.ts";

/** The days the mirror holds: this month and the next, whole, with a week before and after (the days a month's page
 * shows of its neighbours). So the month the user is in is all there, and never less than a week back. */
export function mirrorWindow(today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number);
  return { from: addDays(`${today.slice(0, 8)}01`, -7), to: addDays(localDate(new Date(y, m + 1, 0)), 7) };
}
const MIGRATIONS = [{
  id: "calendar:1",
  sql: `
CREATE TABLE calendar_events (
  account TEXT NOT NULL CHECK (length(account) BETWEEN 1 AND 320),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 300),
  calendar_id TEXT NOT NULL,
  calendar TEXT NOT NULL,
  title TEXT NOT NULL,
  all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  start_at INTEGER,
  end_at INTEGER,
  location TEXT,
  link TEXT,
  meeting TEXT,
  organizer TEXT,
  response TEXT,
  attendees INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account, id)
) STRICT;
CREATE INDEX calendar_events_day ON calendar_events(start_date, start_at);
CREATE TABLE calendar_sources (
  account TEXT PRIMARY KEY NOT NULL,
  synced_at TEXT,
  error TEXT,
  reconnect INTEGER NOT NULL DEFAULT 0 CHECK (reconnect IN (0, 1)),
  calendars TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(calendars)),
  digest TEXT
) STRICT;
`,
}, {
  // For writing (write.ts): each event's version and whether the user organizes it; whether an account may write.
  id: "calendar:2",
  sql: `
ALTER TABLE calendar_events ADD COLUMN etag TEXT;
ALTER TABLE calendar_events ADD COLUMN organizer_self INTEGER NOT NULL DEFAULT 0 CHECK (organizer_self IN (0, 1));
ALTER TABLE calendar_sources ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0 CHECK (can_write IN (0, 1));
UPDATE calendar_sources SET digest = NULL;
`,
}, {
  // The colour of each series in the user's own calendars: kept, so a series does not change colour between syncs.
  id: "calendar:3",
  sql: `
CREATE TABLE calendar_colours (
  account TEXT NOT NULL,
  series TEXT NOT NULL CHECK (length(series) BETWEEN 1 AND 300),
  k TEXT NOT NULL,
  PRIMARY KEY (account, series)
) STRICT;
UPDATE calendar_sources SET digest = NULL;
`,
}, {
  // Which repeating event an event is one time of (the todo list keeps one todo for a weekly one, not one a time).
  id: "calendar:4",
  sql: `
ALTER TABLE calendar_events ADD COLUMN recurring TEXT;
UPDATE calendar_sources SET digest = NULL;
`,
}, {
  // An event's description, for changing it on the calendar page (kept out of the snapshot: read when one is opened).
  id: "calendar:5",
  sql: `
ALTER TABLE calendar_events ADD COLUMN notes TEXT;
UPDATE calendar_sources SET digest = NULL;
`,
}, {
  // Earlier versions could send an undo while its add was retrying. If it already ran, repeat the
  // idempotent delete after the add's last attempt. Match the account and calendar as well as the event.
  id: "calendar:6",
  sql: `
UPDATE core_outbound AS undo SET after_id = creation.id,
  state = 'queued', attempts = 0, error = NULL, result = NULL
FROM core_outbound AS creation
WHERE undo.module = 'calendar' AND undo.action = 'delete' AND undo.state IN ('queued', 'sending', 'done')
  AND creation.module = 'calendar' AND creation.action = 'add' AND creation.state IN ('queued', 'sending')
  AND creation.rowid < undo.rowid
  AND json_extract(creation.payload, '$.account') = json_extract(undo.payload, '$.account')
  AND json_extract(creation.payload, '$.calendarId') = json_extract(undo.payload, '$.calendarId')
  AND json_extract(creation.payload, '$.eventId') = json_extract(undo.payload, '$.eventId');
`,
}];

const canRead = (capabilities: readonly string[]) => capabilities.includes("calRead") || capabilities.includes("calWrite");

/** Reads every connected account; one that fails keeps its last events and says why (and, unless it needs
 * reconnecting, asks for a retry soon). Records `calendar.synced` only
 * when something changed, so devices refresh without the log filling up every few minutes. */
export async function syncCalendar(world: World, services: ModuleServices, signal?: AbortSignal, now: number = Date.now()): Promise<{ retrySoon: boolean } | void> {
  const google = services.google;
  const readable = (google?.accounts() ?? []).filter((account) => canRead(account.capabilities));
  const accounts = readable.map((account) => account.email);
  const writes = new Set(readable.filter((account) => account.capabilities.includes("calWrite")).map((account) => account.email));
  const today = localDate(new Date(now));
  withDefaultActor("system", () => world.tx((db) => {
    const gone = db.prepare("SELECT account FROM calendar_sources").all().map((row) => row.account as string).filter((account) => !accounts.includes(account));
    for (const account of gone) {
      db.prepare("DELETE FROM calendar_events WHERE account = ?").run(account);
      db.prepare("DELETE FROM calendar_sources WHERE account = ?").run(account);
      db.prepare("DELETE FROM calendar_colours WHERE account = ?").run(account);
      recordDomainEvent(world, { kind: "calendar.synced", subject: `calendar:${account}`, payload: { removed: true } });
    }
  }));
  let retrySoon = false;
  for (const account of accounts) {
    if (signal?.aborted) return;
    let result: Awaited<ReturnType<typeof readAccount>> | null = null;
    let failure: { error: string; reconnect: boolean } | null = null;
    try {
      const session = await google!.session(account);
      const window = mirrorWindow(today);
      result = await readAccount(session, window.from, window.to, signal);
    } catch (error) {
      if (signal?.aborted) return;
      failure = { error: (error as Error).message.slice(0, 300), reconnect: error instanceof ServiceError && error.code === "reconnect" };
      if (!failure.reconnect) retrySoon = true;
    }
    withDefaultActor("system", () => world.tx((db) => {
      const before = db.prepare("SELECT digest, error FROM calendar_sources WHERE account = ?").get(account);
      if (failure) {
        db.prepare(`INSERT INTO calendar_sources (account, error, reconnect, can_write) VALUES (?, ?, ?, ?)
          ON CONFLICT(account) DO UPDATE SET error = excluded.error, reconnect = excluded.reconnect, can_write = excluded.can_write`).run(account, failure.error, failure.reconnect ? 1 : 0, writes.has(account) ? 1 : 0);
        if (before?.error !== failure.error) recordDomainEvent(world, { kind: "calendar.synced", subject: `calendar:${account}`, payload: { error: failure.error } });
        return;
      }
      const digest = createHash("sha256").update(JSON.stringify(result!)).digest("hex");
      db.prepare(`INSERT INTO calendar_sources (account, synced_at, error, reconnect, calendars, digest, can_write) VALUES (?, ?, NULL, 0, ?, ?, ?)
        ON CONFLICT(account) DO UPDATE SET synced_at = excluded.synced_at, error = NULL, reconnect = 0, calendars = excluded.calendars, digest = excluded.digest, can_write = excluded.can_write`)
        .run(account, new Date(now).toISOString(), JSON.stringify(result!.calendars), digest, writes.has(account) ? 1 : 0);
      if (before?.digest === digest && !before?.error) return;
      db.prepare("DELETE FROM calendar_events WHERE account = ?").run(account);
      for (const event of result!.events) putEvent(db, account, event);
      colourSeries(world, account);
      recordDomainEvent(world, { kind: "calendar.synced", subject: `calendar:${account}`, payload: { events: result!.events.length } });
    }));
  }
  return { retrySoon };
}

/** Events touching the days from `from` to `to` (inclusive), by start. */
export function listEvents(world: World, from: string, to: string): CalendarEvent[] {
  const sources = calendarSources(world);
  const colour = new Map(sources.flatMap((source) => source.calendars.map((calendar) => [`${source.account}|${calendar.id}`, calendar.k] as const)));
  const varied = new Set(sources.flatMap((source) => source.calendars.filter((calendar) => calendar.varied).map((calendar) => `${source.account}|${calendar.id}`)));
  const series = new Map(world.db.prepare("SELECT account, series, k FROM calendar_colours").all().map((row) => [`${row.account as string}|${row.series as string}`, row.k as string]));
  const writable = new Set(sources.flatMap((source) => source.canWrite ? source.calendars.filter((calendar) => calendar.writable).map((calendar) => `${source.account}|${calendar.id}`) : []));
  return world.db.prepare(`SELECT * FROM calendar_events WHERE end_date >= ? AND start_date <= ?
    ORDER BY start_date, all_day DESC, start_at, title`).all(from, to).map((row) => ({
    id: row.id as string, account: row.account as string, calendarId: row.calendar_id as string, calendar: row.calendar as string,
    title: row.title as string, allDay: row.all_day === 1, startDate: row.start_date as string, endDate: row.end_date as string,
    ...(row.start_at !== null ? { start: new Date(row.start_at as number).toISOString(), end: new Date(row.end_at as number).toISOString() } : {}),
    ...(row.location ? { location: row.location as string } : {}),
    ...(row.link ? { link: row.link as string } : {}),
    ...(row.meeting ? { meeting: row.meeting as string } : {}),
    ...(row.organizer ? { organizer: row.organizer as string } : {}),
    ...(row.response ? { response: row.response as CalendarEvent["response"] } : {}),
    attendees: row.attendees as number,
    k: (varied.has(`${row.account as string}|${row.calendar_id as string}`) ? series.get(`${row.account as string}|${seriesOf(row.title as string)}`) : undefined)
      ?? colour.get(`${row.account as string}|${row.calendar_id as string}`) ?? "gray",
    editable: row.organizer_self === 1 && writable.has(`${row.account as string}|${row.calendar_id as string}`),
    invited: !!row.response && row.organizer_self !== 1 && writable.has(`${row.account as string}|${row.calendar_id as string}`),
    ...(row.recurring ? { recurring: row.recurring as string } : {}),
  }));
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hhmm = (iso: string) => { const date = new Date(iso); return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; };

/** The schedule as a run reads it: day by day, with what could not be read. */
export function describeEvents(world: World, from: string, to: string): string {
  const sources = calendarSources(world);
  if (!sources.length) return "The user's calendar is not connected. They can connect Google (calendar) in Settings.";
  const events = listEvents(world, from, to);
  const lines: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const [y, m, d] = day.split("-").map(Number);
    const todays = events.filter((event) => event.startDate <= day && event.endDate >= day);
    lines.push(`${DAY[new Date(y, m - 1, d).getDay()]} ${day}${todays.length ? "" : ": nothing"}`);
    for (const event of todays) {
      const when = event.allDay || !event.start ? "all day" : `${event.startDate === day ? hhmm(event.start) : "…"}–${event.endDate === day ? hhmm(event.end!) : "…"}`;
      const extra = [event.location, event.response === "declined" ? "declined" : event.response === "needsAction" ? "not answered" : null, sources.length > 1 || sources[0].calendars.length > 1 ? event.calendar : null]
        .filter(Boolean).join("; ");
      lines.push(`  ${when} ${event.title}${extra ? ` (${extra})` : ""} [${event.id}]`);
    }
  }
  const notes = sources.map((source) => source.error ? `Could not read ${source.account} just now (${source.error}); this may be out of date.` : null).filter(Boolean);
  const synced = sources.map((source) => source.syncedAt).filter(Boolean).sort().at(-1);
  return [...lines, ...(synced ? [`(Read from Google at ${hhmm(synced!)}.)`] : []), ...notes].join("\n");
}

const Day = (description: string) => Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", description }));

export const calendarModule = defineModule({
  id: "calendar",
  title: "Calendar",
  migrations: MIGRATIONS,
  ops: calendarOps,
  queries: calendarQueries,
  tools: [
    defineTool({
      name: "calendar_list",
      label: "Calendar",
      description: "The user's schedule from their Google Calendar, day by day: times, titles, places, invitations they declined or have not answered, and each event's id in brackets (for calendar_move and calendar_respond). Use it for questions about their day, free time, or what is coming up.",
      level: "read",
      parameters: Type.Object({
        from: Day("First day, YYYY-MM-DD; today if left out"),
        to: Day("Last day, YYYY-MM-DD, at most 35 days after from; a week from `from` if left out"),
      }),
      describe: (_world, params) => [params.from, params.to].filter(Boolean).join(" – "),
      execute(world, params) {
        const from = params.from ?? localDate();
        let to = params.to ?? addDays(from, 6);
        if (to < from) to = from;
        if (to > addDays(from, 35)) to = addDays(from, 35);
        return describeEvents(world, from, to);
      },
    }),
    ...calendarWriteTools,
  ],
  views: [{ id: "week", title: "Calendar" }],
  guidance: [
    "Calendar: the user's Google Calendar is mirrored here and refreshed every few minutes; calendar_list reads it.",
    "To add an event or hold time, move an event the user organizes, or answer an invitation, propose it (calendar_add, calendar_move, calendar_respond inside `propose`): nothing changes in their calendar until they accept.",
    "There is no tool to cancel or delete an event: say so, and that they can delete one they organize on the Calendar page here (open it with show_view); for someone else's meeting, propose declining it.",
    "Propose straight away from what they said, without asking first: an event with no end is one hour unless its kind suggests otherwise (an exam is two or three), a part of the day with no hour (\"afternoon\") is a hold over that part, and times are the user's local time. Say what you assumed in the summary; they change it there.",
  ].join(" "),
  snapshot(world): CalendarSnapshot {
    const today = localDate();
    const { from, to } = mirrorWindow(today);
    return { today, from, to, events: listEvents(world, from, to), pending: pendingChanges(world), sources: calendarSources(world) };
  },
  sync: { everyMs: 5 * 60_000, run: syncCalendar },
  deliver: deliverCalendar,
});
