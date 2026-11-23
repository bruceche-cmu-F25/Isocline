/** Reading Google Calendar: the anti-corruption layer between Google's events and the module's own. Google's rules stay
 * here: an all-day event's end date is exclusive, a timed one carries its own zone, cancelled ones are left out,
 * recurring ones come expanded. Adapted from Robin's extension/robin/google-calendar.ts.
 */
import { localDate, type GoogleSession } from "@alfred/module-kit";

const API = "https://www.googleapis.com/calendar/v3";
const MAX_PAGES = 4;

interface GoogleTime { date?: string; dateTime?: string }
export interface GoogleEvent {
  id?: string;
  etag?: string;
  status?: string;
  /** On one time of a repeating event: the id of the event that repeats. */
  recurringEventId?: string;
  summary?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
  start?: GoogleTime;
  end?: GoogleTime;
}

/** An event as the module stores it. */
export interface EventRow {
  id: string;
  calendarId: string;
  calendar: string;
  title: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startAt: number | null;
  endAt: number | null;
  location: string | null;
  link: string | null;
  meeting: string | null;
  organizer: string | null;
  response: string | null;
  attendees: number;
  /** Google's version of the event: a move is refused if it changed since. */
  etag: string | null;
  /** The user organizes it (only then can it be moved for everyone). */
  organizerSelf: boolean;
  /** `<calendar id>:<id of the repeating event>` when this is one time of an event that repeats. */
  recurring: string | null;
  /** Its description, as Google holds it (which may be HTML). */
  notes: string | null;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return localDate(new Date(y, m - 1, d + days));
}

const https = (value: string | undefined) => (value && /^https:\/\//.test(value) ? value : null);
const RESPONSES = new Set(["accepted", "declined", "tentative", "needsAction"]);

/** Null for what is not an event the user has: cancelled, or without a usable start. */
export function mapEvent(item: GoogleEvent, calendarId: string, calendar: string): EventRow | null {
  if (item.status === "cancelled" || !item.id) return null;
  const allDay = !!item.start?.date && !item.start?.dateTime;
  let startDate: string, endDate: string, startAt: number | null = null, endAt: number | null = null;
  if (allDay) {
    startDate = item.start!.date!;
    // Google's all-day end is the day after the last one.
    endDate = item.end?.date ? addDays(item.end.date, -1) : startDate;
  } else {
    startAt = Date.parse(item.start?.dateTime ?? "");
    if (Number.isNaN(startAt)) return null;
    const end = Date.parse(item.end?.dateTime ?? "");
    endAt = Number.isNaN(end) || end < startAt ? startAt : end;
    startDate = localDate(new Date(startAt));
    // An event that ends at midnight belongs to the day it ran on.
    endDate = localDate(new Date(Math.max(startAt, endAt - 1)));
  }
  if (endDate < startDate) endDate = startDate;
  const self = item.attendees?.find((attendee) => attendee.self)?.responseStatus;
  const meeting = https(item.hangoutLink) ?? https(item.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri);
  const organizer = item.organizer?.self ? null : item.organizer?.displayName?.trim() || item.organizer?.email?.trim() || null;
  return {
    id: `${calendarId}:${item.id}`.slice(0, 300), calendarId, calendar,
    title: item.summary?.trim().slice(0, 300) || "(no title)",
    allDay, startDate, endDate, startAt, endAt,
    location: item.location?.trim().slice(0, 300) || null,
    link: https(item.htmlLink), meeting, organizer: organizer?.slice(0, 200) ?? null,
    response: self && RESPONSES.has(self) ? self : null,
    attendees: item.attendees?.length ?? 0,
    etag: item.etag?.slice(0, 200) ?? null,
    organizerSelf: !!item.organizer?.self || (!item.organizer && !item.attendees?.length),
    recurring: item.recurringEventId ? `${calendarId}:${item.recurringEventId}`.slice(0, 300) : null,
    notes: item.description?.slice(0, 4000) || null,
  };
}

/** One account's calendars the user shows in Google (primary first) and their events from `from` to `to` (local
 * dates, inclusive). */
export async function readAccount(
  session: Pick<GoogleSession, "get">, from: string, to: string, signal?: AbortSignal,
): Promise<{ calendars: Array<{ id: string; name: string; writable: boolean }>; events: EventRow[] }> {
  const list = await session.get(`${API}/users/me/calendarList?${new URLSearchParams({ minAccessRole: "reader", maxResults: "100" })}`, signal);
  const calendars = ((list.items as Array<{ id?: string; summary?: string; summaryOverride?: string; primary?: boolean; selected?: boolean; hidden?: boolean; accessRole?: string }> | undefined) ?? [])
    .filter((item) => item.id && (item.primary || (item.selected && !item.hidden)))
    .sort((a, b) => Number(!!b.primary) - Number(!!a.primary))
    .map((item) => ({ id: item.id!, name: (item.summaryOverride || item.summary || item.id!).slice(0, 120), writable: item.accessRole === "owner" || item.accessRole === "writer" }));
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const window = {
    timeMin: new Date(fy, fm - 1, fd).toISOString(),
    timeMax: new Date(ty, tm - 1, td + 1).toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "250",
  };
  const events: EventRow[] = [];
  for (const calendar of calendars) {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ ...window, ...(pageToken ? { pageToken } : {}) });
      const body = await session.get(`${API}/calendars/${encodeURIComponent(calendar.id)}/events?${query}`, signal);
      for (const item of (body.items as GoogleEvent[] | undefined) ?? []) {
        const row = mapEvent(item, calendar.id, calendar.name);
        if (row) events.push(row);
      }
      pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
      if (!pageToken) break;
    }
  }
  return { calendars, events };
}
