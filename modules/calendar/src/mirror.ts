/** The mirror's own rows: one event written into it, the calendars of each account, and the colour each series of
 * events keeps. Both the read (index.ts, a whole account at a time) and the write (write.ts, the one event Google
 * has just answered with) put events here.
 */
import type { DatabaseSync } from "node:sqlite";
import type { World } from "@alfred/module-kit";
import type { EventRow } from "./google.ts";
import type { CalendarSource } from "./types.ts";

/** Colour slots, in order. A calendar the user only reads (holidays, a school's) is one colour, taken in this order.
 * In a calendar of their own, each series (events with the same title) has its own colour, so a week that is mostly
 * theirs is not all one colour. */
export const KS = ["blue", "green", "orange", "violet", "teal", "pink", "yellow"];
/** What makes events the same series: their title, however it is spaced or cased. */
export const seriesOf = (title: string) => title.trim().toLowerCase().replace(/\s+/g, " ") || "-";

/** Writes one event of `account` into the mirror, over what was there under its id. */
export function putEvent(db: DatabaseSync, account: string, event: EventRow): void {
  db.prepare(`INSERT OR REPLACE INTO calendar_events (account, id, calendar_id, calendar, title, all_day, start_date, end_date, start_at, end_at,
    location, link, meeting, organizer, response, attendees, etag, organizer_self, recurring, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(account, event.id, event.calendarId, event.calendar, event.title, event.allDay ? 1 : 0, event.startDate, event.endDate,
      event.startAt, event.endAt, event.location, event.link, event.meeting, event.organizer, event.response, event.attendees, event.etag, event.organizerSelf ? 1 : 0, event.recurring, event.notes);
}

export function calendarSources(world: World): CalendarSource[] {
  let next = 0;
  return world.db.prepare("SELECT * FROM calendar_sources ORDER BY account").all().map((row) => ({
    account: row.account as string,
    syncedAt: row.synced_at as string | null,
    error: row.error as string | null,
    reconnect: row.reconnect === 1,
    canWrite: row.can_write === 1,
    calendars: (JSON.parse(row.calendars as string) as Array<{ id: string; name: string; writable?: boolean }>)
      .map((calendar) => ({ id: calendar.id, name: calendar.name, writable: !!calendar.writable, varied: !!calendar.writable, k: KS[next++ % KS.length] })),
  }));
}

/** The colour an event called `title` has in this calendar: its series' own in one of the user's calendars (once it
 * has been given one), else the calendar's. */
export function colourOf(world: World, account: string, calendarId: string, title: string): string | undefined {
  const calendar = calendarSources(world).find((source) => source.account === account)?.calendars.find((candidate) => candidate.id === calendarId);
  const own = calendar?.varied ? world.db.prepare("SELECT k FROM calendar_colours WHERE account = ? AND series = ?").get(account, seriesOf(title))?.k as string | undefined : undefined;
  return own ?? calendar?.k;
}

/** Gives each series that has no colour yet the one that carries the fewest of this account's events (those of its
 * read-only calendars count too); the most frequent series choose first, so what is seen most is furthest apart.
 * `coming`: titles of events on their way to Google, coloured now so they do not change colour when they land. */
export function colourSeries(world: World, account: string, coming: readonly string[] = []): void {
  const calendars = calendarSources(world).find((source) => source.account === account)?.calendars ?? [];
  const own = new Set(calendars.filter((calendar) => calendar.varied).map((calendar) => calendar.id));
  if (!own.size) return;
  const known = new Map(world.db.prepare("SELECT series, k FROM calendar_colours WHERE account = ?").all(account).map((row) => [row.series as string, row.k as string]));
  const count = new Map<string, number>();
  const load = new Map(KS.map((k) => [k, 0]));
  const carry = (k: string | undefined, n: number) => { if (k && load.has(k)) load.set(k, load.get(k)! + n); };
  for (const row of world.db.prepare("SELECT calendar_id, title, count(*) AS n FROM calendar_events WHERE account = ? GROUP BY calendar_id, title").all(account)) {
    if (!own.has(row.calendar_id as string)) { carry(calendars.find((calendar) => calendar.id === row.calendar_id)?.k, row.n as number); continue; }
    const series = seriesOf(row.title as string);
    count.set(series, (count.get(series) ?? 0) + (row.n as number));
    carry(known.get(series), row.n as number);
  }
  for (const title of coming) if (!count.has(seriesOf(title))) count.set(seriesOf(title), 0);
  const insert = world.db.prepare("INSERT OR REPLACE INTO calendar_colours (account, series, k) VALUES (?, ?, ?)");
  const fresh = [...count.keys()].filter((series) => !known.has(series)).sort((a, b) => count.get(b)! - count.get(a)! || a.localeCompare(b));
  for (const series of fresh) {
    const k = KS.reduce((least, candidate) => (load.get(candidate)! < load.get(least)! ? candidate : least));
    carry(k, Math.max(1, count.get(series)!));
    insert.run(account, series, k);
  }
}
